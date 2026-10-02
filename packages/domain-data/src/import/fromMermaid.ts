import {
  detectMermaidKind,
  erEndIsMany,
  MERMAID_DIAGRAM_KINDS,
  ModuleError,
  parseEr,
  parseFlowchart,
  pickId,
  preprocessMermaid,
  splitLabel,
  Warnings,
  type FlowLineStyle,
  type FlowNodeRef,
  type MermaidLine,
} from '@iark/kernel';
import { exposeViolation, portViolation, termLinkViolation } from '../links';
import { formatDataIssues, validateDataDocument } from '../schema';
import {
  API_PROTOCOLS,
  DATA_DOCUMENT_VERSION,
  KIND_LABELS,
  PARENT_KINDS,
  PIPELINE_KINDS,
  TERM_STATUSES,
  TERM_STATUS_LABELS,
  type ApiProtocol,
  type AssetKind,
  type Cardinality,
  type Column,
  type ColumnKey,
  type DataAsset,
  type DataDocument,
  type GlossaryTerm,
  type Pipeline,
  type PipelineKind,
  type Relation,
  type TermStatus,
} from '../types';

export class DataImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'DataImportError';
  }
}

export interface DataImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface DataImportResult {
  document: DataDocument;
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

interface Built {
  assets: DataAsset[];
  pipelines: Pipeline[];
  relations: Relation[];
  terms?: GlossaryTerm[];
}

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

type CatalogEntity = 'data-product' | 'data-api' | 'glossary' | 'term';

/** Clases de Mermaid que identifican los tipos del catálogo (las que escribe el exportador y sus equivalentes en español). */
const CATALOG_CLASS_KINDS: Record<string, CatalogEntity> = {
  dataproduct: 'data-product',
  producto: 'data-product',
  productodedatos: 'data-product',
  dataapi: 'data-api',
  api: 'data-api',
  apidedatos: 'data-api',
  glossary: 'glossary',
  glosario: 'glossary',
  term: 'term',
  termino: 'term',
};

const catalogOf = (ref: FlowNodeRef): CatalogEntity | undefined => (ref.classes ?? []).map((c) => CATALOG_CLASS_KINDS[normalize(c)]).find((k) => k !== undefined);

const PROTOCOL_BY_NAME = new Map<string, ApiProtocol>(API_PROTOCOLS.map((p) => [p, p]));
const STATUS_BY_LABEL = new Map<string, TermStatus>([...TERM_STATUSES.map((t) => [TERM_STATUS_LABELS[t], t] as const), ...TERM_STATUSES.map((t) => [t, t] as const)]);

/** Partes de la etiqueta de un nodo (separadas por `<br/>`), sin comillas ni etiquetas HTML. */
const labelParts = (raw: string | undefined, fallback: string): string[] => {
  const parts = (raw ?? fallback)
    .replace(/^"|"$/g, '')
    .split(/<br\s*\/?>|\\n/i)
    .map((p) => p.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [fallback];
};

/** Lo que el exportador escribe tras el nombre de un producto o una API: frescura, SLA, protocolo, dirección y, al final, la tecnología. */
function catalogFields(kind: 'data-product' | 'data-api', rest: string[]): Partial<DataAsset> {
  const out: Partial<DataAsset> = {};
  const other: string[] = [];
  for (const part of rest) {
    const freshness = kind === 'data-product' ? /^frescura\s+(.+)$/i.exec(part) : null;
    const sla = kind === 'data-product' ? /^SLA:\s*(.+)$/i.exec(part) : null;
    if (freshness) out.freshness = freshness[1];
    else if (sla) out.sla = sla[1];
    else if (kind === 'data-api' && PROTOCOL_BY_NAME.has(normalize(part)) && !out.protocol) out.protocol = PROTOCOL_BY_NAME.get(normalize(part));
    else if (kind === 'data-api' && /^(https?|wss?|grpc):\/\/\S+$|^\/\S*$/i.test(part) && !out.endpoint) out.endpoint = part;
    else other.push(part);
  }
  if (other.length > 0) out.technology = other.join(' ');
  return out;
}

/** Un término: nombre, definición y, si el último tramo es `estado · responsable`, su estado y su responsable. */
function termFields(parts: string[]): Pick<GlossaryTerm, 'name' | 'definition' | 'status' | 'owner'> {
  const [name, ...rest] = parts;
  const meta = rest.length > 0 ? /^(borrador|aprobado|obsoleto|draft|approved|deprecated)(?:\s*·\s*(.+))?$/i.exec(rest[rest.length - 1]) : null;
  const definition = (meta ? rest.slice(0, -1) : rest).join(' ');
  return { name, ...(definition ? { definition } : {}), ...(meta ? { status: STATUS_BY_LABEL.get(meta[1].toLowerCase()) } : {}), ...(meta?.[2] ? { owner: meta[2] } : {}) };
}

/**
 * Importa un diagrama de Mermaid como documento de datos.
 * - `erDiagram`: cada entidad es una tabla con sus columnas (claves `PK`/`FK`/`UK`, comentario) y cada relación conserva su
 *   multiplicidad (`1:1`, `1:N`, `N:1`, `N:M`); la opcionalidad no se conserva.
 * - `flowchart` / `graph`: linaje. `[( )]` = base de datos, `([ ])` = stream y el resto tablas; cada arista, con sus
 *   entradas y salidas (`A & B --> C`), es un pipeline: continua = por lotes, punteada = streaming, gruesa = CDC (o el
 *   tipo entre corchetes al final de la etiqueta, `"Carga diaria [elt]"`). Un `subgraph` es un contenedor.
 */
export function fromMermaid(source: string, options: DataImportOptions = {}): DataImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new DataImportError('El texto de Mermaid está vacío.');
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart' && kind !== 'er') {
    throw new DataImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como datos. Se admiten flowchart/graph y erDiagram.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const body = lines.slice(1);
  const built = kind === 'er' ? fromEr(body, warnings) : fromFlowchart(body, warnings);
  if (built.assets.length === 0) throw new DataImportError('El diagrama de Mermaid no define ningún activo que se pueda importar.');
  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura de datos';
  const result = validateDataDocument({ version: DATA_DOCUMENT_VERSION, workspace: { name }, domains: [], ...built });
  if (!result.ok) throw new DataImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatDataIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}

function cardinalityOf(left: string, right: string): Cardinality {
  const [l, r] = [erEndIsMany(left), erEndIsMany(right)];
  return l ? (r ? 'N:M' : 'N:1') : r ? '1:N' : '1:1';
}

function fromEr(lines: MermaidLine[], warnings: Warnings): Built {
  const ids = new Set<string>();
  const relationIds = new Set<string>();
  const idOf = new Map<string, string>();
  const assets = new Map<string, DataAsset>();
  const relations: Relation[] = [];
  const ensure = (alias: string, label?: string): DataAsset => {
    let asset = assets.get(alias);
    if (!asset) {
      const id = pickId(slug(alias) || slug(label ?? '') || 'entidad', ids);
      idOf.set(alias, id);
      asset = { id, kind: 'table', name: label || alias };
      assets.set(alias, asset);
    } else if (label) asset.name = label;
    return asset;
  };

  for (const ev of parseEr(lines)) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'entity') ensure(ev.entity.alias, ev.entity.label);
    else if (ev.type === 'attribute') {
      if (!ev.name) {
        warnings.add(`${ev.where}: no se entiende la columna «${ev.raw}»; se omite.`);
        continue;
      }
      const asset = ensure(ev.entity);
      // El exportador añade «PII» al comentario de las columnas con datos personales.
      const pii = ev.comment !== undefined && /(^|\s·\s)PII$/.test(ev.comment);
      const description = ev.comment?.replace(/(^|\s·\s)PII$/, '').trim();
      const column: Column = {
        name: ev.name,
        ...(ev.attrType && ev.attrType !== 'string' ? { type: ev.attrType } : {}),
        ...(ev.keys.length > 0 ? { keys: ev.keys.map((k) => k.toLowerCase() as ColumnKey) } : {}),
        ...(pii ? { pii: true } : {}),
        ...(description ? { description } : {}),
      };
      asset.columns = [...(asset.columns ?? []), column];
    } else {
      const source = ensure(ev.from.alias, ev.from.label);
      const target = ensure(ev.to.alias, ev.to.label);
      if (source.id === target.id) {
        warnings.add(`${ev.where}: «${ev.from.alias}» se relaciona consigo mismo; el modelo de datos no admite relaciones recursivas, se omite.`);
        continue;
      }
      relations.push({
        id: pickId(`${source.id}--${target.id}`, relationIds),
        sourceId: source.id,
        targetId: target.id,
        cardinality: cardinalityOf(ev.left, ev.right),
        ...(ev.label ? { description: ev.label } : {}),
      });
    }
  }
  return { assets: [...assets.values()], pipelines: [], relations };
}

