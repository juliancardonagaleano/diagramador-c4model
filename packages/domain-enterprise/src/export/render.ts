import { layoutGraph, renderGraphSvg, type Box, type EdgeRoute, type GraphLayout, type GraphLayoutOptions, type ShapeKind, type SvgEdgeStyle, type SvgLegend, type SvgNodeStyle } from '@iark/kernel';
import { applicationsByCapability, capabilityChildren, stageCapabilities, streamStages } from '../graph';
import { ROW_STATUS_LABELS, buildMatrix, cellKey, type Matrix, type MatrixRow } from '../matrix';
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
  type BusinessService,
  type ValueStage,
  type ValueStream,
} from '../types';
import { CAPABILITY_COLOR_LABELS, findView, roadmapColumns, type CapabilityColorMode, type EnterpriseView } from '../views';
import { CORRIDOR, assignTracks, countCrossings, placeRisers, planLanes, refineOrder, spread, traceClimb, type Climb, type Heights, type Riser, type Wire } from './valueStreamRoutes';

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
  stream: '#fff3bf',
  stage: '#ffd43b',
  service: '#ffe8a3',
};
export const KIND_STROKES: Record<ElementKind, string> = {
  unit: '#868e96',
  capability: '#e0a800',
  process: '#e0a800',
  application: '#1c7ed6',
  technology: '#2f9e44',
  stream: '#e0a800',
  stage: '#e0a800',
  service: '#e0a800',
};
export const INK = '#0f172a';

/** Icono del tipo en la esquina de cada nodo (trazados de una caja de 16 × 16): peldaños, flecha, ventana, cubo y persona. */
export const ELEMENT_ICONS: Record<ElementKind, string[]> = {
  unit: ['M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M3 14c0-3 2.4-4.5 5-4.5s5 1.5 5 4.5'],
  capability: ['M2 14h4v-4h4v-4h4v-4'],
  process: ['M2 5.5h6.5V2.5L14 8l-5.5 5.5v-3H2z'],
  application: ['M2 3h12v10H2z', 'M2 6h12'],
  technology: ['M8 2l6 3v6l-6 3-6-3V5z', 'M2 5l6 3 6-3', 'M8 8v6'],
  stream: ['M2 3l5 5-5 5', 'M8 3l5 5-5 5'],
  stage: ['M4 2.5l5.5 5.5L4 13.5'],
  service: ['M5 4h6a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8z', 'M5 8h6'],
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
  enables: { stroke: '#a07800' },
  exposes: { stroke: '#f08c00', head: 'open' },
};

