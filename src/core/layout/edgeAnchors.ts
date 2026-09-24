import type { LayoutDirection } from '../model/types';

/**
 * Anclajes de aristas ("puertos virtuales"): decide por qué lado sale y entra
 * cada relación y reparte los puntos a lo largo del lado para que las aristas
 * que comparten nodo no nazcan en el mismo punto ni se crucen en abanico.
 * Es puro: lo usan tanto el render de la app como la métrica de calidad.
 */

export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Anchor {
  x: number;
  y: number;
  side: Side;
}

export interface EdgeRef {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface EdgeAnchors {
  source: Anchor;
  target: Anchor;
}

export interface Point {
  x: number;
  y: number;
}

const CORNER_MARGIN = 18;

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Lado por el que un rectángulo mira hacia otro, según la dirección de flujo preferida. */
export function chooseSide(from: Rect, to: Rect, direction: LayoutDirection): Side {
  const fc = center(from);
  const tc = center(to);
  const verticalGap = to.y - (from.y + from.height); // > 0 si el otro está debajo
  const verticalGapUp = from.y - (to.y + to.height); // > 0 si el otro está encima
  const horizontalGap = to.x - (from.x + from.width);
  const horizontalGapLeft = from.x - (to.x + to.width);
  const clearVertical = verticalGap > 0 || verticalGapUp > 0;
  const clearHorizontal = horizontalGap > 0 || horizontalGapLeft > 0;
  const preferVertical = direction === 'DOWN' || direction === 'UP';

  if (clearVertical && clearHorizontal) {
    // Ambos posibles: seguir la dirección del flujo salvo que el desplazamiento lateral sea claramente mayor.
    const dx = Math.abs(tc.x - fc.x);
    const dy = Math.abs(tc.y - fc.y);
    if (preferVertical) return dx > dy * 2.2 ? (tc.x > fc.x ? 'right' : 'left') : tc.y > fc.y ? 'bottom' : 'top';
    return dy > dx * 2.2 ? (tc.y > fc.y ? 'bottom' : 'top') : tc.x > fc.x ? 'right' : 'left';
  }
  if (clearVertical) return tc.y > fc.y ? 'bottom' : 'top';
  if (clearHorizontal) return tc.x > fc.x ? 'right' : 'left';
  // Rectángulos solapados: usar la mayor componente.
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function pointOnSide(r: Rect, side: Side, t: number): Anchor {
  // t ∈ [0,1] a lo largo del lado, con margen en las esquinas.
  const clamp = (v: number, len: number) => Math.min(len - CORNER_MARGIN, Math.max(CORNER_MARGIN, v));
  switch (side) {
    case 'top':
      return { x: r.x + clamp(t * r.width, r.width), y: r.y, side };
    case 'bottom':
      return { x: r.x + clamp(t * r.width, r.width), y: r.y + r.height, side };
    case 'left':
      return { x: r.x, y: r.y + clamp(t * r.height, r.height), side };
    case 'right':
      return { x: r.x + r.width, y: r.y + clamp(t * r.height, r.height), side };
  }
}

/**
 * Calcula los anclajes de todas las aristas. Las aristas cuyos extremos no
 * tienen rectángulo se omiten del resultado.
 */
export function computeEdgeAnchors(rects: Iterable<Rect>, edges: EdgeRef[], direction: LayoutDirection = 'DOWN'): Map<string, EdgeAnchors> {
  const byId = new Map<string, Rect>();
  for (const r of rects) byId.set(r.id, r);

  interface Slot {
    edgeId: string;
    end: 'source' | 'target';
    nodeId: string;
    side: Side;
    /** Coordenada del otro extremo para ordenar el abanico. */
    sortKey: number;
    /** Desempate estable entre aristas paralelas. */
    tie: number;
  }

  const slots: Slot[] = [];
  const sides = new Map<string, { source: Side; target: Side }>();
  edges.forEach((e, index) => {
    const s = byId.get(e.sourceId);
    const t = byId.get(e.targetId);
    if (!s || !t || e.sourceId === e.targetId) return;
    const sourceSide = chooseSide(s, t, direction);
    const targetSide = chooseSide(t, s, direction);
    sides.set(e.id, { source: sourceSide, target: targetSide });
    const sc = center(s);
    const tc = center(t);
    const keyFor = (side: Side, other: Point) => (side === 'top' || side === 'bottom' ? other.x : other.y);
    slots.push({ edgeId: e.id, end: 'source', nodeId: e.sourceId, side: sourceSide, sortKey: keyFor(sourceSide, tc), tie: index });
    slots.push({ edgeId: e.id, end: 'target', nodeId: e.targetId, side: targetSide, sortKey: keyFor(targetSide, sc), tie: index });
  });

  // Agrupar por (nodo, lado) y repartir.
  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = `${slot.nodeId}|${slot.side}`;
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }

  const anchors = new Map<string, Partial<EdgeAnchors>>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.sortKey - b.sortKey || a.tie - b.tie);
    const rect = byId.get(group[0].nodeId)!;
    const n = group.length;
    group.forEach((slot, i) => {
      const t = (i + 1) / (n + 1);
      const anchor = pointOnSide(rect, slot.side, t);
      const entry = anchors.get(slot.edgeId) ?? {};
      entry[slot.end] = anchor;
      anchors.set(slot.edgeId, entry);
    });
  }

  const result = new Map<string, EdgeAnchors>();
  for (const [id, a] of anchors) if (a.source && a.target) result.set(id, { source: a.source, target: a.target });
  return result;
}

