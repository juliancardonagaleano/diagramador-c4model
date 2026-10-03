import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, relative, sep } from 'node:path';
import { CliError } from '../io';
import { IgnoreMatcher } from './gitignore';
import { redactSecrets } from './redact';
import { CATEGORY_LABEL, CATEGORY_SHARE, classify, extensionOf, isEnvExample, isExcludedDir, isSecretDir, isTestPath, nonTextKind, secretReason, sniffYaml, type Classification, type RepoCategory } from './rules';
import { componentPaths, countCode, renderLanguages, renderTree, type SeenFile } from './tree';

/**
 * Escáner de un repositorio local: recorre una carpeta y devuelve un RESUMEN acotado (árbol, lenguajes, componentes y el
 * contenido recortado de los archivos que revelan la arquitectura) listo para enviar a un modelo. Es lo que lee `generate
 * --from-repo`; vive en el CLI porque el núcleo no toca el sistema de archivos.
 *
 * Principios (la privacidad es parte del diseño):
 *  - Solo lee: no ejecuta `git` ni nada del repositorio, no sigue enlaces simbólicos y no sale de la carpeta.
 *  - Lo que se llama como un secreto (`.env`, claves, `*.tfstate`…) no se abre jamás; el resto del texto que sale pasa por
 *    `redactSecrets`, ANTES de recortarlo (un secreto cortado por la mitad no se reconocería).
 *  - Topes duros de archivos, de bytes por archivo y de presupuesto total (por defecto 60 KB).
 */

export const DEFAULT_BUDGET_BYTES = 60 * 1024;
export const MAX_BUDGET_BYTES = 1024 * 1024;

/** Archivos que se abren como mucho para leerlos (más grandes se omiten sin leerlos). */
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_ENTRIES = 20000;
const MAX_DEPTH = 24;
/** Entradas que se guardan en la lista de omitidos (el resto solo se cuenta). */
const MAX_OMITTED_LISTED = 400;
/** Menos bytes que estos de un archivo no merece la pena enviarlos. */
const MIN_USEFUL = 400;
/** Una línea más larga que esto indica código minificado o generado. */
const MAX_LINE_CHARS = 8000;
const MAX_YAML_SNIFF = 300;
const MAX_GITIGNORE_BYTES = 256 * 1024;

export type OmitReason = 'secreto' | 'ignorado' | 'excluida' | 'binario' | 'imagen' | 'lockfile' | 'grande' | 'generado' | 'presupuesto' | 'tope' | 'enlace' | 'ilegible';

export const OMIT_LABEL: Record<OmitReason, string> = {
  secreto: 'secreto (nunca se lee)',
  ignorado: 'ignorado por .gitignore',
  excluida: 'carpeta excluida (dependencias, compilación, cachés)',
  binario: 'binario o minificado',
  imagen: 'imagen',
  lockfile: 'lockfile',
  grande: 'demasiado grande',
  generado: 'generado o minificado',
  presupuesto: 'fuera del presupuesto',
  tope: 'tope de archivos o de recorrido',
  enlace: 'enlace simbólico (no se siguen)',
  ilegible: 'no se pudo leer',
};

export interface ScanOptions {
  /** Presupuesto del resumen en bytes (por defecto 60 KB). */
  budgetBytes?: number;
  /** Máximo de archivos con contenido (por defecto 120). */
  maxFiles?: number;
  /** Profundidad del árbol de carpetas (por defecto 3). */
  treeDepth?: number;
  /** Máximo de entradas (archivos y carpetas) que se recorren (por defecto 20 000). */
  maxEntries?: number;
  /**
   * La carpeta es un clon temporal de un repositorio remoto (`--from-repo <url>`): el resumen lleva el nombre del repositorio
   * (no el del directorio temporal), los errores no nombran la ruta temporal y no se aplican los `.gitignore`: un clon solo trae
   * lo versionado (no hay nada que ignorar) y son texto de un tercero, así que no se gasta ni un ciclo en interpretarlos. El
   * intérprete (`gitignore.ts`) no usa regex con retroceso, de modo que no es una cuestión de seguridad sino de prudencia.
   */
  remote?: { name: string };
}

export interface DigestFile {
  path: string;
  category: RepoCategory;
  /** Bytes del contenido enviado. */
  bytes: number;
  /** Tamaño original del archivo. */
  originalBytes: number;
  truncated: boolean;
  /** Valores redactados en este archivo. */
  redactions: number;
  /** Nota (p. ej. «solo los nombres de las variables»). */
  note?: string;
}

