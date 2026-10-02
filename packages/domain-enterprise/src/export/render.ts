import { layoutGraph, renderGraphSvg, type Box, type GraphLayout, type GraphLayoutOptions, type ShapeKind, type SvgEdgeStyle, type SvgLegend, type SvgNodeStyle } from '@iark/kernel';
import { applicationsByCapability, capabilityChildren } from '../graph';
import {
  CRITICALITY_LABELS,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  LIFECYCLE_LABELS,
  CRITICALITY_RANK,
  STRATEGY_LABELS,
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
  type Criticality,
  type Process,
  type Relation,
  type RelationKind,
  type Technology,
} from '../types';
import { CAPABILITY_COLOR_LABELS, findView, roadmapColumns, type CapabilityColorMode, type EnterpriseView } from '../views';

/**
 * Colores por capa, al estilo ArchiMate: negocio (capacidades y procesos) amarillo, aplicación azul y tecnología verde. Son
 * claros, así que el texto va en tinta oscura (`INK`). Las unidades, que son la organización, en gris.
 */
export const KIND_COLORS: Record<ElementKind, string> = {
  unit: '#dee2e6',
  capability: '#ffec99',
  process: '#ffe066',
  application: '#74c0fc',
  technology: '#8ce99a',
};
export const KIND_STROKES: Record<ElementKind, string> = {
  unit: '#868e96',
  capability: '#e0a800',
  process: '#e0a800',
  application: '#1c7ed6',
  technology: '#2f9e44',
};
export const INK = '#0f172a';

/** Icono del tipo en la esquina de cada nodo (trazados de una caja de 16 × 16): peldaños, flecha, ventana, cubo y persona. */
export const ELEMENT_ICONS: Record<ElementKind, string[]> = {
  unit: ['M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M3 14c0-3 2.4-4.5 5-4.5s5 1.5 5 4.5'],
  capability: ['M2 14h4v-4h4v-4h4v-4'],
  process: ['M2 5.5h6.5V2.5L14 8l-5.5 5.5v-3H2z'],
  application: ['M2 3h12v10H2z', 'M2 6h12'],
  technology: ['M8 2l6 3v6l-6 3-6-3V5z', 'M2 5l6 3 6-3', 'M8 8v6'],
};

/** Notación de cada tipo de relación: la misma en el lienzo, el SVG y draw.io. */
export interface EdgeStyle {
  stroke: string;
  dashed?: boolean;
  width?: number;
  /** Adorno en el origen: rombo (composición) o punto (asignación). */
  tail?: 'diamond' | 'dot';
  /** `open`: «V» sin relleno; `none`: sin punta. Por defecto, triángulo relleno. */
  head?: 'open' | 'none';
}
const EDGE_COLOR = '#475569';
export const EDGE_STYLES: Record<RelationKind, EdgeStyle> = {
  supports: { stroke: EDGE_COLOR },
  realizes: { stroke: '#7048e8' },
  'runs-on': { stroke: '#2f9e44' },
  'depends-on': { stroke: EDGE_COLOR, dashed: true },
  composes: { stroke: '#0b7285', tail: 'diamond', head: 'none' },
  'flows-to': { stroke: '#0b7285', dashed: true },
  'assigned-to': { stroke: '#e8590c', tail: 'dot' },
  triggers: { stroke: '#c2255c', width: 2.25, head: 'open' },
};

/** Figura de cada tipo de elemento (notación de capas al estilo ArchiMate): la misma en el lienzo y en el SVG. */
export const ELEMENT_SHAPES: Record<ElementKind, ShapeKind> = { unit: 'rect', capability: 'rounded', process: 'chevron', application: 'rect', technology: 'bar' };

export const CONTEXT_COLOR = '#94a3b8';
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
      return [a.name, a.technology ?? a.vendor ?? '', statusLine([a.criticality ? `criticidad ${CRITICALITY_LABELS[a.criticality]}` : undefined, lifecycleText(a), a.strategy ? `estrategia ${STRATEGY_LABELS[a.strategy]}` : undefined])].filter(Boolean);
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
  /** Rótulo de cada grupo del layout cuando no es un elemento del documento (las columnas de la hoja de ruta). */
  groupLabels?: Map<string, string>;
}

export const edgeLabel = (r: Relation): string | undefined => r.description;
export const isDashed = (r: Relation): boolean => EDGE_STYLES[r.kind].dashed === true;

/** Estilo de una relación en el SVG. */
export function edgeSvgStyle(r: Relation): SvgEdgeStyle {
  const s = EDGE_STYLES[r.kind];
  return { stroke: s.stroke, dashed: s.dashed, label: edgeLabel(r), width: s.width ?? 1.5, tail: s.tail, head: s.head };
}

/** Coste anual abreviado: `1,2 M`, `120 k`. */
export function formatCost(n: number): string {
  if (n >= 1_000_000) return `${String(Math.round(n / 100_000) / 10).replace('.', ',')} M`;
  if (n >= 1000) return `${Math.round(n / 1000)} k`;
  return String(n);
}

