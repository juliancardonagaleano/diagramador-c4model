import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  cleanName,
  PROJECT_BUNDLE_EXTENSION,
  ProjectError,
  requireModuleId,
  sameName,
  slugify,
  uniqueSlug,
  type Diagram,
  type DiagramMeta,
  type ProjectStore,
  type ProjectSummary,
  type SaveDiagramInput,
} from '@iark/kernel';

/**
 * Espacio de trabajo en una carpeta: la implementación de `ProjectStore` del CLI y de `iark serve`. Solo usa `node:fs`.
 *
 *   <raíz>/
 *     <proyecto>/                     el id del proyecto es el nombre del directorio
 *       project.json                  OPCIONAL: nombre, descripción y los nombres de los diagramas (`iark.project.meta/1`)
 *       <diagrama>.<módulo>.json      el documento JSON del módulo, tal cual; el id del diagrama es el nombre sin `.<módulo>.json`
 *
 * La carpeta es la fuente de verdad: un directorio sin `project.json` es un proyecto (se llama como el directorio) y un
 * `x.<módulo>.json` copiado a mano es un diagrama (se llama `x`, y su fecha de creación es la de modificación del archivo)
 * aunque no esté en el sidecar. Lo que no encaja se ignora sin fallar.
 *
 * Seguridad: ningún id que llegue de fuera puede salir de la raíz (los ids se validan con una expresión estricta antes de
 * tocar el disco y el destino se comprueba con `relative`), no se sigue ningún enlace simbólico (ni de directorios ni de
 * archivos, los ignora) y los documentos se leen con `O_NOFOLLOW`.
 */

const SIDECAR = 'project.json';
export const SIDECAR_FORMAT = 'iark.project.meta/1';
/** Un documento más grande que esto no es un diagrama razonable (y acota lo que se lee de una carpeta ajena). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

/** `<id>.<módulo>.json`: el módulo es lo último antes de `.json` (los ids de módulo no llevan puntos). */
const DIAGRAM_FILE = /^(.+)\.([a-z][a-z0-9-]*)\.json$/;
/**
 * Un id (de proyecto o de diagrama) es un solo segmento de ruta: letras ASCII, dígitos, `_`, `-` y `.` (sin empezar ni
 * acabar en punto, sin `..`). Nada de separadores, espacios, rutas absolutas ni caracteres de control.
 */
const ID_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/;
/** Nombres que Windows reserva (con cualquier extensión): no se aceptan como id ni se generan. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Directorios que nunca son proyectos. */
const NOT_PROJECTS = new Set(['node_modules']);

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !value.includes('..') && !WINDOWS_RESERVED.test(value);
}

const isProjectId = (value: unknown): value is string => isWorkspaceId(value) && !NOT_PROJECTS.has(value);

const shorten = (value: unknown): string => {
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);

const fsCode = (error: unknown): string | undefined => (error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined);
const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(fsCode(error) ?? '');

