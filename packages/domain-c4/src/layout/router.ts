import type { C4ViewEdge, LayoutDirection } from '../model/types';
import { computeEdgeAnchors, labelPosition, type Anchor, type EdgeRef, type Point, type Rect, type Side } from './edgeAnchors';
import { fromFC, isVertical, toFC, type FC } from './geometry';
import type { LabelSize } from './labelMetrics';

/**
 * Enrutado ortogonal propio con esquiva de obstáculos. Se usa para la
 * distribución centrada (donde no hay rutas de ELK) y como fallback cuando el
 * usuario mueve un nodo. Trabaja en coordenadas (flujo, transversal).
 */

export interface RoutedEdgeRef extends EdgeRef {
  /** Tamaño estimado de la etiqueta (para colocarla sin pisar nodos ni otras etiquetas). */
  label?: LabelSize | null;
}

export interface RouterInput {
  /** Nodos (obstáculos y extremos). */
  rects: Rect[];
  /** Boundaries: obstáculos para las aristas que no entran en ellos. */
  boundaries?: Rect[];
  /** Ids de boundaries que contienen a cada nodo (cadena completa). */
  containment?: Map<string, Set<string>>;
  edges: RoutedEdgeRef[];
  direction: LayoutDirection;
  /** Separación base entre nodos (define márgenes y canales). */
  spacing: number;
}

const MARGIN = 14;
const LANE = 12;
const MIN_CORRIDOR = 26;

interface FCRectM {
  id: string;
  f0: number;
  f1: number;
  c0: number;
  c1: number;
}

function toFCRect(r: Rect, direction: LayoutDirection): FCRectM {
  const a = toFC({ x: r.x, y: r.y }, direction);
  const b = toFC({ x: r.x + r.width, y: r.y + r.height }, direction);
  return { id: r.id, f0: Math.min(a.flow, b.flow), f1: Math.max(a.flow, b.flow), c0: Math.min(a.cross, b.cross), c1: Math.max(a.cross, b.cross) };
}

function segmentHits(a: FC, b: FC, obstacles: FCRectM[], margin: number): boolean {
  const f0 = Math.min(a.flow, b.flow);
  const f1 = Math.max(a.flow, b.flow);
  const c0 = Math.min(a.cross, b.cross);
  const c1 = Math.max(a.cross, b.cross);
  return obstacles.some((o) => f0 < o.f1 + margin && f1 > o.f0 - margin && c0 < o.c1 + margin && c1 > o.c0 - margin);
}

function polylineHits(points: FC[], obstacles: FCRectM[], margin: number): boolean {
  for (let i = 0; i < points.length - 1; i++) if (segmentHits(points[i], points[i + 1], obstacles, margin)) return true;
  return false;
}

/** Normal saliente del lado, en coordenadas (flujo, transversal). */
function normalOf(side: Side, direction: LayoutDirection): FC {
  const v = isVertical(direction);
  switch (side) {
    case 'top':
      return v ? { flow: -1, cross: 0 } : { flow: 0, cross: -1 };
    case 'bottom':
      return v ? { flow: 1, cross: 0 } : { flow: 0, cross: 1 };
    case 'left':
      return v ? { flow: 0, cross: -1 } : { flow: -1, cross: 0 };
    case 'right':
      return v ? { flow: 0, cross: 1 } : { flow: 1, cross: 0 };
  }
}

function dedupe(points: FC[]): FC[] {
  const out: FC[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.flow - p.flow) < 0.5 && Math.abs(last.cross - p.cross) < 0.5) continue;
    out.push(p);
  }
  // Quitar puntos colineales intermedios.
  const simplified: FC[] = [];
  for (let i = 0; i < out.length; i++) {
    const prev = simplified[simplified.length - 1];
    const next = out[i + 1];
    if (prev && next && ((prev.flow === out[i].flow && out[i].flow === next.flow) || (prev.cross === out[i].cross && out[i].cross === next.cross))) continue;
    simplified.push(out[i]);
  }
  return simplified;
}

