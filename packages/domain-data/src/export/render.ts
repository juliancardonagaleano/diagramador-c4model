import { layoutGraph, renderGraphSvg, type EdgeEnd, type GraphLayout, type GraphLayoutOptions, type ShapeKind } from '@iark/kernel';
import {
  CLASSIFICATION_LABELS,
  API_PROTOCOL_LABELS,
  KIND_LABELS,
  PIPELINE_LABELS,
  TERM_LABEL,
  TERM_STATUS_LABELS,
  hasPii,
  type AssetKind,
  type Column,
  type DataAsset,
  type DataDocument,
  type GlossaryTerm,
  type Pipeline,
  type Relation,
} from '../types';
import { listLinks, linkLabel, type DataLink, type LinkKind } from '../links';
import { findView, type DataView } from '../views';

export const KIND_COLORS: Record<AssetKind, string> = {
  source: '#64748b',
  database: '#2b8a3e',
  warehouse: '#1168bd',
  lake: '#0b7285',
  stream: '#d9480f',
  table: '#2f9e44',
  view: '#5c940d',
  file: '#868e96',
  report: '#7048e8',
  model: '#c2410c',
  'data-product': '#4338ca',
  glossary: '#a21caf',
  'data-api': '#be123c',
};

const CONTEXT_COLOR = '#94a3b8';
const PIPELINE_COLOR = '#334155';
const CLASSIFICATION_STROKE: Record<string, string> = { restricted: '#c92a2a', confidential: '#e8590c' };

const SIZES: Record<AssetKind, { width: number; height: number }> = {
  source: { width: 190, height: 76 },
  database: { width: 190, height: 84 },
  warehouse: { width: 190, height: 84 },
  lake: { width: 190, height: 84 },
  stream: { width: 180, height: 60 },
  table: { width: 180, height: 68 },
  view: { width: 180, height: 68 },
  file: { width: 180, height: 68 },
  report: { width: 180, height: 68 },
  model: { width: 180, height: 68 },
  'data-product': { width: 200, height: 84 },
  glossary: { width: 190, height: 64 },
  'data-api': { width: 180, height: 64 },
};
const PIPELINE_HEIGHT = 52;

// ───────────── términos del glosario y enlaces del catálogo ─────────────

/** Un término se dibuja como una ficha clara con el borde del color del glosario. */
export const TERM_FILL = '#fdf4ff';
export const TERM_STROKE = KIND_COLORS.glossary;
/** Todas las fichas de términos miden lo mismo de ancho; el alto depende de las líneas de la definición. */
export const TERM_WIDTH = 240;
const TERM_WRAP = 36;
const TERM_DEFINITION_LINES = 2;