/**
 * Ruta ortogonal entre dos anclajes (la misma que dibuja la app): lados opuestos
 * → tres tramos con quiebre a mitad de camino; lados perpendiculares → forma de L.
 */
export function routeEdge(source: Anchor, target: Anchor, offset = 24): Point[] {
  const vertical = (s: Side) => s === 'top' || s === 'bottom';
  const dir = (s: Side): Point => (s === 'top' ? { x: 0, y: -1 } : s === 'bottom' ? { x: 0, y: 1 } : s === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 });
  const sd = dir(source.side);
  const td = dir(target.side);

  if (vertical(source.side) && vertical(target.side)) {
    const forward = (target.y - source.y) * sd.y > 0 && (source.y - target.y) * td.y > 0;
    if (forward) {
      const midY = (source.y + target.y) / 2;
      return [source, { x: source.x, y: midY }, { x: target.x, y: midY }, target];
    }
    // Mismo lado (p. ej. ambos "bottom"): rodear por fuera.
    const extY = sd.y > 0 ? Math.max(source.y, target.y) + offset : Math.min(source.y, target.y) - offset;
    return [source, { x: source.x, y: extY }, { x: target.x, y: extY }, target];
  }
  if (!vertical(source.side) && !vertical(target.side)) {
    const forward = (target.x - source.x) * sd.x > 0 && (source.x - target.x) * td.x > 0;
    if (forward) {
      const midX = (source.x + target.x) / 2;
      return [source, { x: midX, y: source.y }, { x: midX, y: target.y }, target];
    }
    const extX = sd.x > 0 ? Math.max(source.x, target.x) + offset : Math.min(source.x, target.x) - offset;
    return [source, { x: extX, y: source.y }, { x: extX, y: target.y }, target];
  }
  // Perpendiculares: L simple pasando por la esquina.
  if (vertical(source.side)) {
    const cornerOk = (target.y - source.y) * sd.y > 0 && (source.x - target.x) * td.x > 0;
    if (cornerOk) return [source, { x: source.x, y: target.y }, target];
    return [source, { x: source.x, y: source.y + sd.y * offset }, { x: target.x + td.x * offset, y: source.y + sd.y * offset }, { x: target.x + td.x * offset, y: target.y }, target];
  }
  const cornerOk = (target.x - source.x) * sd.x > 0 && (source.y - target.y) * td.y > 0;
  if (cornerOk) return [source, { x: target.x, y: source.y }, target];
  return [source, { x: source.x + sd.x * offset, y: source.y }, { x: source.x + sd.x * offset, y: target.y + td.y * offset }, { x: target.x, y: target.y + td.y * offset }, target];
}

/** Centro del tramo más largo de una polilínea (posición de la etiqueta). */
export function labelPosition(points: Point[]): Point {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const a = points[best];
  const b = points[best + 1] ?? a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Convierte la polilínea en un path SVG con esquinas redondeadas. */
export function pathFromPoints(points: Point[], radius = 8): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0.5) {
      d += ` L ${cur.x} ${cur.y}`;
      continue;
    }
    const inX = cur.x - ((cur.x - prev.x) / inLen) * r;
    const inY = cur.y - ((cur.y - prev.y) / inLen) * r;
    const outX = cur.x + ((next.x - cur.x) / outLen) * r;
    const outY = cur.y + ((next.y - cur.y) / outLen) * r;
    d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