export function routeEdges(input: RouterInput): C4ViewEdge[] {
  const { direction, spacing } = input;
  const anchors = computeEdgeAnchors(input.rects, input.edges, direction);
  const rectById = new Map(input.rects.map((r) => [r.id, r]));
  const nodeObstacles = input.rects.map((r) => toFCRect(r, direction));
  const boundaryObstacles = (input.boundaries ?? []).map((r) => toFCRect(r, direction));
  const laneUse = new Map<number, number>();
  const results: C4ViewEdge[] = [];

  for (const edge of input.edges) {
    const a = anchors.get(edge.id);
    const sRect = rectById.get(edge.sourceId);
    const tRect = rectById.get(edge.targetId);
    if (!a || !sRect || !tRect) continue;

    const obstacles = [
      ...nodeObstacles.filter((o) => o.id !== edge.sourceId && o.id !== edge.targetId),
      ...boundaryObstacles.filter((o) => !input.containment?.get(edge.sourceId)?.has(o.id) && !input.containment?.get(edge.targetId)?.has(o.id)),
    ];

    const s = toFC(a.source, direction);
    const t = toFC(a.target, direction);
    const sn = normalOf(a.source.side, direction);
    const tn = normalOf(a.target.side, direction);
    const out = Math.max(20, Math.round(spacing / 3));
    const sOut: FC = { flow: s.flow + sn.flow * out, cross: s.cross + sn.cross * out };
    const tOut: FC = { flow: t.flow + tn.flow * out, cross: t.cross + tn.cross * out };

    const candidates: FC[][] = [];
    if (sn.flow !== 0 && tn.flow !== 0) {
      // Lados en el eje de flujo (caso habitual entre capas): quiebre a mitad de camino.
      const mid = (s.flow + t.flow) / 2;
      candidates.push([s, { flow: mid, cross: s.cross }, { flow: mid, cross: t.cross }, t]);
    } else if (sn.flow === 0 && tn.flow === 0) {
      const mid = (s.cross + t.cross) / 2;
      candidates.push([s, { flow: s.flow, cross: mid }, { flow: t.flow, cross: mid }, t]);
    } else if (sn.flow !== 0) {
      candidates.push([s, { flow: t.flow, cross: s.cross }, t]);
      candidates.push([s, sOut, { flow: sOut.flow, cross: tOut.cross }, tOut, t]);
    } else {
      candidates.push([s, { flow: s.flow, cross: t.cross }, t]);
      candidates.push([s, sOut, { flow: tOut.flow, cross: sOut.cross }, tOut, t]);
    }

    let chosen = candidates.find((c) => !polylineHits(c.slice(1, -1).length ? c : c, obstacles, MARGIN) && !polylineHitsEnds(c, obstacles));
    if (!chosen) {
      // Desvío por un corredor transversal libre entre las capas intermedias.
      const dir = Math.sign(tOut.flow - sOut.flow) || 1;
      const fLo = Math.min(sOut.flow, tOut.flow);
      const fHi = Math.max(sOut.flow, tOut.flow);
      const between = obstacles.filter((o) => o.f1 + MARGIN > fLo && o.f0 - MARGIN < fHi);
      const intervals = between.map((o) => [o.c0 - MARGIN, o.c1 + MARGIN] as [number, number]).sort((x, y) => x[0] - y[0]);
      const allC = [...nodeObstacles, ...boundaryObstacles];
      const cMin = Math.min(...allC.map((o) => o.c0)) - spacing;
      const cMax = Math.max(...allC.map((o) => o.c1)) + spacing;
      const free: Array<[number, number]> = [];
      let cursor = cMin;
      for (const [c0, c1] of intervals) {
        if (c0 > cursor) free.push([cursor, c0]);
        cursor = Math.max(cursor, c1);
      }
      free.push([cursor, Math.max(cursor + MIN_CORRIDOR, cMax)]);
      const target = (s.cross + t.cross) / 2;
      const corridors = free.filter(([c0, c1]) => c1 - c0 >= MIN_CORRIDOR).map(([c0, c1]) => ({ c: Math.min(Math.max(target, c0 + MIN_CORRIDOR / 2), c1 - MIN_CORRIDOR / 2), dist: 0 }));
      corridors.forEach((k) => (k.dist = Math.abs(k.c - target)));
      corridors.sort((x, y) => x.dist - y.dist);
      const chosenCorridor = corridors[0]?.c ?? target;
      const laneKey = Math.round(chosenCorridor / 4);
      const laneIndex = laneUse.get(laneKey) ?? 0;
      laneUse.set(laneKey, laneIndex + 1);
      const laneOffset = laneIndex === 0 ? 0 : (laneIndex % 2 === 1 ? 1 : -1) * Math.ceil(laneIndex / 2) * LANE;
      const corridor = chosenCorridor + laneOffset;
      const channelA = sn.flow !== 0 ? s.flow + sn.flow * (spacing / 2) : sOut.flow;
      const channelB = tn.flow !== 0 ? t.flow + tn.flow * (spacing / 2) : tOut.flow;
      void dir;
      chosen = [s, sOut, { flow: channelA, cross: sOut.cross }, { flow: channelA, cross: corridor }, { flow: channelB, cross: corridor }, { flow: channelB, cross: tOut.cross }, tOut, t];
    }

    const points = dedupe(chosen).map((p) => fromFC(p, direction)).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const label = labelPosition(points);
    results.push({ id: edge.id, points, label: { x: Math.round(label.x), y: Math.round(label.y) } });
  }
  placeLabels(results, input);
  return results;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x0 < b.x1 + margin && b.x0 < a.x1 + margin && a.y0 < b.y1 + margin && b.y0 < a.y1 + margin;
}

