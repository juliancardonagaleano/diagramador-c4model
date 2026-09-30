import { layoutGraph, renderGraphSvg, type Box, type GraphLayout, type GraphLayoutOptions, type ShapeKind, type SvgNodeStyle } from '@iark/kernel';
import { applicationsByCapability, capabilityChildren } from '../graph';
import {
  CRITICALITY_LABELS,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  LIFECYCLE_LABELS,
  TECHNOLOGY_KIND_LABELS,
  drawnEnds,
  indexElements,
  lifecycleOf,
  type Application,
  type Capability,
  type Element,
  type ElementKind,
  type EnterpriseDocument,
  type Lifecycle,
  type Process,
  type Relation,
  type Technology,
} from '../types';
import { findView, type EnterpriseView } from '../views';

export const KIND_COLORS: Record<ElementKind, string> = {
  unit: '#64748b',
  capability: '#0b7285',
  process: '#7048e8',
  application: '#1168bd',
  technology: '#2f9e44',
};

/** Figura de cada tipo de elemento (notación de capas al estilo ArchiMate): la misma en el lienzo y en el SVG. */
export const ELEMENT_SHAPES: Record<ElementKind, ShapeKind> = { unit: 'rect', capability: 'rounded', process: 'chevron', application: 'rect', technology: 'bar' };

export const CONTEXT_COLOR = '#94a3b8';
const EDGE_COLOR = '#475569';
export const LIFECYCLE_STROKE: Partial<Record<Lifecycle, string>> = { sunset: '#e8590c', retired: '#c92a2a' };
/** Madurez 1 (inicial) a 5 (optimizada): del rojo al verde, en tonos claros para que el texto oscuro se lea bien. */
export const MATURITY_COLORS = ['#ffc9c9', '#ffd8a8', '#fff3bf', '#d8f5a2', '#b2f2bb'];
export const MATURITY_UNKNOWN = '#e9ecef';
export const IMPORTANCE_STROKE = { differentiating: '#1c7ed6', core: '#495057', supporting: '#adb5bd' } as const;

const NODE_HEIGHT = 76;

/** Ancho que necesita un nodo para que su texto no se recorte, entre `min` y 300 px. */
function widthFor(title: string, rest: string[], min: number): number {
  const widest = Math.max(title.length * 7.2, ...rest.map((l) => l.length * 6.2));
  return Math.min(300, Math.max(min, Math.ceil(widest + 32)));
}