export interface OmittedEntry {
  /** Ruta relativa; termina en `/` si es una carpeta que no se recorrió. */
  path: string;
  reason: OmitReason;
  detail?: string;
}

export interface RepoDigest {
  /** Nombre de la carpeta analizada (no su ruta absoluta: no se envían rutas del equipo del usuario). */
  name: string;
  /** `true` si se leyó un clon temporal de un repositorio remoto (`--from-repo <url>`). */
  remote?: true;
  /** El resumen, listo para enviar. */
  text: string;
  /** Bytes del resumen. */
  bytes: number;
  budget: number;
  included: DigestFile[];
  omitted: OmittedEntry[];
  /** Cuántos archivos o carpetas se omitieron por cada motivo (la lista `omitted` está acotada; esto no). */
  omittedCounts: Partial<Record<OmitReason, number>>;
  /** Entradas omitidas que no caben en la lista `omitted`. */
  omittedUnlisted: number;
  /** Valores sustituidos por `[REDACTADO]` en todo lo incluido. */
  redactions: number;
  /** Archivos de texto vistos y carpetas recorridas. */
  filesSeen: number;
  dirsSeen: number;
  /** `true` si el recorrido se cortó por el tope de entradas (repositorio enorme). */
  walkTruncated: boolean;
}

/** Acumula lo que se deja fuera, con una lista acotada y contadores exactos. */
class Omissions {
  readonly list: OmittedEntry[] = [];
  readonly counts: Partial<Record<OmitReason, number>> = {};
  unlisted = 0;
  add(path: string, reason: OmitReason, detail?: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    if (this.list.length < MAX_OMITTED_LISTED) this.list.push({ path, reason, ...(detail ? { detail } : {}) });
    else this.unlisted += 1;
  }
}

const CONTROL_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const CONTROL_NAME_ALL = new RegExp(CONTROL_NAME.source, 'g');
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const toPosix = (p: string): string => p.split(sep).join('/');

function homeDirectory(): string | undefined {
  try {
    return realpathSync(homedir());
  } catch {
    return undefined;
  }
}

/** Sube desde la carpeta hasta encontrar la raíz del repositorio git (`.git`), sin pasar de unos cuantos niveles. */
function findGitTop(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function readIgnoreFile(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_GITIGNORE_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

interface WalkResult {
  files: SeenFile[];
  dirs: number;
  truncated: boolean;
}

function walkRepo(root: string, omit: Omissions, maxEntries: number, useGitignore: boolean): WalkResult {
  const matcher = new IgnoreMatcher();
  const top = useGitignore ? findGitTop(root) : undefined;
  const prefix = top ? toPosix(relative(top, root)) : '';
  // Reglas de las carpetas por encima de la analizada (si es una subcarpeta de un repositorio) y `.git/info/exclude`.
  if (top) {
    const exclude = readIgnoreFile(join(top, '.git', 'info', 'exclude'));
    if (exclude) matcher.add(exclude, '');
    const above = prefix ? prefix.split('/') : [];
    for (let i = 0; i < above.length; i += 1) {
      const base = above.slice(0, i).join('/');
      const content = readIgnoreFile(join(top, ...above.slice(0, i), '.gitignore'));
      if (content) matcher.add(content, base);
    }
  }
  const gitPath = (rel: string): string => (prefix ? `${prefix}/${rel}` : rel);

  const files: SeenFile[] = [];
  let dirs = 0;
  let entries = 0;
  let truncated = false;

  const visit = (absDir: string, relDir: string, depth: number): void => {
    let list;
    try {
      list = readdirSync(absDir, { withFileTypes: true });
    } catch {
      omit.add(`${relDir || '.'}/`, 'ilegible');
      return;
    }
    list.sort(byName);
    const own = useGitignore && list.some((e) => e.name === '.gitignore' && e.isFile()) ? readIgnoreFile(join(absDir, '.gitignore')) : undefined;
    if (own) matcher.add(own, gitPath(relDir));
    for (const entry of list) {
      if (entries >= maxEntries) {
        truncated = true;
        return;
      }
      entries += 1;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (CONTROL_NAME.test(entry.name)) {
        // Un nombre con caracteres de control (secuencias de escape de terminal, saltos de línea…) no se muestra ni se envía tal cual.
        omit.add(rel.replace(CONTROL_NAME_ALL, '�'), 'ilegible', 'nombre con caracteres de control');
      } else if (entry.isSymbolicLink()) {
        omit.add(rel, 'enlace');
      } else if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) omit.add(`${rel}/`, 'excluida');
        else if (isSecretDir(entry.name)) omit.add(`${rel}/`, 'secreto', `carpeta de credenciales (${entry.name}/)`);
        else if (matcher.ignores(gitPath(rel), true)) omit.add(`${rel}/`, 'ignorado');
        else if (depth >= MAX_DEPTH) omit.add(`${rel}/`, 'tope', 'demasiado profunda');
        else {
          dirs += 1;
          visit(join(absDir, entry.name), rel, depth + 1);
        }
      } else if (entry.isFile()) {
        const secret = secretReason(rel);
        if (secret) omit.add(rel, 'secreto', secret);
        else if (entry.name === '.git') omit.add(rel, 'excluida');
        else if (matcher.ignores(gitPath(rel), false)) omit.add(rel, 'ignorado');
        else {
          const kind = nonTextKind(entry.name);
          if (kind) omit.add(rel, kind);
          else {
            try {
              files.push({ rel, size: lstatSync(join(absDir, entry.name)).size });
            } catch {
              omit.add(rel, 'ilegible');
            }
          }
        }
      }
      // Sockets, tuberías y demás: se ignoran sin más.
    }
  };
  visit(root, '', 0);
  return { files, dirs, truncated };
}

