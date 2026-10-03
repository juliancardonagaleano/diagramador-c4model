import {
  detectMermaidKind,
  MERMAID_DIAGRAM_KINDS,
  ModuleError,
  pickId,
  parseFlowchart,
  preprocessMermaid,
  splitLabel,
  truncate,
  Warnings,
  type FlowNodeRef,
  type MermaidLine,
} from '@iark/kernel';
import { MATRIX_MARKS } from '../export/render';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import {
  ENTERPRISE_DOCUMENT_VERSION,
  KIND_LABELS,
  relationBetween,
  type Application,
  type BusinessService,
  type Capability,
  type DrawnKind,
  type EnterpriseDocument,
  type Process,
  type Relation,
  type Technology,
  type ValueStage,
  type ValueStream,
} from '../types';

export class EnterpriseImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'EnterpriseImportError';
  }
}

export interface EnterpriseImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface EnterpriseImportResult {
  document: EnterpriseDocument;
  warnings: string[];
}

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Nombres (sin acentos, en minúsculas) con los que se reconoce un tipo: en la clase de un nodo o en el título de una capa. */
type ImportKind = DrawnKind | 'service' | 'stage';
const KIND_WORDS: Record<ImportKind, string[]> = {
  capability: ['capability', 'capabilities', 'capacidad', 'capacidades'],
  process: ['process', 'processes', 'proceso', 'procesos'],
  application: ['application', 'applications', 'app', 'apps', 'aplicacion', 'aplicaciones'],
  technology: ['technology', 'technologies', 'tech', 'tecnologia', 'tecnologias'],
  service: ['service', 'services', 'servicio', 'servicios', 'servicio de negocio'],
  stage: ['stage', 'stages', 'etapa', 'etapas'],
};
const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const kindFromWord = (word: string): ImportKind | undefined => (Object.keys(KIND_WORDS) as ImportKind[]).find((k) => KIND_WORDS[k].includes(normalize(word)));

interface Group {
  alias: string;
  label: string;
  /** Orden de aparición en el texto, para conservarlo en el documento. */
  seq: number;
  parent?: string;
  /** Un `subgraph` cuyo título es un tipo («Aplicaciones») es una capa, no una capacidad. */
  layer?: ImportKind;
}

/**
 * Importa un `flowchart` de Mermaid como documento empresarial. El tipo de cada nodo sale, por este orden, de su clase
 * (`:::application`, `class A capability`; también en español), del título de la capa que lo contiene («Aplicaciones»),
 * de su forma (`([ ])` = proceso, `[( )]` = tecnología) y, por último, de que esté dentro de un grupo (capacidad) o no
 * (aplicación). Un `subgraph` que no es una capa es una capacidad que contiene a las suyas, salvo que contenga etapas
 * (`:::stage`): entonces es un flujo de valor y sus etapas, en el orden del texto. Un nodo `:::service` es un servicio de
 * negocio (la segunda línea, su audiencia) y una etapa, la segunda línea, el valor que aporta. Cada flecha se convierte en
 * la relación que admiten sus extremos (en cualquier sentido); la segunda línea del texto de una aplicación es su
 * tecnología y la de una tecnología, su versión.
 *
 * Un `block-beta` es la matriz capacidad × aplicación que exporta `toMermaid` (vista `matrix`): se lee con `fromMatrixBlock`.
 */