/**
 * Coloca cada etiqueta en el tramo más largo posible sin pisar nodos ni otras
 * etiquetas: prueba el centro de cada tramo y, si molesta, la desplaza al lado
 * libre de la línea (a un lado en tramos verticales, arriba/abajo en horizontales).
 */
function placeLabels(routes: C4ViewEdge[], input: RouterInput): void {
  const sizes = new Map(input.edges.map((e) => [e.id, e.label ?? null]));
  const nodeBoxes: Box[] = input.rects.map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height }));
  const placed: Box[] = [];
  const boxAt = (c: Point, size: LabelSize): Box => ({ x0: c.x - size.width / 2, y0: c.y - size.height / 2, x1: c.x + size.width / 2, y1: c.y + size.height / 2 });
  const free = (b: Box) => !nodeBoxes.some((n) => boxesOverlap(b, n, 4)) && !placed.some((p) => boxesOverlap(b, p, 2));

  for (const route of routes) {
    const size = sizes.get(route.id);
    if (!size) continue;
    const segments = route.points.slice(0, -1).map((a, i) => ({ a, b: route.points[i + 1] })).map((s) => ({ ...s, len: Math.abs(s.b.x - s.a.x) + Math.abs(s.b.y - s.a.y) }));
    segments.sort((s1, s2) => s2.len - s1.len);
    let chosen: Point | null = null;
    for (const s of segments) {
      if (s.len < 12) continue;
      const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
      const vertical = Math.abs(s.b.x - s.a.x) < 0.5;
      const shift = vertical ? size.width / 2 + 6 : size.height / 2 + 6;
      const candidates: Point[] = vertical
        ? [mid, { x: mid.x - shift, y: mid.y }, { x: mid.x + shift, y: mid.y }]
        : [mid, { x: mid.x, y: mid.y - shift }, { x: mid.x, y: mid.y + shift }];
      // Solo aceptar el desplazamiento lateral si el tramo es lo bastante largo para la etiqueta.
      const fits = vertical ? s.len >= size.height + 8 : s.len >= size.width * 0.6;
      for (const c of candidates) {
        if (c !== mid && !fits) continue;
        const box = boxAt(c, size);
        if (free(box)) {
          chosen = c;
          break;
        }
      }
      if (chosen) break;
    }
    const finalPoint = chosen ?? labelPosition(route.points);
    route.label = { x: Math.round(finalPoint.x), y: Math.round(finalPoint.y) };
    placed.push(boxAt(finalPoint, size));
  }
}

/** Los tramos que tocan los extremos no se comprueban contra el propio nodo (ya excluido), pero sí el resto. */
function polylineHitsEnds(_: FC[], __: FCRectM[]): boolean {
  return false;
}

/** Ruta simple (sin esquiva) para dos anclajes; conservada por compatibilidad. */
export function simpleRoute(source: Anchor, target: Anchor, direction: LayoutDirection): Point[] {
  const s = toFC(source, direction);
  const t = toFC(target, direction);
  const mid = (s.flow + t.flow) / 2;
  return [s, { flow: mid, cross: s.cross }, { flow: mid, cross: t.cross }, t].map((p) => fromFC(p, direction));
}