/** Datos de gestión de una aplicación: estrategia, coste anual y usuarios. */
export function applicationFacts(a: Application): string[] {
  return [a.strategy ? `estrategia ${STRATEGY_LABELS[a.strategy]}` : undefined, a.annualCost !== undefined ? `coste ${formatCost(a.annualCost)}/año` : undefined, a.users !== undefined ? `${a.users} usuarios` : undefined].filter((x): x is string => !!x);
}

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

// --- Mapa de capacidades: criterios de color ---------------------------------------------------------------------------

export interface Paint {
  fill: string;
  /** Valor del criterio, para la insignia del nodo. */
  value?: string;
}

const IMPORTANCE_FILL = { differentiating: '#b197fc', core: '#d0bfff', supporting: '#f1f3f5' } as const;
const CRITICALITY_FILL: Record<Criticality, string> = { low: '#b2f2bb', medium: '#fff3bf', high: '#ffd8a8', critical: '#ffa8a8' };
const LIFECYCLE_PAINT = {
  active: { fill: '#b2f2bb', label: 'activas' },
  planned: { fill: '#a5d8ff', label: 'solo previstas' },
  sunset: { fill: '#ffd8a8', label: 'con una en retirada' },
  retired: { fill: '#ffa8a8', label: 'con una retirada' },
} as const;

/** Color de una capacidad hoja en el mapa según el criterio elegido; `apps` son las aplicaciones que la soportan. */
export function capabilityPaint(c: Capability, mode: CapabilityColorMode, apps: Application[]): Paint {
  switch (mode) {
    case 'importance':
      return c.importance ? { fill: IMPORTANCE_FILL[c.importance], value: IMPORTANCE_LABELS[c.importance] } : { fill: MATURITY_UNKNOWN };
    case 'criticality': {
      const worst = apps.flatMap((a) => (a.criticality ? [a.criticality] : [])).sort((x, y) => CRITICALITY_RANK[y] - CRITICALITY_RANK[x])[0];
      return worst ? { fill: CRITICALITY_FILL[worst], value: `criticidad ${CRITICALITY_LABELS[worst]}` } : { fill: MATURITY_UNKNOWN };
    }
    case 'lifecycle': {
      if (apps.length === 0) return { fill: MATURITY_UNKNOWN };
      const lives = apps.map((a) => lifecycleOf(a));
      const state = lives.includes('retired') ? 'retired' : lives.includes('sunset') ? 'sunset' : lives.every((l) => l === 'planned') ? 'planned' : 'active';
      return { fill: LIFECYCLE_PAINT[state].fill, value: `aplicaciones ${LIFECYCLE_PAINT[state].label}` };
    }
    default:
      return c.maturity ? { fill: MATURITY_COLORS[c.maturity - 1], value: `madurez ${c.maturity}/5` } : { fill: MATURITY_UNKNOWN };
  }
}

/** Leyenda de colores del criterio elegido. */
export function capabilityLegend(mode: CapabilityColorMode): SvgLegend {
  const items: Array<{ label: string; color: string }> = [];
  switch (mode) {
    case 'importance':
      items.push(...(['differentiating', 'core', 'supporting'] as const).map((i) => ({ label: IMPORTANCE_LABELS[i], color: IMPORTANCE_FILL[i] })), { label: 'sin indicar', color: MATURITY_UNKNOWN });
      break;
    case 'criticality':
      items.push(...(['low', 'medium', 'high', 'critical'] as const).map((k) => ({ label: CRITICALITY_LABELS[k], color: CRITICALITY_FILL[k] })), { label: 'sin aplicación', color: MATURITY_UNKNOWN });
      break;
    case 'lifecycle':
      items.push(...(['active', 'planned', 'sunset', 'retired'] as const).map((k) => ({ label: LIFECYCLE_PAINT[k].label, color: LIFECYCLE_PAINT[k].fill })), { label: 'sin aplicación', color: MATURITY_UNKNOWN });
      break;
    default:
      items.push(...MATURITY_COLORS.map((color, i) => ({ label: `${i + 1}/5`, color })), { label: 'sin indicar', color: MATURITY_UNKNOWN });
  }
  return { title: `Color: ${CAPABILITY_COLOR_LABELS[mode].toLowerCase()}`, items };
}

