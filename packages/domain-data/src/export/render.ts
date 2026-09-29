import { layoutGraph, renderGraphSvg, type GraphLayout, type GraphLayoutOptions } from '@iark/kernel';
import {
  CLASSIFICATION_LABELS,
  KIND_LABELS,
  PIPELINE_LABELS,
  hasPii,
  type AssetKind,
  type Column,
  type DataAsset,
  type DataDocument,
  type Pipeline,
  type Relation,
} from '../types';
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
};
const PIPELINE_HEIGHT = 52;

/** Ancho que necesita un nodo para que su texto (título en negrita + líneas) no se recorte, entre `min` y 300 px. */
function widthFor(title: string, rest: string[], min: number): number {
  const widest = Math.max(title.length * 7.2, ...rest.map((l) => l.length * 6.2));
  return Math.min(300, Math.max(min, Math.ceil(widest + 32)));
}

/** Columnas que se dibujan en una ficha del modelo entidad-relación (el resto se resume). */
const MAX_COLUMNS = 12;

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

/** Línea de gobierno de un activo: datos personales y clasificación. */
export function governanceLine(a: DataAsset): string {
  return [hasPii(a) ? 'PII' : '', a.classification ? CLASSIFICATION_LABELS[a.classification] : ''].filter(Boolean).join(' · ');
}

export function pipelineLine(p: Pipeline): string {
  return [PIPELINE_LABELS[p.kind], p.schedule].filter(Boolean).join(' · ');
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

/** Arista del layout: une dos nodos y pertenece a un pipeline o a una relación. */
export interface RenderedEdge {
  source: string;
  target: string;
  pipeline?: Pipeline;
  relation?: Relation;
}

export interface RenderedView {
  view: DataView;
  layout: GraphLayout;
  assets: Map<string, DataAsset>;
  /** Nodo del layout → pipeline que representa. */
  pipelineNodes: Map<string, Pipeline>;
  /** Id de arista del layout → sus extremos y a qué pertenece. */
  edges: Map<string, RenderedEdge>;
  contextIds: Set<string>;
}

/** Coloca una vista con el autolayout genérico del kernel. Los activos con contenido en la vista se dibujan como agrupaciones. */
export async function layoutView(doc: DataDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const assets = new Map(doc.assets.filter((a) => view.assetIds.includes(a.id)).map((a) => [a.id, a]));
  const erd = view.type === 'erd';

  // El ERD dibuja fichas sueltas; el resto agrupa cada activo con su contenedor cuando ambos están en la vista.
  const groupIds = erd ? new Set<string>() : new Set([...assets.values()].filter((a) => a.parentId && assets.has(a.parentId)).map((a) => a.parentId as string));
  const parentOf = (a: DataAsset): string | undefined => (!erd && a.parentId && assets.has(a.parentId) ? a.parentId : undefined);

  const assetSize = (a: DataAsset): { width: number; height: number } => {
    if (erd) return entitySize(a);
    const size = SIZES[a.kind];
    return { ...size, width: widthFor(a.name, [a.technology ?? '', governanceLine(a)], size.width) };
  };
  const nodes = [...assets.values()].filter((a) => !groupIds.has(a.id)).map((a) => ({ id: a.id, ...assetSize(a), groupId: parentOf(a) }));
  const groups = [...groupIds].map((id) => ({ id, groupId: parentOf(assets.get(id)!) }));
  const edges = new Map<string, RenderedEdge>();
  const pipelineNodes = new Map<string, Pipeline>();

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

  const layout = await layoutGraph(
    nodes,
    [...edges].map(([id, e]) => ({ id, source: e.source, target: e.target, label: e.relation ? relationLabel(e.relation) : undefined })),
    groups,
    { direction: 'RIGHT', ...options },
  );
  return { view, layout, assets, pipelineNodes, edges, contextIds: new Set(view.contextIds) };
}

export async function toSvg(doc: DataDocument, viewId?: string): Promise<string> {
  const { view, layout, assets, pipelineNodes, edges, contextIds } = await layoutView(doc, viewId);
  const erd = view.type === 'erd';
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => {
      const p = pipelineNodes.get(id);
      if (p) return { fill: PIPELINE_COLOR, stroke: '#0f172a55', lines: [p.name, pipelineLine(p), p.tool ?? ''].filter(Boolean), shape: 'pill' };
      const a = assets.get(id)!;
      const context = contextIds.has(id);
      if (erd) {
        return { fill: '#ffffff', stroke: KIND_COLORS[a.kind], textColor: '#0f172a', align: 'left', maxLines: MAX_COLUMNS + 2, badge: KIND_LABELS[a.kind], lines: entityLines(a) };
      }
      return {
        fill: colorOf(a, context),
        stroke: strokeOf(a),
        badge: KIND_LABELS[a.kind],
        lines: [a.name, a.technology ?? '', governanceLine(a)].filter(Boolean),
        shape: a.kind === 'database' || a.kind === 'warehouse' || a.kind === 'lake' ? 'cylinder' : a.kind === 'stream' ? 'pill' : 'rect',
        dashed: a.external || context,
      };
    },
    edge: (id) => {
      const { relation, pipeline } = edges.get(id)!;
      if (relation) return { stroke: '#475569', label: relationLabel(relation) };
      return { stroke: '#475569', dashed: isDashed(pipeline), width: 1.5 };
    },
    group: (id) => ({ label: `${KIND_LABELS[assets.get(id)!.kind]}: ${assets.get(id)!.name}` }),
  });
}

/** Los pipelines continuos (streaming y CDC) se dibujan con línea discontinua. */
export const isDashed = (p: Pipeline | undefined): boolean => p?.kind === 'streaming' || p?.kind === 'cdc';