/** Tipo de contenedor a partir del prefijo que le pone el exportador («Data lake: Bronce»). */
function containerKind(label: string): { kind: AssetKind | undefined; name: string } {
  for (const [kind, text] of Object.entries(KIND_LABELS)) {
    const m = new RegExp(`^${text}:\\s+(.+)$`, 'i').exec(label);
    if (m) return { kind: kind as AssetKind, name: m[1] };
  }
  return { kind: undefined, name: label };
}

function fromFlowchart(lines: MermaidLine[], warnings: Warnings): Built {
  interface Group {
    alias: string;
    label: string;
    parent?: string;
  }
  const groups = new Map<string, Group>();
  const nodeInfo = new Map<string, { ref: FlowNodeRef; group?: string }>();
  const edges: Array<{ from: string[]; to: string[]; label?: string; line: FlowLineStyle; where: string }> = [];
  const stack: string[] = [];

  for (const ev of parseFlowchart(lines)) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      groups.set(ev.alias, { alias: ev.alias, label: ev.label, parent: stack[stack.length - 1] });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      const known = nodeInfo.get(ev.node.alias);
      if (!known) nodeInfo.set(ev.node.alias, { ref: { ...ev.node }, group: stack[stack.length - 1] });
      else {
        const classes = [...new Set([...(known.ref.classes ?? []), ...(ev.node.classes ?? [])])];
        known.ref = { ...known.ref, ...(ev.node.label !== undefined ? { label: ev.node.label, shape: ev.node.shape ?? known.ref.shape } : {}), ...(classes.length > 0 ? { classes } : {}) };
      }
    } else {
      const from = ev.from.map((n) => n.alias);
      const to = ev.to.map((n) => n.alias);
      edges.push({ from, to, label: ev.label, line: ev.line, where: ev.where });
      if (ev.bidirectional) edges.push({ from: to, to: from, label: ev.label, line: ev.line, where: ev.where });
    }
  }

  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const assets: DataAsset[] = [];
  const take = (alias: string, label: string): string => {
    const id = pickId(slug(alias) || slug(label) || 'activo', ids);
    idOf.set(alias, id);
    return id;
  };
  const kindOf = new Map<string, AssetKind>();
  for (const g of groups.values()) {
    const { kind, name } = containerKind(splitLabel(g.label).name);
    if (!kind) warnings.add(`El subgraph «${g.label}» se importa como base de datos; ajusta su tipo si es otro.`);
    if (g.parent && groups.has(g.parent)) warnings.add(`El subgraph «${g.label}» está anidado: en datos se aplana y no tendrá padre.`);
    kindOf.set(g.alias, kind ?? 'database');
    assets.push({ id: take(g.alias, name), kind: kind ?? 'database', name: name || g.alias });
  }
  const terms: GlossaryTerm[] = [];
  const kindByAlias = new Map<string, AssetKind | 'term'>();
  for (const { ref, group } of nodeInfo.values()) {
    if (groups.has(ref.alias)) continue; // una arista a un subgraph ya es el activo de ese grupo
    const catalog = catalogOf(ref);
    if (catalog === 'term') {
      const fields = termFields(labelParts(ref.label, ref.alias));
      const glossary = group && groups.has(group) && kindOf.get(group) === 'glossary' ? idOf.get(group) : undefined;
      kindByAlias.set(ref.alias, 'term');
      terms.push({ id: take(ref.alias, fields.name), ...fields, ...(glossary ? { glossaryId: glossary } : {}) });
      continue;
    }
    const label = splitLabel(ref.label ?? ref.alias);
    const kind: AssetKind = catalog ?? (ref.shape === 'cylinder' ? 'database' : ref.shape === 'stadium' ? 'stream' : 'table');
    const parentAlias = group && groups.has(group) ? group : undefined;
    let parentId = parentAlias ? idOf.get(parentAlias) : undefined;
    if (parentAlias && !PARENT_KINDS[kind]?.includes(kindOf.get(parentAlias)!)) {
      warnings.add(`«${label.name || ref.alias}» no encaja como hijo de «${groups.get(parentAlias)!.label}»; se importa sin padre.`);
      parentId = undefined;
    }
    kindByAlias.set(ref.alias, kind);
    const extra = kind === 'data-product' || kind === 'data-api' ? catalogFields(kind, labelParts(ref.label, ref.alias).slice(1)) : label.description ? { technology: label.description } : {};
    assets.push({ id: take(ref.alias, label.name), kind, name: label.name || ref.alias, ...extra, ...(parentId ? { parentId } : {}) });
  }
  for (const g of groups.values()) kindByAlias.set(g.alias, kindOf.get(g.alias)!);

  const pipelineIds = new Set<string>();
  const pipelines: Pipeline[] = [];
  const nameOf = (alias: string): string => assets.find((a) => a.id === idOf.get(alias))?.name ?? terms.find((t) => t.id === idOf.get(alias))?.name ?? alias;
  const catalogKinds = new Set<AssetKind | 'term' | undefined>(['data-product', 'data-api', 'glossary', 'term']);
  for (const e of edges) {
    // Una flecha que toca un producto, una API, un glosario o un término no es un pipeline: son puertos, exposiciones y enlaces.
    if ([...e.from, ...e.to].some((a) => catalogKinds.has(kindByAlias.get(a)))) {
      linkCatalog(e, { assets, terms, idOf, kindByAlias, warnings, nameOf });
      continue;
    }
    const inputs = e.from.map((a) => idOf.get(a));
    const outputs = e.to.map((a) => idOf.get(a));
    if (inputs.some((i) => !i) || outputs.some((o) => !o) || inputs.some((i) => outputs.includes(i))) {
      warnings.add(`${e.where}: la arista ${e.from.join(' & ')} → ${e.to.join(' & ')} no se puede importar; se omite.`);
      continue;
    }
    const label = e.label ? splitLabel(e.label).name : '';
    const tagged = /^(.*?)\s*\[([a-z]+)\]$/.exec(label);
    const tag = tagged && (PIPELINE_KINDS as readonly string[]).includes(tagged[2]) ? (tagged[2] as PipelineKind) : undefined;
    const name = (tag ? tagged![1] : label) || `${e.from.map(nameOf).join(' + ')} → ${e.to.map(nameOf).join(' + ')}`;
    const kind: PipelineKind = tag ?? (e.line === 'dotted' ? 'streaming' : e.line === 'thick' ? 'cdc' : 'batch');
    pipelines.push({ id: pickId(slug(name) || 'pipeline', pipelineIds), name, kind, inputs: inputs as string[], outputs: outputs as string[] });
  }
  return { assets, pipelines, relations: [], ...(terms.length > 0 ? { terms } : {}) };
}