/** Lee como mucho `limit` bytes de un archivo normal; no sigue enlaces (O_NOFOLLOW donde exista). */
function readHead(file: string, limit: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Recorta por bytes (UTF-8) sin partir un carácter ni, si se puede, una línea. */
function fitText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = Buffer.from(text).subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/�+$/, '');
  const lastLine = cut.lastIndexOf('\n');
  if (lastLine > cut.length * 0.7) cut = cut.slice(0, lastLine);
  return cut;
}

/** Como `fitText`, pero avisando al modelo de que la lista está incompleta. */
function fitWithMark(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `${fitText(text, Math.max(0, maxBytes - 40))}\n[… recortado por el presupuesto]`;
}

/** Nombres de variables de un `.env.example`: ni valores ni comentarios (un ejemplo a veces trae valores reales). */
function envNames(text: string): string {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names.join('\n');
}

/** Quita de un YAML de varios documentos los de `kind: Secret` (sus valores son base64, no un patrón reconocible). */
function dropSecretDocuments(text: string): { text: string; dropped: number } {
  if (!/^kind:\s*["']?(?:Secret|SealedSecret)["']?\s*$/m.test(text)) return { text, dropped: 0 };
  const docs = text.split(/^---[ \t]*$/m);
  let dropped = 0;
  const kept = docs.filter((doc) => {
    const isSecret = /^kind:\s*["']?(?:Secret|SealedSecret)["']?\s*$/m.test(doc);
    if (isSecret) dropped += 1;
    return !isSecret;
  });
  const note = dropped ? `\n# [${dropped} documento(s) de tipo Secret omitido(s)]\n` : '';
  return { text: kept.join('---') + note, dropped };
}

interface Loaded {
  text: string;
  originalBytes: number;
  truncated: boolean;
  redactions: number;
  note?: string;
}

type LoadOutcome = { ok: true; loaded: Loaded } | { ok: false; reason: OmitReason; detail?: string };

/** Abre un archivo clave y prepara su texto: sin documentos Secret, redactado y recortado al tope de su categoría. */
function loadFile(root: string, file: SeenFile, cls: Classification): LoadOutcome {
  if (file.size > MAX_READ_BYTES) return { ok: false, reason: 'grande', detail: `${(file.size / 1024).toFixed(0)} KB` };
  const limit = Math.min(file.size, cls.cap * 2 + 4096);
  const head = readHead(join(root, ...file.rel.split('/')), limit);
  if (!head) return { ok: false, reason: 'ilegible' };
  if (head.length === 0) return { ok: false, reason: 'ilegible', detail: 'vacío' };
  if (head.subarray(0, 8000).includes(0)) return { ok: false, reason: 'binario' };
  let text = head.toString('utf8');
  if (text.split('\n').some((line) => line.length > MAX_LINE_CHARS)) return { ok: false, reason: 'generado', detail: 'líneas de más de 8000 caracteres' };

  const name = file.rel.slice(file.rel.lastIndexOf('/') + 1);
  let note: string | undefined;
  if (isEnvExample(name)) {
    text = envNames(text);
    note = 'solo los nombres de las variables; los valores no se envían';
  } else if (['yaml', 'yml'].includes(extensionOf(name))) {
    const dropped = dropSecretDocuments(text);
    if (dropped.dropped > 0 && dropped.text.replace(/^#.*$/gm, '').replace(/---/g, '').trim() === '') return { ok: false, reason: 'secreto', detail: 'solo contiene documentos Secret' };
    text = dropped.text;
  }
  // La redacción va ANTES de recortar: un secreto cortado por la mitad ya no se reconocería.
  const redacted = redactSecrets(text);
  const body = redacted.text.replace(/\s+$/, '');
  const cut = fitText(body, cls.cap).replace(/\s+$/, '');
  const truncated = cut.length < body.length || file.size > head.length;
  return { ok: true, loaded: { text: cut, originalBytes: file.size, truncated, redactions: redacted.count, note } };
}

interface Candidate {
  file: SeenFile;
  cls: Classification;
}

const depthOf = (rel: string): number => rel.split('/').length - 1;

/** Cabecera de un archivo dentro del resumen. */
function blockHeader(rel: string, cls: Classification, loaded: Loaded, shownBytes: number, truncated: boolean): string {
  const extra = [loaded.note, truncated ? `recortado: se muestran ${shownBytes} de ${loaded.originalBytes} bytes` : undefined].filter(Boolean).join('; ');
  return `===== ${rel} [${CATEGORY_LABEL[cls.category]}${extra ? `; ${extra}` : ''}] =====\n`;
}

function renderBlock(rel: string, cls: Classification, loaded: Loaded, text: string, truncated: boolean): string {
  return `${blockHeader(rel, cls, loaded, Buffer.byteLength(text), truncated)}${text}\n\n`;
}

/** Cuántos bytes de texto caben en `room` una vez descontada la cabecera (el texto se recorta de nuevo si hace falta). */
function fitBlock(rel: string, cls: Classification, loaded: Loaded, room: number): { block: string; text: string; truncated: boolean } | undefined {
  let text = loaded.text;
  let truncated = loaded.truncated;
  let block = renderBlock(rel, cls, loaded, text, truncated);
  if (Buffer.byteLength(block) <= room) return { block, text, truncated };
  truncated = true;
  // La cabecera cambia con el recorte (cuenta bytes); se deja margen y se comprueba.
  const overhead = Buffer.byteLength(blockHeader(rel, cls, loaded, 99999, true)) + 2;
  const allowed = room - overhead;
  if (allowed < MIN_USEFUL) return undefined;
  text = fitText(text, allowed);
  block = renderBlock(rel, cls, loaded, text, truncated);
  return Buffer.byteLength(block) <= room ? { block, text, truncated } : undefined;
}

/**
 * Recorre `folder` y devuelve el resumen. Lanza `CliError` (código 2) si la carpeta no existe, no es una carpeta, está vacía
 * o no contiene nada reconocible.
 */
export function scanRepo(folder: string, options: ScanOptions = {}): RepoDigest {
  const remote = options.remote;
  const budget = Math.max(1024, Math.min(options.budgetBytes ?? DEFAULT_BUDGET_BYTES, MAX_BUDGET_BYTES));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const treeDepth = options.treeDepth ?? 3;

  // De un clon temporal se habla por el nombre del repositorio: la ruta del directorio temporal no sale en ningún mensaje.
  const label = remote ? `El repositorio «${remote.name}»` : `La carpeta «${folder}»`;
  const where = remote ? `el clon de «${remote.name}»` : `«${folder}»`;
  if (!existsSync(folder)) throw new CliError(`${label} no existe.`, 2);
  let root: string;
  try {
    root = realpathSync(folder);
    if (!statSync(root).isDirectory()) throw new CliError(`${where} no es una carpeta: --from-repo espera la carpeta de un repositorio.`, 2);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`No se pudo leer ${remote ? where : `la carpeta ${where}`}${remote ? '' : `: ${(error as Error).message}`}`, 2);
  }
  if (root === parse(root).root || root === homeDirectory()) {
    throw new CliError(`${where} es la raíz del disco o tu carpeta personal, no la de un repositorio: indica la carpeta del proyecto (no se envía nada de ahí).`, 2);
  }
  const name = remote ? remote.name : basename(root) || 'repositorio';

  const omit = new Omissions();
  const walked = walkRepo(root, omit, options.maxEntries ?? DEFAULT_MAX_ENTRIES, !remote);
  const { files } = walked;
  const codeFiles = countCode(files);

  // Clasificación: por nombre y, para los YAML sin pista, por su cabecera.
  const candidates: Candidate[] = [];
  let sniffed = 0;
  for (const file of files) {
    let cls = classify(file.rel);
    if (!cls && ['yaml', 'yml'].includes(extensionOf(file.rel)) && file.size <= 200 * 1024 && sniffed < MAX_YAML_SNIFF) {
      sniffed += 1;
      const head = readHead(join(root, ...file.rel.split('/')), 4096);
      if (head && !head.subarray(0, 4096).includes(0)) cls = sniffYaml(head.toString('utf8'));
    }
    if (cls) candidates.push({ file, cls });
  }

  if (files.length === 0) {
    const counts = Object.entries(omit.counts).map(([reason, n]) => `${n} ${OMIT_LABEL[reason as OmitReason]}`);
    throw new CliError(`${label} no contiene archivos de texto que leer${counts.length ? ` (omitidos: ${counts.join('; ')})` : ' (está vacía)'}.`, 2);
  }
  if (candidates.length === 0 && codeFiles === 0) {
    throw new CliError(
      `No se reconoce nada en ${remote ? `el repositorio «${remote.name}»` : where}: ni documentación, manifiestos, contenedores, infraestructura o contratos de API, ni código fuente. ` +
        `${remote ? '¿Es el repositorio que querías?' : '¿Es la carpeta de un repositorio?'}`,
      2,
    );
  }

  // Piezas de tamaño fijo del resumen (acotadas por el presupuesto): cabecera, lenguajes, árbol y componentes.
  const treeCap = Math.min(12 * 1024, Math.floor(budget * 0.22));
  const componentsCap = Math.min(6 * 1024, Math.floor(budget * 0.12));
  const languages = renderLanguages(files);
  const tree = fitWithMark(renderTree(files, treeDepth), treeCap);
  const components = componentPaths(files, 200);
  const componentText = fitWithMark(components.paths.join('\n'), componentsCap);
  const componentsShown = components.paths.length;

  const totalOmitted = Object.values(omit.counts).reduce((a, b) => a + (b ?? 0), 0);
  const header =
    `Repositorio: ${name}\n` +
    `Archivos de texto vistos: ${files.length} en ${walked.dirs + 1} carpetas${walked.truncated ? ' (recorrido parcial: se alcanzó el tope de entradas)' : ''}; ` +
    `fuera del resumen por ser secretos, binarios, dependencias o estar ignorados: ${totalOmitted}.\n` +
    (languages ? `Lenguajes y formatos (por número de archivos): ${languages}.\n` : '');
  const treeSection = `\n## Árbol de carpetas (profundidad ${treeDepth}; entre paréntesis, archivos y extensiones principales)\n${tree}\n`;
  const componentSection = componentText
    ? `\n## Archivos de código cuyo nombre sugiere un componente (solo rutas, sin contenido${components.total > componentsShown ? `; ${componentsShown} de ${components.total}` : ''})\n${componentText}\n`
    : '';
  const keyHeader = '\n## Archivos clave (contenido recortado y con los secretos redactados)\n\n';

  const fixed = Buffer.byteLength(header + treeSection + componentSection + keyHeader);
  let remaining = budget - fixed;

  // Reparto: primero por prioridad con una cuota por categoría; después, con lo que sobre, lo que quedó fuera de cuota.
  const order = candidates.sort(
    (a, b) =>
      Number(isTestPath(a.file.rel)) - Number(isTestPath(b.file.rel)) ||
      a.cls.priority - b.cls.priority ||
      depthOf(a.file.rel) - depthOf(b.file.rel) ||
      (a.file.rel < b.file.rel ? -1 : 1),
  );
  const quotas = Object.fromEntries((Object.keys(CATEGORY_SHARE) as RepoCategory[]).map((c) => [c, Math.floor(Math.max(0, remaining) * CATEGORY_SHARE[c])])) as Record<RepoCategory, number>;
  const used: Partial<Record<RepoCategory, number>> = {};
  const loadedCache = new Map<string, Loaded>();
  const blocks: Array<{ rel: string; block: string; file: DigestFile }> = [];
  const included = new Set<string>();
  let redactions = 0;

  const include = (cand: Candidate, loaded: Loaded, fitted: { block: string; text: string; truncated: boolean }): void => {
    const bytes = Buffer.byteLength(fitted.block);
    remaining -= bytes;
    used[cand.cls.category] = (used[cand.cls.category] ?? 0) + bytes;
    included.add(cand.file.rel);
    redactions += loaded.redactions;
    blocks.push({
      rel: cand.file.rel,
      block: fitted.block,
      file: {
        path: cand.file.rel,
        category: cand.cls.category,
        bytes: Buffer.byteLength(fitted.text),
        originalBytes: loaded.originalBytes,
        truncated: fitted.truncated,
        redactions: loaded.redactions,
        ...(loaded.note ? { note: loaded.note } : {}),
      },
    });
  };

  const settled = new Set<string>();
  const load = (cand: Candidate): Loaded | undefined => {
    const cached = loadedCache.get(cand.file.rel);
    if (cached) return cached;
    const outcome = loadFile(root, cand.file, cand.cls);
    if (!outcome.ok) {
      settled.add(cand.file.rel);
      omit.add(cand.file.rel, outcome.reason, outcome.detail);
      return undefined;
    }
    loadedCache.set(cand.file.rel, outcome.loaded);
    return outcome.loaded;
  };

  for (const pass of [1, 2] as const) {
    for (const cand of order) {
      if (included.has(cand.file.rel) || settled.has(cand.file.rel)) continue;
      if (pass === 1 && isTestPath(cand.file.rel)) continue; // lo de las carpetas de pruebas solo entra con lo que sobre
      if (blocks.length >= maxFiles) break;
      if (remaining < MIN_USEFUL + 80) break;
      const loaded = load(cand);
      if (!loaded) continue;
      const category = cand.cls.category;
      let room = remaining;
      if (pass === 1) {
        const left = quotas[category] - (used[category] ?? 0);
        const first = (used[category] ?? 0) === 0;
        const full = fitBlock(cand.file.rel, cand.cls, loaded, Number.MAX_SAFE_INTEGER);
        // En la primera pasada un archivo entra entero dentro de su cuota; si no cabe, solo entra recortado si es el primero de su categoría.
        if (!full || (Buffer.byteLength(full.block) > left && !first)) continue;
        room = first ? Math.min(remaining, Math.max(left, MIN_USEFUL + 80)) : Math.min(remaining, left);
      }
      const fitted = fitBlock(cand.file.rel, cand.cls, loaded, room);
      if (!fitted) continue;
      include(cand, loaded, fitted);
    }
  }

  for (const cand of order) {
    if (included.has(cand.file.rel) || settled.has(cand.file.rel)) continue;
    omit.add(cand.file.rel, blocks.length >= maxFiles ? 'tope' : 'presupuesto', blocks.length >= maxFiles ? `máximo de ${maxFiles} archivos` : undefined);
  }

  // Los bloques salen por orden de prioridad (no en el que se fueron eligiendo en las dos pasadas).
  const rank = new Map(order.map((c, i) => [c.file.rel, i]));
  blocks.sort((a, b) => (rank.get(a.rel) ?? 0) - (rank.get(b.rel) ?? 0));
  const keyText = blocks.length ? blocks.map((b) => b.block).join('') : '(no se reconoció ningún archivo clave: el modelo solo dispone del árbol de carpetas)\n';
  const assembled = header + treeSection + componentSection + keyHeader + keyText;
  // Última barrera: el resumen entero pasa otra vez por la redacción (rutas, nombres de variables…).
  const final = redactSecrets(assembled);
  let text = final.text.replace(/\n+$/, '\n');
  if (Buffer.byteLength(text) > budget) text = `${fitText(text, budget - 1)}\n`; // solo si la redacción final lo hinchó

  return {
    name,
    ...(remote ? { remote: true as const } : {}),
    text,
    bytes: Buffer.byteLength(text),
    budget,
    included: blocks.map((b) => b.file),
    omitted: omit.list,
    omittedCounts: omit.counts,
    omittedUnlisted: omit.unlisted,
    redactions: redactions + final.count,
    filesSeen: files.length,
    dirsSeen: walked.dirs + 1,
    walkTruncated: walked.truncated,
  };
}