/** Parte un texto en líneas de hasta `max` caracteres, por palabras, y abrevia con «…» lo que no cabe en `lines` líneas. */
function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let rest = text.trim().replace(/\s+/g, ' ');
  while (rest.length > 0 && out.length < lines) {
    if (rest.length <= max) {
      out.push(rest);
      rest = '';
      break;
    }
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) out[out.length - 1] = `${out[out.length - 1].slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return out;
}

/** Líneas de un término: su nombre, su definición en hasta dos líneas y su estado y responsable. */
export function termLines(t: GlossaryTerm): string[] {
  const meta = [t.status ? TERM_STATUS_LABELS[t.status] : '', t.owner ?? ''].filter(Boolean).join(' · ');
  return [t.name, ...wrap(t.definition ?? '', TERM_WRAP, TERM_DEFINITION_LINES), meta].filter(Boolean);
}

/** Alto de la ficha de un término: la insignia, el nombre, la definición y la línea de estado. */
const termHeight = (lines: string[]): number => Math.max(64, 14 + (lines.length + 1) * 15);

/** Detalle de un activo del catálogo: la frescura y el SLA de un producto, el protocolo y la dirección de una API, cuántos términos tiene un glosario. */
export function catalogLine(a: DataAsset, termCount = 0): string {
  if (a.kind === 'data-product') return [a.freshness ? `frescura ${a.freshness}` : '', a.sla ?? ''].filter(Boolean).join(' · ');
  if (a.kind === 'data-api') return [a.protocol ? API_PROTOCOL_LABELS[a.protocol] : '', a.endpoint ?? ''].filter(Boolean).join(' · ');
  if (a.kind === 'glossary') return termCount > 0 ? `${termCount} ${termCount === 1 ? 'término' : 'términos'}` : '';
  return '';
}

/** Estilo de las flechas del catálogo: las de producto en su color, la exposición de una API discontinua y el enlace de un término discontinuo y abierto. */
export const LINK_STYLES: Record<LinkKind, { stroke: string; dashed?: boolean; head?: 'open' }> = {
  consumes: { stroke: KIND_COLORS['data-product'] },
  publishes: { stroke: KIND_COLORS['data-product'] },
  exposes: { stroke: KIND_COLORS['data-api'], dashed: true },
  defines: { stroke: KIND_COLORS.glossary, dashed: true, head: 'open' },
};

/** Ancho que necesita un nodo para que su texto (título en negrita + líneas) no se recorte, entre `min` y 300 px. */
function widthFor(title: string, rest: string[], min: number): number {
  const widest = Math.max(title.length * 7.2, ...rest.map((l) => l.length * 6.2));
  return Math.min(300, Math.max(min, Math.ceil(widest + 32)));
}

/** Columnas que se dibujan en una ficha del modelo entidad-relación (el resto se resume). */
export const MAX_COLUMNS = 12;

export const pipelineNodeId = (id: string): string => `pipeline:${id}`;

export function columnLine(c: Column): string {
  const keys = (c.keys ?? []).map((k) => k.toUpperCase()).join(',');
  return `${keys ? `${keys} ` : ''}${c.name}${c.type ? `: ${c.type}` : ''}${c.pii ? ' (PII)' : ''}`;
}

/** Líneas de la ficha de una entidad: nombre, columnas (hasta `MAX_COLUMNS`) y cuántas quedan. */
export function entityLines(a: DataAsset): string[] {
  const columns = a.columns ?? [];
  return [a.name, ...columns.slice(0, MAX_COLUMNS).map(columnLine), ...(columns.length > MAX_COLUMNS ? [`… +${columns.length - MAX_COLUMNS} columnas`] : [])];
}

function entitySize(a: DataAsset): { width: number; height: number } {
  const lines = entityLines(a);
  const widest = Math.max(...lines.map((l) => l.length));
  return { width: Math.min(340, Math.max(180, Math.ceil(widest * 6.6 + 28))), height: Math.max(56, 40 + (lines.length - 1) * 15) };
}

/** Columnas afectadas de un activo en una vista de impacto de columna: la de partida (●) primero y las demás (▸), con el PII a la vista. */
export function impactColumnLines(view: DataView, a: DataAsset): string[] {
  const names = view.column?.byAsset[a.id] ?? [];
  const start = view.column?.start;
  return names.map((name) => {
    const column = (a.columns ?? []).find((c) => c.name === name);
    return `${start && start.assetId === a.id && start.column === name ? '●' : '▸'} ${name}${column?.type ? `: ${column.type}` : ''}${column?.pii ? ' (PII)' : ''}`;
  });
}

/** Línea de gobierno de un activo: datos personales y clasificación. */
export function governanceLine(a: DataAsset): string {
  return [hasPii(a) ? 'PII' : '', a.classification ? CLASSIFICATION_LABELS[a.classification] : ''].filter(Boolean).join(' · ');
}

export function pipelineLine(p: Pipeline): string {
  return [PIPELINE_LABELS[p.kind], p.schedule].filter(Boolean).join(' · ');
}

/** Extremos de pata de gallo de una relación: `1` = uno, `N` o `M` = varios (`1:N` = un origen, varios destinos). */
export function relationEnds(r: Relation): { source: EdgeEnd; target: EdgeEnd } {
  const [from, to] = r.cardinality.split(':');
  return { source: from === '1' ? 'one' : 'many', target: to === '1' ? 'one' : 'many' };
}

export function relationLabel(r: Relation): string {
  return r.description ? `${r.description} (${r.cardinality})` : r.cardinality;
}

export function colorOf(a: DataAsset, context = false): string {
  return context ? CONTEXT_COLOR : KIND_COLORS[a.kind];
}

export function strokeOf(a: DataAsset): string {
  return (a.classification && CLASSIFICATION_STROKE[a.classification]) || '#0f172a55';
}

/** Arista del layout: une dos nodos y pertenece a un pipeline, a una relación o a un enlace del catálogo. */
export interface RenderedEdge {
  source: string;
  target: string;
  pipeline?: Pipeline;
  relation?: Relation;
  link?: DataLink;
}

export interface RenderedView {
  view: DataView;
  layout: GraphLayout;
  assets: Map<string, DataAsset>;
  /** Nodo del layout → pipeline que representa. */
  pipelineNodes: Map<string, Pipeline>;
  /** Nodo del layout → término del glosario que representa. */
  termNodes: Map<string, GlossaryTerm>;
  /** Id de arista del layout → sus extremos y a qué pertenece. */
  edges: Map<string, RenderedEdge>;
  contextIds: Set<string>;
}

/** Coloca una vista con el autolayout genérico del kernel. Los activos con contenido en la vista se dibujan como agrupaciones. */
export async function layoutView(doc: DataDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const assets = new Map(doc.assets.filter((a) => view.assetIds.includes(a.id)).map((a) => [a.id, a]));
  const erd = view.type === 'erd';
  // El ERD, el mapa de productos y el glosario dibujan fichas sueltas; el resto agrupa cada activo con su contenedor cuando ambos están en la vista.
  const flat = erd || view.type === 'products' || view.type === 'glossary';
  const terms = (doc.terms ?? []).filter((t) => view.termIds.includes(t.id));
  // Un glosario con términos en la vista se dibuja como zona que los contiene.
  const glossaryOf = (t: GlossaryTerm): string | undefined => (t.glossaryId !== undefined && assets.get(t.glossaryId)?.kind === 'glossary' ? t.glossaryId : undefined);

  const groupIds = flat ? new Set<string>(terms.flatMap((t) => glossaryOf(t) ?? [])) : new Set([...assets.values()].filter((a) => a.parentId && assets.has(a.parentId)).map((a) => a.parentId as string));
  const parentOf = (a: DataAsset): string | undefined => (!flat && a.parentId && assets.has(a.parentId) ? a.parentId : undefined);

  const assetSize = (a: DataAsset): { width: number; height: number } => {
    if (erd) return entitySize(a);
    if (view.column?.byAsset[a.id]) {
      const lines = impactColumnLines(view, a);
      return { width: widthFor(a.name, lines, 190), height: 56 + lines.length * 16 };
    }
    const size = SIZES[a.kind];
    return { ...size, width: widthFor(a.name, [catalogLine(a), a.technology ?? '', governanceLine(a)], size.width) };
  };
  const nodes = [...assets.values()].filter((a) => !groupIds.has(a.id)).map((a) => ({ id: a.id, ...assetSize(a), groupId: parentOf(a) }));
  const groups = [...groupIds].map((id) => ({ id, groupId: parentOf(assets.get(id)!) }));
  const edges = new Map<string, RenderedEdge>();
  const pipelineNodes = new Map<string, Pipeline>();
  const termNodes = new Map<string, GlossaryTerm>();

  for (const p of doc.pipelines.filter((x) => view.pipelineIds.includes(x.id))) {
    const node = pipelineNodeId(p.id);
    pipelineNodes.set(node, p);
    // Un pipeline cuyas entradas y salidas están en un mismo contenedor (bronce → plata en un lago) se dibuja dentro de él.
    const parents = new Set([...p.inputs, ...p.outputs].map((id) => (assets.has(id) ? parentOf(assets.get(id)!) : undefined)));
    const [common] = parents.size === 1 ? parents : [];
    nodes.push({ id: node, width: widthFor(p.name, [pipelineLine(p), p.tool ?? ''], 190), height: PIPELINE_HEIGHT, groupId: common });
    for (const id of p.inputs) edges.set(`in:${p.id}:${id}`, { source: id, target: node, pipeline: p });
    for (const id of p.outputs) edges.set(`out:${p.id}:${id}`, { source: node, target: id, pipeline: p });
  }
  for (const r of doc.relations.filter((x) => view.relationIds.includes(x.id))) edges.set(r.id, { source: r.sourceId, target: r.targetId, relation: r });
  for (const t of terms) {
    const lines = termLines(t);
    termNodes.set(t.id, t);
    nodes.push({ id: t.id, width: TERM_WIDTH, height: termHeight(lines), groupId: glossaryOf(t) });
  }
  for (const l of listLinks(doc).filter((x) => view.linkIds.includes(x.id))) edges.set(l.id, { source: l.source, target: l.target, link: l });

  const layout = await layoutGraph(
    nodes,
    [...edges].map(([id, e]) => ({ id, source: e.source, target: e.target, label: e.relation ? relationLabel(e.relation) : e.link ? linkLabel(e.link) : undefined })),
    groups,
    { direction: 'RIGHT', ...options },
  );
  return { view, layout, assets, pipelineNodes, termNodes, edges, contextIds: new Set(view.contextIds) };
}

/** Figura de cada clase de activo: la misma en el lienzo interactivo y en el SVG exportado. */
export const ASSET_SHAPES: Record<AssetKind, ShapeKind> = {
  source: 'rect',
  database: 'cylinder',
  warehouse: 'cylinder',
  lake: 'rounded',
  stream: 'pipe',
  table: 'card',
  view: 'card',
  file: 'document',
  report: 'rect',
  model: 'hexagon',
  'data-product': 'cube',
  glossary: 'bar',
  'data-api': 'pill',
};
export const TERM_SHAPE: ShapeKind = 'rect';
export const PIPELINE_SHAPE: ShapeKind = 'chevron';

export async function toSvg(doc: DataDocument, viewId?: string): Promise<string> {
  const { view, layout, assets, pipelineNodes, termNodes, edges, contextIds } = await layoutView(doc, viewId);
  const erd = view.type === 'erd';
  const termCount = (glossaryId: string): number => (doc.terms ?? []).filter((t) => t.glossaryId === glossaryId).length;
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => {
      const term = termNodes.get(id);
      if (term) return { fill: TERM_FILL, stroke: TERM_STROKE, textColor: '#0f172a', badge: TERM_LABEL, lines: termLines(term), maxLines: 5, shape: TERM_SHAPE };
      const p = pipelineNodes.get(id);
      if (p) return { fill: PIPELINE_COLOR, stroke: '#0f172a55', lines: [p.name, pipelineLine(p), p.tool ?? ''].filter(Boolean), shape: PIPELINE_SHAPE };
      const a = assets.get(id)!;
      const context = contextIds.has(id);
      if (view.column?.byAsset[id]) {
        return { fill: '#ffffff', stroke: KIND_COLORS[a.kind], textColor: '#0f172a', align: 'left', maxLines: MAX_COLUMNS + 2, badge: KIND_LABELS[a.kind], lines: [a.name, ...impactColumnLines(view, a)], dashed: context };
      }
      if (erd) {
        return { fill: '#ffffff', stroke: KIND_COLORS[a.kind], textColor: '#0f172a', align: 'left', maxLines: MAX_COLUMNS + 2, badge: KIND_LABELS[a.kind], lines: entityLines(a) };
      }
      return {
        fill: colorOf(a, context),
        stroke: strokeOf(a),
        badge: KIND_LABELS[a.kind],
        lines: [a.name, catalogLine(a, termCount(a.id)), a.technology ?? '', governanceLine(a)].filter(Boolean),
        shape: ASSET_SHAPES[a.kind],
        dashed: a.external || context,
      };
    },
    edge: (id) => {
      const { relation, pipeline, link } = edges.get(id)!;
      if (link) return { ...LINK_STYLES[link.kind], label: linkLabel(link), width: 1.5 };
      if (relation) return { stroke: '#475569', label: relationLabel(relation), ends: relationEnds(relation) };
      return { stroke: '#475569', dashed: isDashed(pipeline), width: 1.5 };
    },
    group: (id) => ({ label: `${KIND_LABELS[assets.get(id)!.kind]}: ${assets.get(id)!.name}`, ...(assets.get(id)!.kind === 'glossary' ? { stroke: TERM_STROKE } : {}) }),
  });
}

/** Los pipelines continuos (streaming y CDC) se dibujan con línea discontinua. */
export const isDashed = (p: Pipeline | undefined): boolean => p?.kind === 'streaming' || p?.kind === 'cdc';