/** Aplicaciones que soportan cada capacidad, ya resueltas a su ficha. */
export function supportingApplications(doc: EnterpriseDocument): Map<string, Application[]> {
  const byId = new Map(doc.applications.map((a) => [a.id, a]));
  return new Map([...applicationsByCapability(doc)].map(([id, ids]) => [id, [...ids].flatMap((x) => (byId.has(x) ? [byId.get(x)!] : []))]));
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

// --- Hoja de ruta: una columna por periodo ---------------------------------------------------------------------------------

const COLUMN_W = 232;
const ROADMAP_NODE = { width: 210, height: 76 };

/** Hoja de ruta del ciclo de vida: cada periodo es un grupo con sus aplicaciones y tecnología apiladas. */
export function layoutRoadmap(doc: EnterpriseDocument): { layout: GraphLayout; titles: Map<string, string> } {
  const columns = roadmapColumns(doc);
  const nodes: Box[] = [];
  const groups: Box[] = [];
  const titles = new Map<string, string>();
  let height = 0;
  columns.forEach((column, i) => {
    const x = i * (COLUMN_W + GAP);
    const h = TITLE + column.elementIds.length * (ROADMAP_NODE.height + GAP) - GAP + PAD;
    groups.push({ id: column.id, x, y: 0, width: COLUMN_W, height: h });
    titles.set(column.id, column.title);
    column.elementIds.forEach((id, k) => nodes.push({ id, x: x + (COLUMN_W - ROADMAP_NODE.width) / 2, y: TITLE + k * (ROADMAP_NODE.height + GAP), ...ROADMAP_NODE }));
    height = Math.max(height, h);
  });
  return { layout: { nodes, groups, edges: [], width: Math.max(0, columns.length * (COLUMN_W + GAP) - GAP), height }, titles };
}

// --- Vistas de relaciones: autolayout de izquierda a derecha ----------------------------------------------------------

function nodeSize(e: Element, doc: EnterpriseDocument): { width: number; height: number } {
  const [title, ...rest] = elementLines(e, doc);
  return { width: widthFor(title, rest, 190), height: NODE_HEIGHT };
}

/** Coloca una vista. El mapa de capacidades es una cuadrícula anidada y la hoja de ruta, columnas; las demás, un grafo capa a capa. */
export async function layoutView(doc: EnterpriseDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const all = indexElements(doc);
  const elements = new Map(view.elementIds.map((id) => [id, all.get(id)!]));
  if (view.type === 'capabilities') {
    return { view, layout: layoutCapabilityMap(doc), elements, edges: new Map(), contextIds: new Set() };
  }
  if (view.type === 'roadmap') {
    const { layout, titles } = layoutRoadmap(doc);
    return { view, layout, elements, edges: new Map(), contextIds: new Set(), groupLabels: titles };
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

/** Estilo de un elemento en las vistas de relaciones: el color de su capa, el borde de su ciclo de vida y su icono. */
export function graphNodeStyle(e: Element, doc: EnterpriseDocument, context: boolean): SvgNodeStyle {
  const life = lifecycleOf(e.item as { lifecycle?: Lifecycle });
  return {
    fill: context ? CONTEXT_COLOR : KIND_COLORS[e.kind],
    stroke: LIFECYCLE_STROKE[life] ?? KIND_STROKES[e.kind],
    textColor: INK,
    badge: KIND_LABELS[e.kind],
    lines: elementLines(e, doc),
    shape: ELEMENT_SHAPES[e.kind],
    icon: ELEMENT_ICONS[e.kind],
    dashed: context || life === 'retired' || (e.kind === 'application' && (e.item as Application).external === true),
  };
}

/** Estilo de una capacidad en el mapa: el color indica el criterio elegido (por defecto, la madurez) y el borde, la importancia. */
export function capabilityCellStyle(c: Capability, apps: Application[], mode: CapabilityColorMode = 'maturity'): SvgNodeStyle {
  const paint = capabilityPaint(c, mode, apps);
  return {
    fill: paint.fill,
    stroke: c.importance ? IMPORTANCE_STROKE[c.importance] : '#868e96',
    textColor: INK,
    shape: ELEMENT_SHAPES.capability,
    icon: ELEMENT_ICONS.capability,
    badge: paint.value,
    lines: [c.name, c.importance ? IMPORTANCE_LABELS[c.importance] : '', apps.length === 0 ? 'sin aplicación' : `${apps.length} ${apps.length === 1 ? 'aplicación' : 'aplicaciones'}`].filter(Boolean),
    dashed: apps.length === 0,
  };
}

export async function toSvg(doc: EnterpriseDocument, viewId?: string): Promise<string> {
  const { view, layout, elements, edges, contextIds, groupLabels } = await layoutView(doc, viewId);
  if (view.type === 'capabilities') {
    const capabilities = new Map(doc.capabilities.map((c) => [c.id, c]));
    const apps = supportingApplications(doc);
    const mode = view.colorBy ?? 'maturity';
    return renderGraphSvg(layout, {
      title: `${view.title} (color = ${CAPABILITY_COLOR_LABELS[mode].toLowerCase()}, borde = importancia)`,
      legend: capabilityLegend(mode),
      node: (id) => capabilityCellStyle(capabilities.get(id)!, apps.get(id) ?? [], mode),
      edge: () => ({ stroke: EDGE_COLOR }),
      group: (id) => ({ label: capabilities.get(id)!.name }),
    });
  }
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => graphNodeStyle(elements.get(id)!, doc, contextIds.has(id)),
    edge: (id) => edgeSvgStyle(edges.get(id)!.relation),
    ...(groupLabels ? { group: (id: string) => ({ label: groupLabels.get(id) ?? id }) } : {}),
  });
}