/** Milisegundos enteros de la marca de modificación: se redondea igual al leer y al comparar (hay sistemas sin precisión de ms). */
const mtimeOf = (st: Stats): number => Math.round(st.mtimeMs);
const birthOf = (st: Stats): number => Math.round(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
const iso = (ms: number): string => new Date(ms).toISOString();

/** Un hijo directo de `parent` con ese nombre; falla si por cualquier razón el destino no queda justo dentro. */
function child(parent: string, name: string): string {
  const target = resolve(parent, name);
  if (relative(parent, target) !== name) throw new ProjectError('invalid', `Ruta no permitida «${shorten(name)}».`);
  return target;
}

/** Lee un archivo normal sin seguir enlaces simbólicos. `undefined` si no existe o no es un archivo normal. */
async function readRegular(path: string, maxBytes: number, what: string): Promise<{ text: string; stat: Stats } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isMissing(error) || fsCode(error) === 'EISDIR') return undefined;
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return undefined;
    if (st.size > maxBytes) throw new ProjectError('invalid', `${what} pesa más de ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    return { text: await handle.readFile({ encoding: 'utf8' }), stat: st };
  } finally {
    await handle.close();
  }
}

interface SidecarEntry {
  name?: string;
  createdAt?: string;
}
interface SidecarRead {
  name?: string;
  description?: string;
  createdAt?: string;
  diagrams: Map<string, SidecarEntry>;
}

const safeName = (raw: unknown): string | undefined => {
  try {
    return cleanName(raw, '');
  } catch {
    return undefined;
  }
};
const safeDate = (raw: unknown): string | undefined => (typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : undefined);

/** Interpreta el sidecar con tolerancia: lo que no se entiende se ignora y se usan los valores deducidos de la carpeta. */
function parseSidecar(json: unknown): SidecarRead | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const record = json as Record<string, unknown>;
  if (record.format !== SIDECAR_FORMAT) return undefined;
  const diagrams = new Map<string, SidecarEntry>();
  if (record.diagrams && typeof record.diagrams === 'object' && !Array.isArray(record.diagrams)) {
    for (const [id, entry] of Object.entries(record.diagrams)) {
      if (!isWorkspaceId(id) || !entry || typeof entry !== 'object') continue;
      diagrams.set(id, { name: safeName((entry as SidecarEntry).name), createdAt: safeDate((entry as SidecarEntry).createdAt) });
    }
  }
  return {
    name: safeName(record.name),
    description: typeof record.description === 'string' ? record.description.trim() || undefined : undefined,
    createdAt: safeDate(record.createdAt),
    diagrams,
  };
}

async function readSidecar(dir: string): Promise<{ data: SidecarRead; ms: number } | undefined> {
  try {
    const file = await readRegular(join(dir, SIDECAR), MAX_SIDECAR_BYTES, 'El archivo project.json');
    if (!file) return undefined;
    const data = parseSidecar(JSON.parse(file.text));
    return data ? { data, ms: mtimeOf(file.stat) } : undefined;
  } catch {
    return undefined; // corrupto, demasiado grande o ilegible: se ignora, el proyecto sigue valiendo
  }
}

interface LoadedDiagram {
  id: string;
  module: string;
  file: string;
  name: string;
  createdAt: string;
  updatedMs: number;
  /** Tiene entrada en el sidecar (si no, el nombre y la fecha de creación se deducen del archivo). */
  fromSidecar: boolean;
}

interface Loaded {
  id: string;
  dir: string;
  name: string;
  description?: string;
  createdAt: string;
  hasSidecar: boolean;
  updatedMs: number;
  diagrams: LoadedDiagram[];
  /** Ids de diagrama ocupados en minúsculas, también por entradas que se ignoran (enlaces, directorios…). */
  takenStems: Set<string>;
}

/** Lo que se escribe en `project.json`. */
interface Draft {
  name: string;
  description?: string;
  createdAt: string;
  diagrams: Map<string, { name: string; createdAt: string }>;
}

const draftOf = (loaded: Loaded): Draft => ({
  name: loaded.name,
  description: loaded.description,
  createdAt: loaded.createdAt,
  diagrams: new Map(loaded.diagrams.filter((d) => d.fromSidecar).map((d) => [d.id, { name: d.name, createdAt: d.createdAt }])),
});

const summaryOf = (loaded: Loaded): ProjectSummary => ({
  id: loaded.id,
  name: loaded.name,
  ...(loaded.description ? { description: loaded.description } : {}),
  createdAt: loaded.createdAt,
  updatedAt: iso(loaded.updatedMs),
  diagrams: loaded.diagrams.map(metaOf).sort(byName),
});

const metaOf = (d: LoadedDiagram): DiagramMeta => ({ id: d.id, module: d.module, name: d.name, createdAt: d.createdAt, updatedAt: iso(d.updatedMs) });

const toProjectError = (error: unknown, root: string): unknown => {
  if (error instanceof ProjectError) return error;
  const code = fsCode(error);
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    return new ProjectError('unavailable', `No se pudo usar el espacio de trabajo «${root}»: ${(error as Error).message}`);
  }
  return error;
};

const MAX_DESCRIPTION_LENGTH = 2000;

/** Texto de la descripción: opcional, sin espacios sobrantes y de un tamaño razonable (va en `project.json`, que se lee entero al listar). */
function descriptionOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ProjectError('invalid', 'La descripción debe ser un texto.');
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new ProjectError('invalid', `La descripción no puede pasar de ${MAX_DESCRIPTION_LENGTH} caracteres.`);
  return description || undefined;
}

export class FolderProjectStore implements ProjectStore {
  readonly kind = 'folder';
  /** Ruta absoluta de la carpeta de trabajo. */
  readonly root: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  // ───────────── utilidades internas ─────────────

  /** Las operaciones que escriben van de una en una dentro de este proceso (dos guardados seguidos no se pisan). */
  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async guard<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toProjectError(error, this.root);
    }
  }

  /** La carpeta de trabajo ya resuelta (sin enlaces), o `undefined` si todavía no existe y no se pidió crearla. */
  private async realRoot(create = false): Promise<string | undefined> {
    try {
      const real = await realpath(this.root);
      if (!(await stat(real)).isDirectory()) throw new ProjectError('unavailable', `«${this.root}» no es una carpeta.`);
      return real;
    } catch (error) {
      if (fsCode(error) === 'ENOENT') {
        if (!create) return undefined;
        await mkdir(this.root, { recursive: true });
        return realpath(this.root);
      }
      if (fsCode(error) === 'ENOTDIR') throw new ProjectError('unavailable', `«${this.root}» no es una carpeta.`);
      throw error;
    }
  }

  /** Ids de los directorios de `root` que son proyectos (directorios normales con un id válido). */
  private async projectIds(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isProjectId(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** El nombre con que se muestra un proyecto, leyendo solo su sidecar. */
  private async projectName(root: string, id: string): Promise<string> {
    return (await readSidecar(child(root, id)))?.data.name ?? id;
  }

  private async assertNameFree(root: string, name: string, except?: string): Promise<void> {
    for (const id of await this.projectIds(root)) {
      if (id !== except && sameName(await this.projectName(root, id), name)) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
    }
  }

  /** Carga un proyecto de la carpeta. `undefined` si no hay un directorio normal con ese id. */
  private async loadIn(root: string, id: string): Promise<Loaded | undefined> {
    if (!isProjectId(id)) return undefined;
    const dir = child(root, id);
    let st: Stats;
    try {
      st = await lstat(dir);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!st.isDirectory()) return undefined; // un enlace simbólico (aunque apunte a una carpeta) no cuenta
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return undefined; // lo borraron en este instante
      throw error;
    }
    const sidecar = await readSidecar(dir);

    const takenStems = new Set<string>();
    const candidates = new Map<string, { id: string; module: string; file: string }>();
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.endsWith(PROJECT_BUNDLE_EXTENSION)) continue; // un archivo único del proyecto exportado a su carpeta
      const match = DIAGRAM_FILE.exec(entry.name);
      if (!match || !isWorkspaceId(match[1])) continue;
      takenStems.add(match[1].toLowerCase());
      if (!entry.isFile() || candidates.has(match[1])) continue; // enlaces, directorios… se ignoran; con dos módulos para un mismo id gana el primero
      candidates.set(match[1], { id: match[1], module: match[2], file: entry.name });
    }
    const found = await Promise.all(
      [...candidates.values()].map(async (c): Promise<LoadedDiagram | undefined> => {
        let fileStat: Stats;
        try {
          fileStat = await lstat(join(dir, c.file));
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
        if (!fileStat.isFile()) return undefined;
        const entry = sidecar?.data.diagrams.get(c.id);
        const updatedMs = mtimeOf(fileStat);
        return {
          ...c,
          name: entry?.name ?? c.id,
          createdAt: entry?.createdAt ?? iso(updatedMs),
          updatedMs,
          fromSidecar: entry !== undefined,
        };
      }),
    );
    const diagrams = found.filter((d): d is LoadedDiagram => d !== undefined);
    return {
      id,
      dir,
      name: sidecar?.data.name ?? id,
      description: sidecar?.data.description,
      createdAt: sidecar?.data.createdAt ?? iso(birthOf(st)),
      hasSidecar: sidecar !== undefined,
      updatedMs: diagrams.reduce((latest, d) => Math.max(latest, d.updatedMs), Math.max(mtimeOf(st), sidecar?.ms ?? 0)),
      diagrams,
      takenStems,
    };
  }

  /** Como `loadIn`, pero exige que el nombre del directorio coincida exactamente (en sistemas que no distinguen mayúsculas, `TIENDA` no es `tienda`). */
  private async load(id: string): Promise<Loaded | undefined> {
    if (!isProjectId(id)) return undefined;
    const root = await this.realRoot();
    if (!root) return undefined;
    if (!(await this.projectIds(root)).includes(id)) return undefined;
    return this.loadIn(root, id);
  }

  private async requireProject(id: string): Promise<Loaded> {
    if (!isProjectId(id)) throw new ProjectError('invalid', `Identificador de proyecto inválido «${shorten(id)}».`);
    const loaded = await this.load(id);
    if (!loaded) throw new ProjectError('not-found', `No existe el proyecto «${id}».`);
    return loaded;
  }

  private requireDiagram(loaded: Loaded, id: unknown): LoadedDiagram {
    if (!isWorkspaceId(id)) throw new ProjectError('invalid', `Identificador de diagrama inválido «${shorten(id)}».`);
    const found = loaded.diagrams.find((d) => d.id === id);
    if (!found) throw new ProjectError('not-found', `No existe el diagrama «${id}» en el proyecto «${loaded.name}».`);
    return found;
  }

  /**
   * Escribe un archivo de forma atómica: a un temporal del mismo directorio y `rename` (los lectores nunca ven un archivo
   * a medias). Fija la marca de modificación, que es la fecha `updatedAt` del diagrama: la hora actual o, si se indica
   * `growFrom` (la marca anterior), una estrictamente mayor, aunque el guardado ocurra en el mismo milisegundo o el sistema de
   * archivos solo guarde segundos (FAT: 2 s). Devuelve la marca que quedó guardada de verdad, redondeada como al leerla, para
   * que lo que se devuelve al guardar y lo que se lee después coincidan siempre. Con `exclusive` no pisa un archivo que ya
   * exista (falla con `EEXIST`): se publica con `link`, que es atómico y no sobrescribe.
   */
  private async writeAtomic(path: string, text: string, options: { growFrom?: number; exclusive?: boolean } = {}): Promise<number> {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const stamp = async (ms: number): Promise<number> => {
      await utimes(tmp, new Date(ms), new Date(ms));
      return mtimeOf(await lstat(tmp));
    };
    try {
      await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
      const previous = options.growFrom;
      let stored = await stamp(Math.max(Date.now(), (previous ?? -1) + 1));
      for (const step of [1000, 2000]) {
        if (previous === undefined || stored > previous) break;
        stored = await stamp(previous + step); // marcas de 1 s o de 2 s: la siguiente que el sistema de archivos distingue
      }
      if (options.exclusive) {
        try {
          await link(tmp, path);
        } catch (error) {
          if (fsCode(error) === 'EEXIST' || !['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EACCES'].includes(fsCode(error) ?? '')) throw error;
          // sistema de archivos sin enlaces duros: se comprueba que no exista y se publica con rename
          const exists = await lstat(path).then(
            () => true,
            (inner: unknown) => {
              if (isMissing(inner)) return false;
              throw inner;
            },
          );
          if (exists) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
          await rename(tmp, path);
          return stored;
        }
        await unlink(tmp);
      } else {
        await rename(tmp, path);
      }
      return stored;
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Escribe `project.json`. Su marca de modificación sube por encima de la última del proyecto: `updatedAt` crece siempre. */
  private async writeSidecar(loaded: Loaded, draft: Draft): Promise<void> {
    const file = {
      format: SIDECAR_FORMAT,
      name: draft.name,
      ...(draft.description ? { description: draft.description } : {}),
      createdAt: draft.createdAt,
      diagrams: Object.fromEntries([...draft.diagrams].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await this.writeAtomic(join(loaded.dir, SIDECAR), `${JSON.stringify(file, null, 2)}\n`, { growFrom: loaded.updatedMs });
  }

  // ───────────── ProjectStore: proyectos ─────────────

  listProjects(): Promise<ProjectSummary[]> {
    return this.guard(async () => {
      const root = await this.realRoot();
      if (!root) return [];
      const projects: ProjectSummary[] = [];
      for (const id of await this.projectIds(root)) {
        try {
          const loaded = await this.loadIn(root, id);
          if (loaded) projects.push(summaryOf(loaded));
        } catch {
          // un directorio que no se puede leer (permisos) no impide listar los demás
        }
      }
      return projects.sort(byName);
    });
  }

  getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.guard(async () => {
      const loaded = await this.load(id);
      return loaded ? summaryOf(loaded) : undefined;
    });
  }

  createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    return this.guard(() =>
      this.exclusive(async () => {
        const name = cleanName(input.name, 'del proyecto');
        const description = descriptionOf(input.description);
        const root = (await this.realRoot(true))!;
        await this.assertNameFree(root, name);
        const taken = new Set((await readdir(root)).map((n) => n.toLowerCase()));
        const base = slugify(name, 'proyecto');
        if (WINDOWS_RESERVED.test(base)) taken.add(base);
        let id: string;
        for (let attempt = 0; ; attempt++) {
          id = uniqueSlug(base, taken);
          try {
            await mkdir(child(root, id)); // sin `recursive`: falla si ya existe (también si es un enlace)
            break;
          } catch (error) {
            if (fsCode(error) !== 'EEXIST' || attempt >= 50) throw error;
            taken.add(id);
          }
        }
        const dir = child(root, id);
        const created = Date.now();
        try {
          await this.writeSidecar(
            { id, dir, name, createdAt: iso(created), hasSidecar: false, updatedMs: 0, diagrams: [], takenStems: new Set() },
            { name, description, createdAt: iso(created), diagrams: new Map() },
          );
        } catch (error) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return summaryOf((await this.loadIn(root, id))!);
      }),
    );
  }

  renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    return this.guard(() =>
      this.exclusive(async () => {
        const loaded = await this.requireProject(id);
        const name = cleanName(rawName, 'del proyecto');
        await this.assertNameFree((await this.realRoot())!, name, id);
        // Solo cambia el nombre: el directorio conserva su id, así las rutas que otros hayan escrito en scripts siguen valiendo.
        await this.writeSidecar(loaded, { ...draftOf(loaded), name });
        return summaryOf((await this.load(id))!);
      }),
    );
  }

  deleteProject(id: string): Promise<void> {
    return this.guard(() =>
      this.exclusive(async () => {
        const loaded = await this.requireProject(id);
        await rm(loaded.dir, { recursive: true, force: true });
      }),
    );
  }

  // ───────────── ProjectStore: diagramas ─────────────

  getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.guard(async () => {
      const loaded = await this.load(projectId);
      if (!loaded) throw new ProjectError('not-found', `No existe el proyecto «${shorten(projectId)}».`);
      const found = isWorkspaceId(diagramId) ? loaded.diagrams.find((d) => d.id === diagramId) : undefined;
      if (!found) return undefined;
      const file = await readRegular(join(loaded.dir, found.file), MAX_DOCUMENT_BYTES, `El diagrama «${found.name}»`);
      if (!file) return undefined;
      return { ...metaOf(found), updatedAt: iso(mtimeOf(file.stat)), text: file.text };
    });
  }

  saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    return this.guard(() =>
      this.exclusive(async () => {
        const loaded = await this.requireProject(projectId);
        if (typeof input.text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.');
        if (Buffer.byteLength(input.text, 'utf8') > MAX_DOCUMENT_BYTES) throw new ProjectError('invalid', `El documento pesa más de ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`);
        if (input.ifUpdatedAt !== undefined && typeof input.ifUpdatedAt !== 'string') throw new ProjectError('invalid', '`ifUpdatedAt` debe ser un texto.');
        return input.id !== undefined ? this.updateDiagram(loaded, input) : this.createDiagram(loaded, input);
      }),
    );
  }

  private async updateDiagram(loaded: Loaded, input: SaveDiagramInput): Promise<DiagramMeta> {
    const current = this.requireDiagram(loaded, input.id);
    if (input.module !== undefined && input.module !== current.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${current.module}»).`);
    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== iso(current.updatedMs)) {
      throw new ProjectError('conflict', `El diagrama «${current.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`);
    }
    const updatedMs = await this.writeAtomic(join(loaded.dir, current.file), input.text, { growFrom: current.updatedMs });
    if (!current.fromSidecar) {
      // Un diagrama puesto a mano: se fija su fecha de creación en el sidecar, que si no seguiría la de modificación.
      const draft = draftOf(loaded);
      draft.diagrams.set(current.id, { name: current.name, createdAt: current.createdAt });
      await this.writeSidecar({ ...loaded, updatedMs }, draft).catch(() => undefined);
    }
    return { ...metaOf(current), updatedAt: iso(updatedMs) };
  }

  private async createDiagram(loaded: Loaded, input: SaveDiagramInput): Promise<DiagramMeta> {
    const module = requireModuleId(input.module);
    const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
    if (loaded.diagrams.some((d) => sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${loaded.name}».`);
    const taken = new Set(loaded.takenStems);
    const base = slugify(name, 'diagrama');
    if (WINDOWS_RESERVED.test(base)) taken.add(base);
    let id: string;
    let createdMs: number;
    for (let attempt = 0; ; attempt++) {
      id = uniqueSlug(base, taken);
      try {
        createdMs = await this.writeAtomic(join(loaded.dir, `${id}.${module}.json`), input.text, { exclusive: true });
        break;
      } catch (error) {
        if (fsCode(error) !== 'EEXIST' || attempt >= 50) throw error;
        taken.add(id); // otro proceso se quedó con ese id: se prueba el siguiente
      }
    }
    const file = `${id}.${module}.json`;
    const draft = draftOf(loaded);
    draft.diagrams.set(id, { name, createdAt: iso(createdMs) });
    try {
      await this.writeSidecar(loaded, draft);
    } catch (error) {
      await rm(join(loaded.dir, file), { force: true }).catch(() => undefined);
      throw error;
    }
    return { id, module, name, createdAt: iso(createdMs), updatedAt: iso(createdMs) };
  }

  renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    return this.guard(() =>
      this.exclusive(async () => {
        const loaded = await this.requireProject(projectId);
        const current = this.requireDiagram(loaded, diagramId);
        const name = cleanName(rawName, 'del diagrama');
        if (loaded.diagrams.some((d) => d.id !== current.id && sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${loaded.name}».`);
        // Solo cambia el nombre en el sidecar: el archivo (y su fecha `updatedAt`) no se tocan.
        const draft = draftOf(loaded);
        draft.diagrams.set(current.id, { name, createdAt: current.createdAt });
        await this.writeSidecar(loaded, draft);
        return { ...metaOf(current), name };
      }),
    );
  }

  deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    return this.guard(() =>
      this.exclusive(async () => {
        const loaded = await this.requireProject(projectId);
        const current = this.requireDiagram(loaded, diagramId);
        await unlink(join(loaded.dir, current.file));
        if (loaded.hasSidecar) {
          const draft = draftOf(loaded);
          draft.diagrams.delete(current.id);
          await this.writeSidecar(loaded, draft).catch(() => undefined); // solo quita una entrada que ya no sirve
        }
      }),
    );
  }
}