/** Estado de un elemento con ciclo de vida: `en retirada · fin de soporte 2027-06`. */
function statusLine(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

const lifecycleText = (x: { lifecycle?: Lifecycle }): string | undefined => (lifecycleOf(x) === 'active' ? undefined : LIFECYCLE_LABELS[lifecycleOf(x)]);

/** Líneas de texto de un elemento en las vistas de relaciones (título primero). */
export function elementLines(e: Element, doc?: EnterpriseDocument): string[] {
  const owner = (id: string | undefined): string | undefined => (id && doc ? doc.units.find((u) => u.id === id)?.name : undefined);
  switch (e.kind) {
    case 'capability': {
      const c = e.item as Capability;
      return [c.name, statusLine([c.importance ? IMPORTANCE_LABELS[c.importance] : undefined, c.maturity ? `madurez ${c.maturity}/5` : undefined])].filter(Boolean);
    }
    case 'process': {
      const p = e.item as Process;
      return [p.name, owner(p.ownerId) ?? ''].filter(Boolean);
    }
    case 'application': {
      const a = e.item as Application;
      return [a.name, a.technology ?? a.vendor ?? '', statusLine([a.criticality ? `criticidad ${CRITICALITY_LABELS[a.criticality]}` : undefined, lifecycleText(a)])].filter(Boolean);
    }
    case 'technology': {
      const t = e.item as Technology;
      return [t.name, statusLine([TECHNOLOGY_KIND_LABELS[t.kind ?? 'platform'], t.version]), statusLine([lifecycleText(t), t.endOfLife ? `soporte hasta ${t.endOfLife}` : undefined])].filter(Boolean);
    }
    default:
      return [e.name];
  }
}

/** Arista del layout: la relación y sus extremos según el sentido en que se dibuja. */
export interface RenderedEdge {
  relation: Relation;
  source: string;
  target: string;
}

export interface RenderedView {
  view: EnterpriseView;
  layout: GraphLayout;
  elements: Map<string, Element>;
  edges: Map<string, RenderedEdge>;
  contextIds: Set<string>;
}

export const edgeLabel = (r: Relation): string | undefined => r.description;
export const isDashed = (r: Relation): boolean => r.kind === 'depends-on';

// --- Mapa de capacidades: cuadrícula anidada, sin autolayout ---------------------------------------------------------

const GAP = 14;
const PAD = 14;
const TITLE = 38;
const LEAF_H = 74;
const ROOT_ROW_LIMIT = 1240;

interface Cell {
  id: string;
  w: number;
  h: number;
  kids: Array<{ cell: Cell; dx: number; dy: number }>;
}

/** Reparte las celdas en filas de ancho máximo `limit`, de izquierda a derecha. */
function packRows(cells: Cell[], limit: number): { kids: Cell['kids']; w: number; h: number } {
  const rows: Cell[][] = [];
  let widths: number[] = [];
  for (const cell of cells) {
    const last = rows[rows.length - 1];
    if (last && widths[widths.length - 1] + GAP + cell.w <= limit) {
      last.push(cell);
      widths[widths.length - 1] += GAP + cell.w;
    } else {
      rows.push([cell]);
      widths.push(cell.w);
    }
  }
  const kids: Cell['kids'] = [];
  let y = 0;
  rows.forEach((row) => {
    let x = 0;
    for (const cell of row) {
      kids.push({ cell, dx: x, dy: y });
      x += cell.w + GAP;
    }
    y += Math.max(...row.map((c) => c.h)) + GAP;
  });
  return { kids, w: Math.max(0, ...widths), h: Math.max(0, y - GAP) };
}

/** Ancho uniforme de las capacidades hoja: el que necesita la de nombre más largo, entre 180 y 260 px. */
function leafWidth(doc: EnterpriseDocument): number {
  const children = capabilityChildren(doc);
  const longest = Math.max(0, ...doc.capabilities.filter((c) => !children.has(c.id)).map((c) => c.name.length));
  return Math.min(260, Math.max(180, Math.ceil(longest * 6.6 + 34)));
}

/** Mapa de capacidades: cada capacidad con hijas es un recuadro que contiene las suyas, en cuadrícula. */
export function layoutCapabilityMap(doc: EnterpriseDocument): GraphLayout {
  const children = capabilityChildren(doc);
  const leafW = leafWidth(doc);
  const measure = (c: Capability): Cell => {
    const kids = children.get(c.id);
    if (!kids) return { id: c.id, w: leafW, h: LEAF_H, kids: [] };
    const cells = kids.map(measure);
    const allLeaves = cells.every((x) => x.kids.length === 0);
    const columns = Math.min(4, Math.ceil(Math.sqrt(cells.length)));
    const limit = allLeaves ? columns * leafW + (columns - 1) * GAP : Math.max(...cells.map((x) => x.w), 640);
    const packed = packRows(cells, limit);
    const titleW = Math.ceil(c.name.length * 7.8 + 40);
    return { id: c.id, w: Math.max(packed.w + 2 * PAD, titleW), h: packed.h + TITLE + PAD, kids: packed.kids.map((k) => ({ ...k, dx: k.dx + PAD, dy: k.dy + TITLE })) };
  };
  const roots = (children.get(undefined) ?? []).map(measure);
  const packed = packRows(roots, ROOT_ROW_LIMIT);

  const nodes: Box[] = [];
  const groups: Box[] = [];
  const place = (cell: Cell, x: number, y: number): void => {
    (cell.kids.length > 0 ? groups : nodes).push({ id: cell.id, x, y, width: cell.w, height: cell.h });
    for (const k of cell.kids) place(k.cell, x + k.dx, y + k.dy);
  };
  for (const k of packed.kids) place(k.cell, k.dx, k.dy);
  return { nodes, groups, edges: [], width: packed.w, height: packed.h };
}

// --- Vistas de relaciones: autolayout de izquierda a derecha ----------------------------------------------------------

function nodeSize(e: Element, doc: EnterpriseDocument): { width: number; height: number } {
  const [title, ...rest] = elementLines(e, doc);
  return { width: widthFor(title, rest, 190), height: NODE_HEIGHT };
}

/** Coloca una vista. El mapa de capacidades es una cuadrícula anidada; las demás, un grafo capa a capa. */
export async function layoutView(doc: EnterpriseDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const all = indexElements(doc);
  const elements = new Map(view.elementIds.map((id) => [id, all.get(id)!]));
  if (view.type === 'capabilities') {
    return { view, layout: layoutCapabilityMap(doc), elements, edges: new Map(), contextIds: new Set() };
  }
  const edges = new Map<string, RenderedEdge>();
  for (const r of doc.relations.filter((x) => view.relationIds.includes(x.id))) {
    const { from, to } = drawnEnds(r);
    edges.set(r.id, { relation: r, source: from, target: to });
  }
  const layout = await layoutGraph(
    [...elements.values()].map((e) => ({ id: e.id, ...nodeSize(e, doc) })),
    [...edges].map(([id, e]) => ({ id, source: e.source, target: e.target, label: edgeLabel(e.relation) })),
    [],
    { direction: 'RIGHT', ...options },
  );
  return { view, layout, elements, edges, contextIds: new Set(view.contextIds) };
}

/** Estilo de un elemento en las vistas de relaciones. */
export function graphNodeStyle(e: Element, doc: EnterpriseDocument, context: boolean): SvgNodeStyle {
  const life = lifecycleOf(e.item as { lifecycle?: Lifecycle });
  return {
    fill: context ? CONTEXT_COLOR : KIND_COLORS[e.kind],
    stroke: LIFECYCLE_STROKE[life] ?? '#0f172a55',
    badge: KIND_LABELS[e.kind],
    lines: elementLines(e, doc),
    shape: ELEMENT_SHAPES[e.kind],
    dashed: context || life === 'retired' || (e.kind === 'application' && (e.item as Application).external === true),
  };
}

/** Estilo de una capacidad en el mapa: el color indica la madurez y el borde, la importancia. */
export function capabilityCellStyle(c: Capability, appCount: number): SvgNodeStyle {
  return {
    fill: c.maturity ? MATURITY_COLORS[c.maturity - 1] : MATURITY_UNKNOWN,
    stroke: c.importance ? IMPORTANCE_STROKE[c.importance] : '#868e96',
    textColor: '#0f172a',
    shape: ELEMENT_SHAPES.capability,
    badge: c.maturity ? `madurez ${c.maturity}/5` : undefined,
    lines: [c.name, c.importance ? IMPORTANCE_LABELS[c.importance] : '', appCount === 0 ? 'sin aplicación' : `${appCount} ${appCount === 1 ? 'aplicación' : 'aplicaciones'}`].filter(Boolean),
    dashed: appCount === 0,
  };
}

export async function toSvg(doc: EnterpriseDocument, viewId?: string): Promise<string> {
  const { view, layout, elements, edges, contextIds } = await layoutView(doc, viewId);
  if (view.type === 'capabilities') {
    const capabilities = new Map(doc.capabilities.map((c) => [c.id, c]));
    const apps = applicationsByCapability(doc);
    return renderGraphSvg(layout, {
      title: `${view.title} (color = madurez, borde = importancia)`,
      node: (id) => capabilityCellStyle(capabilities.get(id)!, apps.get(id)?.size ?? 0),
      edge: () => ({ stroke: EDGE_COLOR }),
      group: (id) => ({ label: capabilities.get(id)!.name }),
    });
  }
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => graphNodeStyle(elements.get(id)!, doc, contextIds.has(id)),
    edge: (id) => {
      const { relation } = edges.get(id)!;
      return { stroke: EDGE_COLOR, dashed: isDashed(relation), label: edgeLabel(relation), width: 1.5 };
    },
  });
}