export function fromMermaid(source: string, options: EnterpriseImportOptions = {}): EnterpriseImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new EnterpriseImportError('El texto de Mermaid está vacío.');
  if (BLOCK_HEADER.test(lines[0].text)) return fromMatrixBlock(lines, title, options);
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart') {
    throw new EnterpriseImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como arquitectura empresarial. Se admiten flowchart/graph y el block-beta de la matriz capacidad × aplicación.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${[...MERMAID_DIAGRAM_KINDS, 'block-beta (matriz capacidad × aplicación)'].join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const groups = new Map<string, Group>();
  const nodes = new Map<string, { ref: FlowNodeRef; classes: Set<string>; group?: string; seq: number }>();
  let seq = 0;
  const edges: Array<{ from: string[]; to: string[]; label?: string; where: string }> = [];
  const stack: string[] = [];

  for (const ev of parseFlowchart(lines.slice(1))) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      groups.set(ev.alias, { alias: ev.alias, label: ev.label, seq: seq++, parent: stack[stack.length - 1], layer: kindFromWord(splitLabel(ev.label).name) });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      const known = nodes.get(ev.node.alias);
      if (!known) nodes.set(ev.node.alias, { ref: { ...ev.node }, classes: new Set(ev.node.classes), group: stack[stack.length - 1], seq: seq++ });
      else {
        for (const c of ev.node.classes ?? []) known.classes.add(c);
        if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
      }
    } else {
      const from = ev.from.map((n) => n.alias);
      const to = ev.to.map((n) => n.alias);
      edges.push({ from, to, label: ev.label, where: ev.where });
      if (ev.bidirectional) edges.push({ from: to, to: from, label: ev.label, where: ev.where });
    }
  }

  // El grupo «real» de un nodo o de un grupo: el ancestro más cercano que no es una capa, y la capa más cercana.
  const climb = (start: string | undefined, want: (g: Group) => boolean): Group | undefined => {
    for (let a = start; a !== undefined; a = groups.get(a)?.parent) {
      const g = groups.get(a);
      if (g && want(g)) return g;
    }
    return undefined;
  };

  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const kindOf = new Map<string, ImportKind>();
  const valueStreams: ValueStream[] = [];
  const valueStages: ValueStage[] = [];
  const businessServices: BusinessService[] = [];
  const capabilities: Capability[] = [];
  const processes: Process[] = [];
  const applications: Application[] = [];
  const technologies: Technology[] = [];
  const take = (alias: string, name: string, fallback: string): string => {
    const id = pickId(slug(alias) || slug(name) || fallback, ids);
    idOf.set(alias, id);
    return id;
  };

  // Un grupo que contiene etapas es un flujo de valor, no una capacidad.
  const isStage = (n: { classes: Set<string> }): boolean => [...n.classes].some((c) => kindFromWord(c) === 'stage');
  const streamGroups = new Set([...nodes.values()].filter((n) => isStage(n) && n.group !== undefined && !groups.get(n.group)?.layer).map((n) => n.group as string));

  // Los elementos se crean en el orden en que aparecen en el texto.
  const entries = [
    ...[...groups.values()].filter((g) => !g.layer).map((g) => ({ seq: g.seq, group: g })),
    ...[...nodes.values()].filter((n) => !(groups.has(n.ref.alias) && !groups.get(n.ref.alias)!.layer)).map((n) => ({ seq: n.seq, node: n })),
  ].sort((a, b) => a.seq - b.seq);
  // (una arista a un subgraph ya es la capacidad de ese grupo, no un nodo aparte)

  for (const entry of entries) {
    if ('group' in entry) {
      const g = entry.group;
      const name = splitLabel(g.label).name || g.alias;
      if (streamGroups.has(g.alias)) {
        valueStreams.push({ id: take(g.alias, name, 'flujo-de-valor'), name });
        continue;
      }
      const id = take(g.alias, name, 'capacidad');
      kindOf.set(g.alias, 'capability');
      const parent = climb(g.parent, (x) => !x.layer);
      capabilities.push({ id, name, ...(parent ? { parentId: idOf.get(parent.alias) } : {}) });
      continue;
    }
    const { ref, classes, group } = entry.node;
    const label = splitLabel(ref.label ?? ref.alias);
    const name = label.name || ref.alias;
    const container = climb(group, (g) => !g.layer);
    const layer = climb(group, (g) => g.layer !== undefined)?.layer;
    const byClass = [...classes].map(kindFromWord).find((k) => k !== undefined);
    const byShape: DrawnKind | undefined = ref.shape === 'stadium' ? 'process' : ref.shape === 'cylinder' ? 'technology' : undefined;
    const k: ImportKind = byClass ?? layer ?? byShape ?? (container ? 'capability' : 'application');
    kindOf.set(ref.alias, k);
    const id = take(ref.alias, name, k);
    if (k === 'stage') {
      let stream = group && streamGroups.has(group) ? valueStreams.find((v) => v.id === idOf.get(group)) : undefined;
      if (!stream) {
        stream = valueStreams.find((v) => v.id === 'flujo-de-valor') ?? { id: pickId('flujo-de-valor', ids), name: 'Flujo de valor' };
        if (!valueStreams.includes(stream)) {
          ids.add(stream.id);
          valueStreams.push(stream);
        }
      }
      valueStages.push({ id, name, streamId: stream.id, ...(label.description ? { value: label.description } : {}) });
    } else if (k === 'service') {
      businessServices.push({ id, name, ...(label.description ? { audience: label.description } : {}) });
    } else if (k === 'capability') {
      const parent = container && !layer ? idOf.get(container.alias) : undefined;
      capabilities.push({ id, name, ...(parent ? { parentId: parent } : {}) });
      if (container && layer) warnings.add(`«${name}» está dentro del grupo «${container.label}» y de una capa: se importa sin capacidad padre.`);
    } else {
      if (container && !layer) warnings.add(`«${name}» está dentro del grupo «${container.label}» pero es ${KIND_LABELS[k].toLowerCase()}, no una capacidad: se importa sin padre.`);
      if (k === 'process') processes.push({ id, name });
      else if (k === 'application') applications.push({ id, name, ...(label.description ? { technology: label.description } : {}) });
      else technologies.push({ id, name, ...(label.description ? { version: label.description } : {}) });
    }
  }

  const relationIds = new Set<string>();
  const signatures = new Set<string>();
  const relations: Relation[] = [];
  const nameOf = (alias: string): string => {
    const id = idOf.get(alias);
    return [...capabilities, ...processes, ...applications, ...technologies, ...valueStages, ...businessServices].find((x) => x.id === id)?.name ?? alias;
  };
  for (const e of edges) {
    const description = e.label ? splitLabel(e.label).name : '';
    for (const a of e.from) {
      for (const b of e.to) {
        if (!idOf.has(a) || !idOf.has(b) || a === b) {
          if (a !== b) warnings.add(`${e.where}: la arista ${a} → ${b} no se puede importar; se omite.`);
          continue;
        }
        const [ka, kb] = [kindOf.get(a)!, kindOf.get(b)!];
        if (!ka || !kb) {
          warnings.add(`${e.where}: la arista ${a} → ${b} une un flujo de valor, que solo se relaciona con sus etapas; se omite.`);
          continue;
        }
        // Las flechas entre etapas solo marcan su orden, que ya es el del texto.
        if (ka === 'stage' && kb === 'stage') continue;
        const rule = relationBetween(ka, kb);
        if (!rule) {
          warnings.add(`${e.where}: «${nameOf(a)}» → «${nameOf(b)}» une ${KIND_LABELS[ka].toLowerCase()} con ${KIND_LABELS[kb].toLowerCase()}, que no se relacionan; se omite${ka === 'capability' && kb === 'capability' ? ' (usa grupos para la jerarquía de capacidades)' : ''}.`);
          continue;
        }
        const [sourceId, targetId] = rule.reversed ? [idOf.get(b)!, idOf.get(a)!] : [idOf.get(a)!, idOf.get(b)!];
        const signature = `${rule.kind}|${sourceId}|${targetId}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        relations.push({ id: pickId(`${sourceId}--${rule.kind}--${targetId}`, relationIds), kind: rule.kind, sourceId, targetId, ...(description ? { description } : {}) });
      }
    }
  }

  if (capabilities.length + processes.length + applications.length + technologies.length + valueStages.length + businessServices.length === 0) {
    throw new EnterpriseImportError('El diagrama de Mermaid no define ningún elemento que se pueda importar.');
  }
  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura empresarial';
  const result = validateEnterpriseDocument({ version: ENTERPRISE_DOCUMENT_VERSION, workspace: { name }, capabilities, processes, applications, technologies, valueStreams, valueStages, businessServices, relations });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}

// ───────────── Matriz capacidad × aplicación: el `block-beta` que exporta `toMermaid` ─────────────

/** Cabecera de un diagrama de bloques de Mermaid (`block-beta`, o `block` en las versiones nuevas). */
const BLOCK_HEADER = /^block(?:-beta)?(?:\s|$)/;

/** ¿Es un diagrama de bloques de Mermaid, el formato en que se exporta la matriz capacidad × aplicación? */
export function looksLikeMatrixBlock(source: string): boolean {
  try {
    const { lines } = preprocessMermaid(source);
    return lines.length > 0 && BLOCK_HEADER.test(lines[0].text);
  } catch {
    return false;
  }
}

/** Una entrada de la cuadrícula: un hueco (`space`, sin texto) o un bloque `id["texto"]`. */
const BLOCK_ENTRY = /\s*(?:space(?::(\d+))?|([A-Za-z_][\w-]*)\[\s*"([^"]*)"\s*\](?::(\d+))?)(?=\s|$)/y;
const BLOCK_STYLE = /^(?:classDef|class|style|linkStyle)\s/;
/** Sangría de una capacidad con padre: un `›` por nivel y un espacio, antes del nombre. */
const BLOCK_DEPTH = /^(›+)\s+(.+)$/;

/**
 * Importa el `block-beta` de la matriz capacidad × aplicación (`toMermaid` con la vista `matrix`): una cuadrícula con una fila
 * de cabecera (`space:1`, las aplicaciones y «Total»), una fila por capacidad (su nombre con un `›` por nivel de sangría, una
 * celda por aplicación y su total) y una fila final de totales. Las filas son capacidades, con su jerarquía por la sangría
 * (`parentId`: el padre es la capacidad anterior de un nivel menos); las columnas, aplicaciones; y cada `●` es una relación
 * `supports` de la aplicación a la capacidad. Como Mermaid, lee las entradas en el orden del texto y las reparte en filas de
 * `columns` entradas, así que el salto de línea no importa. `○` (soporte por un proceso que realiza la capacidad) y `·`
 * (heredado de una capacidad hija) se derivan de otras relaciones, no de esta: se cuentan en los avisos y no se importan.
 */
function fromMatrixBlock(lines: MermaidLine[], title: string | undefined, options: EnterpriseImportOptions): EnterpriseImportResult {
  const warnings = new Warnings();
  let columns: number | undefined;
  const entries: Array<{ label?: string; where: string }> = [];
  for (const { no, text } of lines.slice(1)) {
    const where = `línea ${no}`;
    if (BLOCK_STYLE.test(text)) continue;
    const declared = /^columns\s+(\S+)$/.exec(text);
    if (declared) {
      const n = /^\d+$/.test(declared[1]) ? Number(declared[1]) : 0;
      if (n < 1) throw new EnterpriseImportError(`${where}: «${truncate(text)}» no indica un número de columnas.`);
      if (columns === undefined) columns = n;
      else warnings.add(`${where}: la cuadrícula ya tiene ${columns} columnas; se ignora «${text}».`);
      continue;
    }
    let at = 0;
    for (;;) {
      BLOCK_ENTRY.lastIndex = at;
      const m = BLOCK_ENTRY.exec(text);
      if (!m) break;
      at = BLOCK_ENTRY.lastIndex;
      const space = m[2] === undefined;
      const span = Number(space ? (m[1] ?? 1) : (m[4] ?? 1));
      if (!space && span > 1) throw new EnterpriseImportError(`${where}: un bloque que ocupa varias columnas («:${span}») no es de una matriz capacidad × aplicación.`);
      for (let i = 0; i < (space ? span : 1); i += 1) entries.push(space ? { where } : { label: m[3], where });
    }
    const rest = text.slice(at).trim();
    if (rest) warnings.add(`${where}: no se entiende «${truncate(rest)}»; se omite.`);
  }

  if (columns === undefined) throw new EnterpriseImportError('Al diagrama de bloques le falta «columns N»: la matriz tiene una columna por aplicación, más la de las capacidades y la del total.');
  if (columns < 3) throw new EnterpriseImportError(`Una matriz capacidad × aplicación tiene al menos tres columnas (capacidades, una aplicación y el total) y el diagrama declara ${columns}.`);
  if (entries.length % columns !== 0) throw new EnterpriseImportError(`Las ${entries.length} entradas del diagrama no forman filas de ${columns} columnas: la cuadrícula no es rectangular.`);
  const rows = Array.from({ length: entries.length / columns }, (_, i) => entries.slice(i * columns, (i + 1) * columns));
  if (rows.length < 2) throw new EnterpriseImportError('El diagrama de bloques no tiene filas de capacidades: la primera fila son las aplicaciones y debajo van las capacidades.');
  const [header, ...rest] = rows;
  if (header[0].label !== undefined) throw new EnterpriseImportError(`${header[0].where}: la primera fila de la matriz empieza con un hueco («space:1») sobre las capacidades, y sigue con las aplicaciones y el total.`);
  // La última fila son los totales de las columnas («Total»), salvo que el diagrama no la lleve.
  const footer = rest.length > 1 && rest[rest.length - 1][0].label?.trim().toLowerCase() === 'total';
  const body = footer ? rest.slice(0, -1) : rest;

  const ids = new Set<string>();
  const applications: Application[] = [];
  const capabilities: Capability[] = [];
  const relations: Relation[] = [];
  const relationIds = new Set<string>();
  const columnApps = header.slice(1, columns - 1).map((entry, j) => {
    const name = (entry.label ?? '').trim();
    if (!name) {
      warnings.add(`${entry.where}: la columna ${j + 1} no tiene el nombre de una aplicación; se omite con sus marcas.`);
      return undefined;
    }
    const app: Application = { id: pickId(slug(name) || 'aplicacion', ids), name };
    applications.push(app);
    return app;
  });

  const parents: Array<{ depth: number; id: string; name: string }> = [];
  const byProcess: string[] = [];
  let inherited = 0;
  for (const row of body) {
    const label = (row[0].label ?? '').trim();
    const depth = BLOCK_DEPTH.exec(label);
    const name = (depth ? depth[2] : label).trim();
    if (!name) {
      warnings.add(`${row[0].where}: la fila no tiene el nombre de una capacidad; se omite con sus marcas.`);
      continue;
    }
    const level = depth ? depth[1].length : 0;
    while (parents.length > 0 && parents[parents.length - 1].depth >= level) parents.pop();
    const parent = parents[parents.length - 1];
    if (level > 0 && parent?.depth !== level - 1) {
      warnings.add(`${row[0].where}: «${name}» tiene sangría de nivel ${level} pero no cuelga de una capacidad de nivel ${level - 1}; ${parent ? `se importa como hija de «${parent.name}»` : 'se importa sin capacidad padre'}.`);
    }
    const capability: Capability = { id: pickId(slug(name) || 'capacidad', ids), name, ...(parent ? { parentId: parent.id } : {}) };
    capabilities.push(capability);
    parents.push({ depth: level, id: capability.id, name });

    row.slice(1, columns - 1).forEach((cell, j) => {
      const mark = (cell.label ?? '').trim();
      const app = columnApps[j];
      if (!mark || !app) return;
      if (mark === MATRIX_MARKS.direct) {
        relations.push({ id: pickId(`${app.id}--supports--${capability.id}`, relationIds), kind: 'supports', sourceId: app.id, targetId: capability.id });
      } else if (mark === MATRIX_MARKS.process) byProcess.push(`«${name}» × «${app.name}»`);
      else if (mark === MATRIX_MARKS.inherited) inherited += 1;
      else warnings.add(`${cell.where}: la marca «${truncate(mark, 20)}» de «${name}» × «${app.name}» no es ${MATRIX_MARKS.direct}, ${MATRIX_MARKS.process} ni ${MATRIX_MARKS.inherited}; se omite.`);
    });
  }

  if (capabilities.length + applications.length === 0) throw new EnterpriseImportError('El diagrama de bloques no define ninguna capacidad ni aplicación que se pueda importar.');
  if (byProcess.length > 0) {
    warnings.add(`${byProcess.length} ${byProcess.length === 1 ? 'celda' : 'celdas'} ${MATRIX_MARKS.process} (soporte por un proceso que realiza la capacidad) no se importan como relaciones: la matriz no dice qué proceso es (${byProcess.slice(0, 3).join('; ')}${byProcess.length > 3 ? '…' : ''}).`);
  }
  if (inherited > 0) warnings.add(`${inherited} ${inherited === 1 ? 'celda' : 'celdas'} ${MATRIX_MARKS.inherited} (soporte heredado de una capacidad hija) no se importan: se derivan de las celdas de sus hijas.`);
  warnings.add(`Solo se importan los nombres, la jerarquía de capacidades y el soporte directo (${MATRIX_MARKS.direct}): los totales, los avisos de hueco y solapamiento y los colores se recalculan, y la criticidad, el ciclo de vida y el resto de datos de aplicaciones y capacidades no viajan en la matriz.`);

  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura empresarial';
  const result = validateEnterpriseDocument({ version: ENTERPRISE_DOCUMENT_VERSION, workspace: { name }, capabilities, applications, relations });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido a partir de la matriz:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