interface CatalogContext {
  assets: DataAsset[];
  terms: GlossaryTerm[];
  idOf: Map<string, string>;
  kindByAlias: Map<string, AssetKind | 'term'>;
  warnings: Warnings;
  nameOf: (alias: string) => string;
}

/** Aplica una flecha del flowchart que toca el catálogo: puertos de un producto, activos servidos por una API o enlaces de un término. */
function linkCatalog(e: { from: string[]; to: string[]; label?: string; where: string }, ctx: CatalogContext): void {
  const { assets, terms, idOf, kindByAlias, warnings, nameOf } = ctx;
  const asset = (alias: string): DataAsset | undefined => assets.find((a) => a.id === idOf.get(alias));
  const label = e.label ? labelParts(e.label, '')[0] : '';
  const column = /^define\s*·\s*(.+)$/i.exec(label)?.[1];
  const add = (list: string[] | undefined, id: string): string[] => (list?.includes(id) ? list : [...(list ?? []), id]);
  const skip = (from: string, to: string, why: string): void => warnings.add(`${e.where}: la flecha ${nameOf(from)} → ${nameOf(to)} no se importa: ${why}`);
  for (const from of e.from) {
    for (const to of e.to) {
      const [kf, kt] = [kindByAlias.get(from), kindByAlias.get(to)];
      const [a, b] = [asset(from), asset(to)];
      if (kf === 'term' || kt === 'term') {
        const term = terms.find((t) => t.id === idOf.get(kf === 'term' ? from : to));
        const target = kf === 'term' ? b : a;
        if (!term || !target) skip(from, to, 'un término solo se enlaza con un activo.');
        else if (termLinkViolation(target)) skip(from, to, termLinkViolation(target)!);
        else if (!(term.links ?? []).some((l) => l.assetId === target.id && l.column === column)) term.links = [...(term.links ?? []), { assetId: target.id, ...(column ? { column } : {}) }];
      } else if (!a || !b) skip(from, to, 'el activo no se reconoce.');
      else if (kt === 'data-product') {
        const why = portViolation(b, a);
        if (why) skip(from, to, why);
        else if (b.outputPorts?.includes(a.id)) skip(from, to, 'ya es una salida de ese producto.');
        else b.inputPorts = add(b.inputPorts, a.id);
      } else if (kf === 'data-product') {
        const why = portViolation(a, b);
        if (why) skip(from, to, why);
        else if (a.inputPorts?.includes(b.id)) skip(from, to, 'ya es una entrada de ese producto.');
        else a.outputPorts = add(a.outputPorts, b.id);
      } else if (kt === 'data-api' || kf === 'data-api') {
        const [api, exposed] = kt === 'data-api' ? [b, a] : [a, b];
        const why = exposeViolation(api, exposed);
        if (why) skip(from, to, why);
        else api.exposes = add(api.exposes, exposed.id);
      } else skip(from, to, 'un glosario agrupa términos, no se conecta con activos.');
    }
  }
}
