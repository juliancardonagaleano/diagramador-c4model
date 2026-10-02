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
import { participationOfSymbol } from '../relations';
import { formatDataIssues, validateDataDocument } from '../schema';
import { DATA_DOCUMENT_VERSION, KIND_LABELS, PARENT_KINDS, PIPELINE_KINDS, type AssetKind, type Cardinality, type Column, type ColumnKey, type DataAsset, type DataDocument, type Pipeline, type PipelineKind, type Relation } from '../types';

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
}

/**
 * Importa un diagrama de Mermaid como documento de datos.
 * - `erDiagram`: cada entidad es una tabla con sus columnas (claves `PK`/`FK`/`UK`, comentario) y cada relación conserva su
 *   multiplicidad (`1:1`, `1:N`, `N:1`, `N:M`) y, si difiere de la habitual (`||` uno obligatorio, `o{` varios opcionales), su
 *   opcionalidad (`|o`, `}|`…) como `sourceMin` y `targetMin`.
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
      const cardinality = cardinalityOf(ev.left, ev.right);
      // La opcionalidad solo se guarda si difiere de la que la cardinalidad da por defecto (`||` obligatorio, `o{` opcional).
      const sourceMin = participationOfSymbol(ev.left, erEndIsMany(ev.left));
      const targetMin = participationOfSymbol(ev.right, erEndIsMany(ev.right));
      relations.push({
        id: pickId(`${source.id}--${target.id}`, relationIds),
        sourceId: source.id,
        targetId: target.id,
        cardinality,
        ...(ev.label ? { description: ev.label } : {}),
        ...(sourceMin !== undefined ? { sourceMin } : {}),
        ...(targetMin !== undefined ? { targetMin } : {}),
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
      else if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
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
  for (const { ref, group } of nodeInfo.values()) {
    if (groups.has(ref.alias)) continue; // una arista a un subgraph ya es el activo de ese grupo
    const label = splitLabel(ref.label ?? ref.alias);
    const kind: AssetKind = ref.shape === 'cylinder' ? 'database' : ref.shape === 'stadium' ? 'stream' : 'table';
    const parentAlias = group && groups.has(group) ? group : undefined;
    let parentId = parentAlias ? idOf.get(parentAlias) : undefined;
    if (parentAlias && !PARENT_KINDS[kind]?.includes(kindOf.get(parentAlias)!)) {
      warnings.add(`«${label.name || ref.alias}» no encaja como hijo de «${groups.get(parentAlias)!.label}»; se importa sin padre.`);
      parentId = undefined;
    }
    assets.push({ id: take(ref.alias, label.name), kind, name: label.name || ref.alias, ...(label.description ? { technology: label.description } : {}), ...(parentId ? { parentId } : {}) });
  }

  const pipelineIds = new Set<string>();
  const pipelines: Pipeline[] = [];
  const nameOf = (alias: string): string => assets.find((a) => a.id === idOf.get(alias))?.name ?? alias;
  for (const e of edges) {
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
  return { assets, pipelines, relations: [] };
}