/** Figura de cada tipo de elemento (notación de capas al estilo ArchiMate): la misma en el lienzo y en el SVG. */
export const ELEMENT_SHAPES: Record<ElementKind, ShapeKind> = { unit: 'rect', capability: 'rounded', process: 'chevron', application: 'rect', technology: 'bar', stream: 'rounded', stage: 'chevron', service: 'pill' };

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
    case 'stream': {
      const v = e.item as ValueStream;
      const stages = doc?.valueStages.filter((x) => x.streamId === v.id).length;
      return [v.name, v.stakeholder ? `valor para ${v.stakeholder}` : '', stages === undefined ? '' : `${stages} ${stages === 1 ? 'etapa' : 'etapas'}`].filter(Boolean);
    }
    case 'stage': {
      const s = e.item as ValueStage;
      const count = doc ? (stageCapabilities(doc).get(s.id) ?? []).length : undefined;
      return [s.name, s.value ?? '', count === undefined ? '' : count === 0 ? 'sin capacidad' : `${count} ${count === 1 ? 'capacidad' : 'capacidades'}`].filter(Boolean);
    }
    case 'service': {
      const b = e.item as BusinessService;
      return [b.name, b.audience ?? '', owner(b.ownerId) ?? ''].filter(Boolean);
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
  /** Solo en la matriz capacidad × aplicación: sus celdas y totales no son elementos del documento. */
  matrix?: MatrixScene;
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
export const CRITICALITY_FILL: Record<Criticality, string> = { low: '#b2f2bb', medium: '#fff3bf', high: '#ffd8a8', critical: '#ffa8a8' };
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

// --- Matriz capacidad × aplicación: cuadrícula de celdas, sin autolayout ----------------------------------------------------

const MATRIX_ROW_H = 44;
const MATRIX_HEAD_H = 104;
const MATRIX_GAP = 4;
const MATRIX_INDENT = 16;
const MATRIX_TOTAL_W = 104;
const MATRIX_KEY_H = 28;
/** Separación entre las cabeceras y el cuerpo, y entre el cuerpo y los totales. */
const MATRIX_SECTION = 10;

/** Aviso de un hueco (capacidad sin aplicación): rojo y discontinuo. */
export const MATRIX_GAP_STYLE = { fill: '#ffe3e3', pale: '#fff5f5', stroke: '#c92a2a' } as const;
/** Aviso de un solapamiento sin criterio: violeta, para no confundirlo con la escala de criticidad (verde, amarillo, naranja, rojo). */
export const MATRIX_OVERLAP_STYLE = { fill: '#f3d9fa', stroke: '#9c36b5' } as const;
const MATRIX_NEUTRAL = { fill: '#f1f3f5', stroke: '#868e96' } as const;
const MATRIX_EMPTY = { fill: '#ffffff', stroke: '#e9ecef' } as const;

/** Marca de cada tipo de soporte en la celda: directa `●`, por un proceso `○` y heredada de una capacidad hija `·`. */
export const MATRIX_MARKS = { direct: '●', process: '○', inherited: '·' } as const;

/** Mezcla un color con el blanco (`ratio` = parte de blanco, de 0 a 1): la versión pálida de un color de la escala. */
function tint(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v: number): string => Math.round(v + (255 - v) * ratio).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

/** Parte un texto en líneas de `max` caracteres como mucho (por palabras), con puntos suspensivos si no cabe en `lines` líneas. */
export function wrapText(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = `${kept[lines - 1].slice(0, Math.max(1, max - 1))}…`;
  return kept;
}

/** Cómo se dibuja un nodo de la matriz: lo comparten el lienzo, el SVG y draw.io. */
export interface MatrixNodeStyle {
  /** Cabeceras (una capacidad y una aplicación reales del documento), celdas y totales (también los de la clave de colores). */
  kind: 'capability' | 'application' | 'cell' | 'total';
  label: string;
  sublabel?: string;
  /** Insignias sobre el nodo en el lienzo (el ciclo de vida de una aplicación que no está activa). */
  badges?: string[];
  /** Texto para el SVG y draw.io: el nombre ajustado al ancho de la caja y sus datos. */
  lines: string[];
  fill: string;
  stroke: string;
  dashed?: boolean;
  shape: ShapeKind;
}

export interface MatrixScene {
  layout: GraphLayout;
  nodes: Map<string, MatrixNodeStyle>;
  matrix: Matrix;
}

/** Id de la celda de una capacidad y una aplicación (la unión de las dos, separadas por `|`). */
export const matrixCellId = (capabilityId: string, applicationId: string): string => `cell:${capabilityId}|${applicationId}`;

/** Capacidad y aplicación de una celda, o `undefined` si el id no es de una celda (los ids pueden llevar `|`: se prueban todos los cortes). */
export function parseMatrixCell(doc: EnterpriseDocument, id: string): { capabilityId: string; applicationId: string } | undefined {
  if (!id.startsWith('cell:')) return undefined;
  const body = id.slice('cell:'.length);
  const capabilities = new Set(doc.capabilities.map((c) => c.id));
  const applications = new Set(doc.applications.map((a) => a.id));
  for (let at = body.indexOf('|'); at >= 0; at = body.indexOf('|', at + 1)) {
    const [capabilityId, applicationId] = [body.slice(0, at), body.slice(at + 1)];
    if (capabilities.has(capabilityId) && applications.has(applicationId)) return { capabilityId, applicationId };
  }
  return undefined;
}

const warningOf = (row: MatrixRow): { fill: string; stroke: string } | undefined => (row.status === 'gap' ? MATRIX_GAP_STYLE : row.status === 'overlap' ? MATRIX_OVERLAP_STYLE : undefined);

function rowHeaderStyle(row: MatrixRow): MatrixNodeStyle {
  return {
    kind: 'capability',
    label: row.capability.name,
    lines: [row.capability.name],
    fill: row.group ? KIND_COLORS.stage : KIND_COLORS.capability,
    stroke: warningOf(row)?.stroke ?? KIND_STROKES.capability,
    dashed: row.status === 'gap',
    shape: ELEMENT_SHAPES.capability,
  };
}

function columnHeaderStyle(app: Application, idle: boolean, width: number): MatrixNodeStyle {
  const sublabel = app.criticality ? `crit. ${CRITICALITY_LABELS[app.criticality]}` : undefined;
  const life = lifecycleText(app);
  return {
    kind: 'application',
    label: app.name,
    ...(sublabel ? { sublabel } : {}),
    ...(life ? { badges: [life] } : {}),
    lines: [...wrapText(app.name, Math.floor((width - 16) / 6.4), 3), ...(sublabel ? [sublabel] : []), ...(life ? [life] : [])],
    fill: KIND_COLORS.application,
    stroke: idle ? MATRIX_GAP_STYLE.stroke : (LIFECYCLE_STROKE[lifecycleOf(app)] ?? KIND_STROKES.application),
    dashed: idle || app.external === true || lifecycleOf(app) === 'retired',
    shape: ELEMENT_SHAPES.application,
  };
}

/** Color de una aplicación en la matriz: el de su criticidad (o el gris de «sin indicar»). */
const criticalityFill = (app: Application): string => (app.criticality ? CRITICALITY_FILL[app.criticality] : MATURITY_UNKNOWN);

/**
 * Matriz capacidad × aplicación (ver `buildMatrix`): las capacidades en filas, en el orden del árbol y con sangría; las
 * aplicaciones en columnas; en cada celda, una marca si la aplicación soporta la capacidad, del color de su criticidad. A la
 * derecha, el total y el aviso de cada fila (hueco o solapamiento), debajo el total de cada columna y, al pie, la clave de los
 * colores. Una cuadrícula propia, sin autolayout.
 */
export function matrixScene(doc: EnterpriseDocument): MatrixScene {
  const matrix = buildMatrix(doc);
  const { rows, columns, summary } = matrix;
  const longestName = Math.max(0, ...rows.map((r) => r.capability.name.length * 7.4 + r.depth * MATRIX_INDENT));
  const rowW = Math.min(380, Math.max(210, Math.ceil(longestName + 60)));
  const longestWord = Math.max(0, ...columns.flatMap((c) => c.application.name.split(/\s+/).map((w) => w.length)));
  const colW = Math.min(150, Math.max(104, Math.ceil(longestWord * 7.4 + 34)));
  const colX = (i: number): number => rowW + MATRIX_SECTION + i * (colW + MATRIX_GAP);
  const totalX = colX(columns.length) + MATRIX_SECTION - MATRIX_GAP;
  const rowY = (r: number): number => MATRIX_HEAD_H + MATRIX_SECTION + r * (MATRIX_ROW_H + MATRIX_GAP);
  const totalsY = rowY(rows.length) + MATRIX_SECTION - MATRIX_GAP;

  const nodes: Box[] = [];
  const styles = new Map<string, MatrixNodeStyle>();
  const put = (id: string, box: Omit<Box, 'id'>, style: MatrixNodeStyle): void => {
    nodes.push({ id, ...box });
    styles.set(id, style);
  };
  const total = (label: string, sublabel: string | undefined, look: { fill: string; stroke: string }, dashed = false): MatrixNodeStyle => ({
    kind: 'total',
    label,
    ...(sublabel ? { sublabel } : {}),
    lines: [label, ...(sublabel ? [sublabel] : [])],
    fill: look.fill,
    stroke: look.stroke,
    dashed,
    shape: 'rect',
  });

  columns.forEach((c, i) => put(c.application.id, { x: colX(i), y: 0, width: colW, height: MATRIX_HEAD_H }, columnHeaderStyle(c.application, c.capabilities === 0, colW)));
  put('total:applications', { x: totalX, y: 0, width: MATRIX_TOTAL_W, height: MATRIX_HEAD_H }, total('Total', 'aplicaciones', MATRIX_NEUTRAL));

  rows.forEach((row, r) => {
    const y = rowY(r);
    const indent = row.depth * MATRIX_INDENT;
    put(row.capability.id, { x: indent, y, width: rowW - indent, height: MATRIX_ROW_H }, rowHeaderStyle(row));
    columns.forEach((c, i) => {
      const cell = matrix.cells.get(cellKey(row.capability.id, c.application.id));
      const gap = row.status === 'gap';
      let style: MatrixNodeStyle;
      if (!cell) {
        style = { kind: 'cell', label: '', lines: [''], fill: gap ? MATRIX_GAP_STYLE.pale : MATRIX_EMPTY.fill, stroke: gap ? '#ffc9c9' : MATRIX_EMPTY.stroke, shape: 'rect' };
      } else {
        const color = criticalityFill(c.application);
        const mark = MATRIX_MARKS[cell.support];
        style = {
          kind: 'cell',
          label: mark,
          lines: [mark],
          fill: cell.support === 'inherited' ? tint(color, 0.55) : color,
          stroke: cell.support === 'inherited' ? '#ced4da' : row.status === 'overlap' ? MATRIX_OVERLAP_STYLE.stroke : MATRIX_NEUTRAL.stroke,
          dashed: cell.support === 'process',
          shape: 'rect',
        };
      }
      put(matrixCellId(row.capability.id, c.application.id), { x: colX(i), y, width: colW, height: MATRIX_ROW_H }, style);
    });
    put(`total:row:${row.capability.id}`, { x: totalX, y, width: MATRIX_TOTAL_W, height: MATRIX_ROW_H }, total(String(row.all.length), ROW_STATUS_LABELS[row.status] || undefined, warningOf(row) ?? MATRIX_NEUTRAL, row.status === 'gap'));
  });

  put('total:capabilities', { x: 0, y: totalsY, width: rowW, height: MATRIX_ROW_H }, total('Total', 'capacidades por aplicación', MATRIX_NEUTRAL));
  columns.forEach((c, i) => {
    const idle = c.capabilities === 0;
    put(`total:column:${c.application.id}`, { x: colX(i), y: totalsY, width: colW, height: MATRIX_ROW_H }, total(String(c.capabilities), idle ? 'sin capacidad' : undefined, idle ? MATRIX_GAP_STYLE : MATRIX_NEUTRAL, idle));
  });
  put('total:all', { x: totalX, y: totalsY, width: MATRIX_TOTAL_W, height: MATRIX_ROW_H }, total(`${summary.covered}/${summary.leaves}`, 'cubiertas', MATRIX_NEUTRAL));

  // Clave de los colores al pie: nodos como los demás, para que el lienzo y el SVG la dibujen igual y no tape la matriz.
  const key: Array<{ title: string; chips: Array<{ label: string; look: { fill: string; stroke: string }; dashed?: boolean }> }> = [
    {
      title: 'Criticidad de la aplicación',
      chips: [...(['low', 'medium', 'high', 'critical'] as const).map((k) => ({ label: CRITICALITY_LABELS[k], look: { fill: CRITICALITY_FILL[k], stroke: MATRIX_NEUTRAL.stroke } })), { label: 'sin indicar', look: { fill: MATURITY_UNKNOWN, stroke: MATRIX_NEUTRAL.stroke } }],
    },
    { title: 'Avisos', chips: [{ label: 'hueco', look: MATRIX_GAP_STYLE, dashed: true }, { label: 'solapamiento', look: MATRIX_OVERLAP_STYLE }, { label: 'transición', look: MATRIX_NEUTRAL }, { label: 'con criterio', look: MATRIX_NEUTRAL }] },
    { title: 'Marca de la celda', chips: [{ label: `${MATRIX_MARKS.direct} directa`, look: MATRIX_EMPTY }, { label: `${MATRIX_MARKS.process} por proceso`, look: MATRIX_EMPTY, dashed: true }, { label: `${MATRIX_MARKS.inherited} heredada`, look: MATRIX_EMPTY }] },
  ];
  const keyY = totalsY + MATRIX_ROW_H + 2 * MATRIX_SECTION;
  key.forEach((line, r) => {
    const y = keyY + r * (MATRIX_KEY_H + MATRIX_GAP);
    put(`total:key:${r}`, { x: 0, y, width: rowW, height: MATRIX_KEY_H }, total(line.title, undefined, MATRIX_EMPTY));
    line.chips.forEach((chip, i) => put(`total:key:${r}:${i}`, { x: colX(i), y, width: colW, height: MATRIX_KEY_H }, total(chip.label, undefined, chip.look, chip.dashed)));
  });

  const width = Math.max(0, ...nodes.map((n) => n.x + n.width));
  return { layout: { nodes, groups: [], edges: [], width, height: keyY + key.length * (MATRIX_KEY_H + MATRIX_GAP) - MATRIX_GAP }, nodes: styles, matrix };
}

/** Coloca la matriz capacidad × aplicación (ver `matrixScene`). */
export const layoutMatrix = (doc: EnterpriseDocument): GraphLayout => matrixScene(doc).layout;

/** Estilo de un nodo de la matriz en el SVG (y las propiedades de draw.io salen del mismo). */
export function matrixSvgStyle(style: MatrixNodeStyle): SvgNodeStyle {
  return {
    fill: style.fill,
    stroke: style.stroke,
    textColor: INK,
    lines: style.lines,
    shape: style.shape,
    dashed: style.dashed,
    maxLines: 5,
    ...(style.kind === 'capability' || style.kind === 'application' ? { icon: ELEMENT_ICONS[style.kind] } : {}),
  };
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

// --- Flujos de valor: etapas en cadena y, debajo, las capacidades que las habilitan -------------------------------------

const STAGE_H = 76;
const CAPABILITY_H = 72;
/** Separación entre chevrones: la punta de uno encaja en la muesca del siguiente. */
const STAGE_GAP = 4;
/** Separación entre las pistas horizontales por las que giran las aristas, y holgura entre la primera o la última y las cajas. */
const TRACK = 10;
const TRACK_MARGIN = 16;
/** Alto mínimo del canal entre las etapas y las capacidades que las habilitan. */
const CHANNEL = 44;
/** Una capacidad a menos de esto del centro de su etapa se alinea con ella para que la arista baje recta. */
const SNAP = 8;
/** Posición del rótulo del recuadro (esquina superior izquierda) y holgura que se le deja. */
const LABEL_X = 12;
const LABEL_MARGIN = 8;
/**
 * Bajo el rótulo hay una franja por la que una arista que sube sale de su etapa hacia un pasillo lateral: la primera pista a
 * esta distancia del borde del recuadro y, entre la pista más cercana y las etapas, esta holgura. Sin ellas el recuadro no la reserva.
 */
const STRIP_FIRST = 36;
const STRIP_MARGIN = 14;
/** Ancho aproximado (por exceso) del rótulo de un flujo: «❯ Flujo de valor: » y su nombre, a 12 px en negrita. */
const labelWidth = (name: string): number => Math.ceil((name.length + 18) * 7.2);

/** Un flujo con etapas, ya colocado en horizontal: los centros de sus etapas y de las capacidades que dibuja, en el orden en que quedan. */
interface Row {
  stages: ValueStage[];
  chainX: number;
  stageCenter: Map<string, number>;
  caps: Array<{ id: string; center: number }>;
  /** Ancho del recuadro. */
  width: number;
}

/**
 * Coloca en horizontal los flujos con etapas (los vacíos quedan sin fila). Las capacidades de cada flujo, las que no dibuja uno
 * anterior, se ordenan por el baricentro de las etapas que las habilitan (en los empates, el orden del documento) y, con `refine`,
 * se mejora ese orden por búsqueda local contando los cruces que cada par causaría con las etapas de todos los flujos.
 */
function arrangeStreams(doc: EnterpriseDocument, refine: boolean): { rows: Array<Row | undefined>; stageW: number; capW: number } {
  const stages = streamStages(doc);
  const enabling = stageCapabilities(doc);
  const longest = Math.max(0, ...doc.valueStages.map((x) => x.name.length));
  // Anchos pares: los centros de etapa y capacidad caen en píxeles enteros y pueden coincidir.
  const stageW = Math.min(260, Math.max(180, 2 * Math.ceil((longest * 7.2 + 56) / 2)));
  const step = stageW + STAGE_GAP;
  const capW = Math.max(160, stageW - 20);
  const documentOrder = new Map(doc.capabilities.map((c, i) => [c.id, i]));
  // Etapas (flujo y posición) que habilita cada capacidad, en todos los flujos.
  const reach = new Map<string, Array<{ group: number; at: number }>>();
  doc.valueStreams.forEach((stream, group) => {
    stages.get(stream.id)!.forEach((stage, at) => {
      for (const c of enabling.get(stage.id) ?? []) reach.set(c.id, [...(reach.get(c.id) ?? []), { group, at }]);
    });
  });
  // Cruces entre las aristas de dos capacidades si `left` queda a la izquierda de `right`: las de un mismo flujo que van en orden inverso.
  const crossings = (left: string, right: string): number => {
    let count = 0;
    for (const e of reach.get(left) ?? []) for (const f of reach.get(right) ?? []) if (e.group === f.group && e.at > f.at) count += 1;
    return count;
  };
  const placed = new Set<string>();
  const rows = doc.valueStreams.map((stream): Row | undefined => {
    const list = stages.get(stream.id)!;
    if (list.length === 0) return undefined;
    // Capacidades de este flujo aún sin colocar (las que ya dibuja un flujo anterior se quedan donde estaban), con las
    // posiciones de las etapas que las habilitan, por baricentro.
    const mine = new Map<string, number[]>();
    list.forEach((stage, i) => {
      for (const c of enabling.get(stage.id) ?? []) if (!placed.has(c.id)) mine.set(c.id, [...(mine.get(c.id) ?? []), i]);
    });
    const barycenter = [...mine]
      .map(([id, at]) => ({ id, at, bary: at.reduce((a, b) => a + b, 0) / at.length }))
      .sort((a, b) => a.bary - b.bary || documentOrder.get(a.id)! - documentOrder.get(b.id)!);
    const ranked = refine ? refineOrder(barycenter.map((_, i) => i), (a, b) => crossings(barycenter[a].id, barycenter[b].id)).map((i) => barycenter[i]) : barycenter;
    const centerOf = (i: number): number => PAD + i * step + stageW / 2;
    const centers = spread(ranked.map((c) => centerOf(c.bary)), capW + GAP);
    // Una capacidad de una sola etapa que queda casi bajo ella se alinea para que su arista baje recta.
    ranked.forEach((c, k) => {
      const near = centerOf(c.at[0]);
      if (c.at.length > 1 || Math.abs(near - centers[k]) > SNAP) return;
      if ((k > 0 && near - centers[k - 1] < capW + GAP) || (k < centers.length - 1 && centers[k + 1] - near < capW + GAP)) return;
      centers[k] = near;
    });
    // Si las capacidades se salen por la izquierda, todo el flujo se desplaza.
    const shift = centers.length > 0 ? Math.max(0, PAD - (centers[0] - capW / 2)) : 0;
    const chainX = PAD + shift;
    for (const c of ranked) placed.add(c.id);
    return {
      stages: list,
      chainX,
      stageCenter: new Map(list.map((stage, i) => [stage.id, chainX + i * step + stageW / 2])),
      caps: ranked.map((c, k) => ({ id: c.id, center: centers[k] + shift })),
      width: Math.max(chainX + list.length * step - STAGE_GAP, ...centers.map((c) => c + shift + capW / 2)) + PAD,
    };
  });
  return { rows, stageW, capW };
}

interface RoutedStreams {
  layout: GraphLayout;
  titles: Map<string, string>;
  edges: Map<string, RenderedEdge>;
  /** Cruces entre las aristas de la colocación (para elegir entre dos). */
  crossings: number;
}

/**
 * Coloca en vertical los flujos ya dispuestos en horizontal y traza las aristas. Las que bajan de una etapa a una capacidad del
 * mismo flujo giran en una pista propia del canal que las separa. Las que suben hasta una capacidad que dibuja un flujo anterior
 * salen por encima de la etapa y, si el rótulo del recuadro o los flujos intermedios estorban, giran bajo el rótulo hacia un
 * pasillo libre (a la derecha de los flujos o, si así hay menos cruces, a su izquierda), suben por él y giran en el hueco bajo el flujo de
 * la capacidad.
 */
function routeStreams(doc: EnterpriseDocument, arranged: { rows: Array<Row | undefined>; stageW: number; capW: number }): RoutedStreams {
  const { rows, stageW, capW } = arranged;
  const streams = doc.valueStreams;
  const step = stageW + STAGE_GAP;
  const enables = doc.relations.filter((r) => r.kind === 'enables').map((relation) => ({ relation, ...drawnEnds(relation) }));

  // Dónde está cada etapa y cada capacidad (flujo y centro) y hasta dónde llega por la derecha cada flujo con su rótulo.
  const stageAt = new Map<string, { group: number; x: number }>();
  const capAt = new Map<string, { group: number; x: number }>();
  rows.forEach((row, group) => {
    for (const [id, x] of row?.stageCenter ?? []) stageAt.set(id, { group, x });
    for (const c of row?.caps ?? []) capAt.set(c.id, { group, x: c.center });
  });
  const labelEnd = streams.map((s) => LABEL_X + labelWidth(s.name) + LABEL_MARGIN);
  const reachRight = streams.map((_, i) => Math.max((rows[i]?.width ?? stageW) + CORRIDOR, labelEnd[i]));

  // Aristas de cada flujo: las que bajan a una capacidad suya y las que suben hasta la de un flujo anterior.
  const down = streams.map(() => [] as Array<{ id: string; wire: Wire }>);
  const climbs: Climb[] = [];
  for (const e of enables) {
    const [s, c] = [stageAt.get(e.from), capAt.get(e.to)];
    if (!s || !c) continue;
    if (s.group === c.group) down[s.group].push({ id: e.relation.id, wire: { ax: s.x, bx: c.x, source: e.from, target: e.to } });
    else if (c.group < s.group) climbs.push({ id: e.relation.id, stage: e.from, capability: e.to, from: s.group, to: c.group, ax: s.x, bx: c.x });
  }

  // Una etapa sube recta si no hay nada de por medio; si no, por un pasillo lateral: `base` es la columna libre más cercana a su derecha,
  // pasados el rótulo de su flujo y los flujos intermedios, y `placeRisers` elige entre las columnas de uno y otro lado.
  const byStage = new Map<string, Climb[]>();
  for (const c of climbs) byStage.set(c.stage, [...(byStage.get(c.stage) ?? []), c]);
  const risers = [...byStage].map(([stage, list]): Riser => {
    const { from, ax } = list[0];
    const top = Math.min(...list.map((c) => c.to));
    let base = Math.max(ax, ...streams.map((_, i) => (i > top && i < from ? reachRight[i] : -Infinity)));
    if (base < labelEnd[from]) base = labelEnd[from];
    return { stage, from, top, ax, base, x: base, climbs: list };
  });
  placeRisers(risers, new Map([...capAt].map(([id, c]) => [id, c.group])));
  const lanes = planLanes(risers);
  const downTracks = down.map((list) => assignTracks(list.map((d) => d.wire)));

  const nodes: Box[] = [];
  const groups: Box[] = [];
  const boxes = new Map<string, Box>();
  const routes = new Map<string, EdgeRoute>();
  const titles = new Map<string, string>();
  const tops: number[] = [];
  const stageTops: number[] = [];
  let y = 0;
  let width = 0;
  streams.forEach((stream, i) => {
    titles.set(stream.id, stream.name);
    // Las pistas del hueco sobre el flujo (por las que giran las aristas que suben hasta las capacidades del flujo anterior); si no caben, el hueco crece.
    const above = lanes.gap.get(i)?.count ?? 0;
    if (above > 0) y += Math.max(0, 2 * TRACK_MARGIN + (above - 1) * TRACK - GAP * 2);
    tops[i] = y;
    const row = rows[i];
    if (!row) {
      // Un flujo sin etapas es un nodo suelto, para poder rellenarlo.
      nodes.push({ id: stream.id, x: 0, y, width: stageW, height: STAGE_H });
      width = Math.max(width, stageW);
      y += STAGE_H + GAP * 2;
      return;
    }
    const strip = lanes.strip.get(i)?.count ?? 0;
    const title = strip > 0 ? Math.max(TITLE, STRIP_FIRST + (strip - 1) * TRACK + STRIP_MARGIN) : TITLE;
    const channel = row.caps.length > 0 ? Math.max(CHANNEL, 2 * TRACK_MARGIN + Math.max(0, downTracks[i].count - 1) * TRACK) : 0;
    const top = y;
    const stageY = top + title;
    stageTops[i] = stageY;
    row.stages.forEach((stage, n) => {
      const box = { id: stage.id, x: row.chainX + n * step, y: stageY, width: stageW, height: STAGE_H };
      nodes.push(box);
      boxes.set(stage.id, box);
    });
    const capY = stageY + STAGE_H + channel;
    for (const c of row.caps) {
      const box = { id: c.id, x: c.center - capW / 2, y: capY, width: capW, height: CAPABILITY_H };
      nodes.push(box);
      boxes.set(c.id, box);
    }
    const h = title + STAGE_H + (row.caps.length > 0 ? channel + CAPABILITY_H : 0) + PAD;
    groups.push({ id: stream.id, x: 0, y: top, width: row.width, height: h });
    width = Math.max(width, row.width);

    // Las que bajan giran en el canal entre las etapas y las capacidades (las pistas, centradas en él).
    down[i].forEach(({ id, wire }, n) => {
      const [a, b] = [boxes.get(wire.source)!, boxes.get(wire.target)!];
      const level = downTracks[i].levels[n];
      const lane = a.y + a.height + (channel - (downTracks[i].count - 1) * TRACK) / 2 + level * TRACK;
      const elbow = level < 0 ? [] : [{ x: wire.ax, y: lane }, { x: wire.bx, y: lane }];
      routes.set(id, { id, points: [{ x: wire.ax, y: a.y + a.height }, ...elbow, { x: wire.bx, y: b.y }], sides: { source: 'bottom', target: 'top' } });
    });
    y += h + GAP * 2;
  });

  // Las que suben, ya con las alturas reales: la franja bajo el rótulo, las pistas del hueco sobre el flujo de cada capacidad y la base de la capacidad.
  const heights: Heights = {
    stageTop: (group) => stageTops[group],
    strip: (group, level) => stageTops[group] - STRIP_MARGIN - level * TRACK,
    gap: (group, level) => tops[group] - TRACK_MARGIN - level * TRACK,
    capBottom: (capability) => boxes.get(capability)!.y + boxes.get(capability)!.height,
  };
  for (const r of risers) for (const c of r.climbs) routes.set(c.id, { id: c.id, points: traceClimb(r, c, lanes, heights), sides: { source: 'top', target: 'bottom' } });
  for (const r of risers) width = Math.max(width, r.x + PAD);

  // Un pasillo a la izquierda de los flujos queda fuera del lienzo: todo se desplaza para dejarle sitio.
  const dx = Math.max(0, ...risers.map((r) => PAD - r.x));
  if (dx > 0) {
    for (const box of [...nodes, ...groups]) box.x += dx;
    for (const route of routes.values()) route.points = route.points.map((p) => ({ x: p.x + dx, y: p.y }));
    width += dx;
  }

  const edges = new Map<string, RenderedEdge>();
  const ordered: EdgeRoute[] = [];
  for (const e of enables) {
    const route = routes.get(e.relation.id);
    if (!route) continue;
    ordered.push(route);
    edges.set(e.relation.id, { relation: e.relation, source: e.from, target: e.to });
  }
  const crossings = countCrossings(ordered.map((r) => ({ points: r.points, source: edges.get(r.id)!.source, target: edges.get(r.id)!.target })));
  return { layout: { nodes, groups, edges: ordered, width, height: Math.max(0, y - GAP * 2) }, titles, edges, crossings };
}

/**
 * Flujos de valor: cada flujo es un recuadro con sus etapas como chevrones en cadena, de izquierda a derecha, y debajo, en
 * una fila, las capacidades que las habilitan. Las capacidades se ordenan por el baricentro de sus etapas (la que habilitan
 * varias queda bajo el centro de ellas; en los empates, el orden del documento), se mejora ese orden por búsqueda local si con ello
 * hay menos cruces (nunca más que con el baricentro solo) y se reparten lo más cerca posible. Cada arista baja de la etapa a la
 * capacidad con un solo codo, en una pista propia del canal que las separa para que no se corten; si la capacidad la dibuja un flujo
 * anterior (arriba), sube por un pasillo libre (sobre la etapa o, si no cabe, junto a los flujos intermedios, a su derecha o a su izquierda) hasta una
 * pista sobre el recuadro del flujo de la capacidad, sin atravesar ningún nodo ni el rótulo de un recuadro. Un flujo sin etapas es
 * un nodo suelto, para poder rellenarlo. `refine: false` deja el orden por baricentro simple (para compararlo).
 */
export function layoutValueStreams(doc: EnterpriseDocument, options: { refine?: boolean } = {}): { layout: GraphLayout; titles: Map<string, string>; edges: Map<string, RenderedEdge> } {
  const simple = arrangeStreams(doc, false);
  const base = routeStreams(doc, simple);
  let best = base;
  if (options.refine !== false) {
    const refined = arrangeStreams(doc, true);
    const order = (a: { rows: Array<Row | undefined> }): string => JSON.stringify(a.rows.map((r) => r?.caps.map((c) => c.id)));
    if (order(refined) !== order(simple)) {
      const routed = routeStreams(doc, refined);
      if (routed.crossings < base.crossings) best = routed;
    }
  }
  return { layout: best.layout, titles: best.titles, edges: best.edges };
}

// --- Vistas de relaciones: autolayout de izquierda a derecha ----------------------------------------------------------

function nodeSize(e: Element, doc: EnterpriseDocument): { width: number; height: number } {
  const [title, ...rest] = elementLines(e, doc);
  return { width: widthFor(title, rest, 190), height: NODE_HEIGHT };
}

/** Coloca una vista. El mapa de capacidades es una cuadrícula anidada, la matriz una cuadrícula de celdas, la hoja de ruta, columnas y los flujos de valor, cadenas de etapas; las demás, un grafo capa a capa. */
export async function layoutView(doc: EnterpriseDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const all = indexElements(doc);
  const elements = new Map(view.elementIds.map((id) => [id, all.get(id)!]));
  if (view.type === 'capabilities') {
    return { view, layout: layoutCapabilityMap(doc), elements, edges: new Map(), contextIds: new Set() };
  }
  if (view.type === 'matrix') {
    const scene = matrixScene(doc);
    return { view, layout: scene.layout, elements, edges: new Map(), contextIds: new Set(), matrix: scene };
  }
  if (view.type === 'roadmap') {
    const { layout, titles } = layoutRoadmap(doc);
    return { view, layout, elements, edges: new Map(), contextIds: new Set(), groupLabels: titles };
  }
  if (view.type === 'value-stream') {
    const { layout, titles, edges } = layoutValueStreams(doc);
    return { view, layout, elements, edges, contextIds: new Set(), groupLabels: titles };
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
    dashed: context || life === 'retired' || (e.kind === 'application' && (e.item as Application).external === true) || (e.kind === 'stage' && (stageCapabilities(doc).get(e.id) ?? []).length === 0),
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
  const { view, layout, elements, edges, contextIds, groupLabels, matrix } = await layoutView(doc, viewId);
  if (matrix) {
    return renderGraphSvg(layout, { title: view.title, node: (id) => matrixSvgStyle(matrix.nodes.get(id)!), edge: () => ({ stroke: EDGE_COLOR }) });
  }
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
    ...(groupLabels ? { group: (id: string) => ({ label: groupLabels.get(id) ?? id, ...(view.type === 'value-stream' ? { fill: '#fffbe6', stroke: KIND_STROKES.stream, border: 'solid' as const } : {}) }) } : {}),
  });
}
