import type { LayoutDirection } from '../model/types';
import { computeEdgeAnchors, labelPosition, routeEdge, type EdgeRef, type Point, type Rect } from './edgeAnchors';
import type { LabelSize } from './labelMetrics';

/**
 * Métrica de calidad de un layout: cruces entre aristas, aristas que atraviesan
 * nodos, etiquetas que pisan nodos u otras etiquetas, área y proporción.
 * Se calcula con los mismos anclajes y rutas que dibuja la app.
 */

export interface LayoutQuality {
  crossings: number;
  edgeNodeOverlaps: number;
  labelOverlaps: number;
  area: number;
  aspect: number;
  score: number;
  /** Nombre de la estrategia ganadora y número de candidatos probados (lo rellena smartLayout). */
  strategy?: string;
  candidates?: number;
}

export interface MeasuredEdge extends EdgeRef {
  label?: LabelSize | null;
}

export interface EdgeRoute {
  points: Point[];
  /** Centro de la etiqueta colocada por el motor de layout. */
  label?: Point;
}

export interface MeasureInput {
  nodes: Rect[];
  boundaries?: Rect[];
  edges: MeasuredEdge[];
  direction?: LayoutDirection;
  /** Rutas ya calculadas (p. ej. por ELK); las aristas sin ruta usan anclajes calculados. */
  routes?: Map<string, EdgeRoute>;
}

/**
 * Comprueba que una ruta almacenada sigue siendo válida para las posiciones
 * actuales: sus extremos deben estar sobre el borde (±tolerancia) de origen y destino.
 */
export function routeMatchesNodes(route: EdgeRoute, source: Rect, target: Rect, tolerance = 3): boolean {
  if (route.points.length < 2) return false;
  const onBorder = (p: Point, r: Rect) => {
    const inX = p.x >= r.x - tolerance && p.x <= r.x + r.width + tolerance;
    const inY = p.y >= r.y - tolerance && p.y <= r.y + r.height + tolerance;
    const nearVertical = Math.abs(p.x - r.x) <= tolerance || Math.abs(p.x - (r.x + r.width)) <= tolerance;
    const nearHorizontal = Math.abs(p.y - r.y) <= tolerance || Math.abs(p.y - (r.y + r.height)) <= tolerance;
    return inX && inY && (nearVertical || nearHorizontal);
  };
  return onBorder(route.points[0], source) && onBorder(route.points[route.points.length - 1], target);
}

interface Segment {
  a: Point;
  b: Point;
}

function orientation(p: Point, q: Point, r: Point): number {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return q.x <= Math.max(p.x, r.x) + 1e-9 && q.x >= Math.min(p.x, r.x) - 1e-9 && q.y <= Math.max(p.y, r.y) + 1e-9 && q.y >= Math.min(p.y, r.y) - 1e-9;
}

export function segmentsIntersect(s1: Segment, s2: Segment): boolean {
  const o1 = orientation(s1.a, s1.b, s2.a);
  const o2 = orientation(s1.a, s1.b, s2.b);
  const o3 = orientation(s2.a, s2.b, s1.a);
  const o4 = orientation(s2.a, s2.b, s1.b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(s1.a, s2.a, s1.b)) return true;
  if (o2 === 0 && onSegment(s1.a, s2.b, s1.b)) return true;
  if (o3 === 0 && onSegment(s2.a, s1.a, s2.b)) return true;
  if (o4 === 0 && onSegment(s2.a, s1.b, s2.b)) return true;
  return false;
}

function segmentIntersectsRect(s: Segment, r: Rect, margin = 0): boolean {
  const x1 = r.x - margin;
  const y1 = r.y - margin;
  const x2 = r.x + r.width + margin;
  const y2 = r.y + r.height + margin;
  const inside = (p: Point) => p.x > x1 && p.x < x2 && p.y > y1 && p.y < y2;
  if (inside(s.a) || inside(s.b)) return true;
  const edges: Segment[] = [
    { a: { x: x1, y: y1 }, b: { x: x2, y: y1 } },
    { a: { x: x2, y: y1 }, b: { x: x2, y: y2 } },
    { a: { x: x2, y: y2 }, b: { x: x1, y: y2 } },
    { a: { x: x1, y: y2 }, b: { x: x1, y: y1 } },
  ];
  return edges.some((e) => segmentsIntersect(s, e));
}

function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x - margin < b.x + b.width && b.x - margin < a.x + a.width && a.y - margin < b.y + b.height && b.y - margin < a.y + a.height;
}

function toSegments(points: Point[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
    segs.push({ a, b });
  }
  return segs;
}

export function scoreQuality(q: Omit<LayoutQuality, 'score'>): number {
  const aspectPenalty = q.aspect > 3 ? (q.aspect - 3) * 50 : 0;
  return 100 * q.crossings + 150 * q.edgeNodeOverlaps + 40 * q.labelOverlaps + q.area / 2e5 + aspectPenalty;
}

export function measureLayout(input: MeasureInput): LayoutQuality {
  const direction = input.direction ?? 'DOWN';
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const anchors = computeEdgeAnchors(input.nodes, input.edges, direction);

  const routes = new Map<string, { edge: MeasuredEdge; segments: Segment[]; labelRect: Rect | null }>();
  for (const edge of input.edges) {
    const source = nodeById.get(edge.sourceId);
    const target = nodeById.get(edge.targetId);
    const stored = input.routes?.get(edge.id);
    let points: Point[];
    let labelCenter: Point | undefined;
    if (stored && source && target && routeMatchesNodes(stored, source, target)) {
      points = stored.points;
      labelCenter = stored.label;
    } else {
      const a = anchors.get(edge.id);
      if (!a) continue;
      points = routeEdge(a.source, a.target);
    }
    const segments = toSegments(points);
    let labelRect: Rect | null = null;
    if (edge.label) {
      const p = labelCenter ?? labelPosition(points);
      labelRect = { id: `label:${edge.id}`, x: p.x - edge.label.width / 2, y: p.y - edge.label.height / 2, width: edge.label.width, height: edge.label.height };
    }
    routes.set(edge.id, { edge, segments, labelRect });
  }

  const list = [...routes.values()];
  let crossings = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const e1 = list[i].edge;
      const e2 = list[j].edge;
      const shared = new Set([e1.sourceId, e1.targetId]);
      if (shared.has(e2.sourceId) || shared.has(e2.targetId)) continue; // comparten nodo: el abanico no cuenta
      let crossed = false;
      for (const s1 of list[i].segments) {
        for (const s2 of list[j].segments) {
          if (segmentsIntersect(s1, s2)) {
            crossed = true;
            break;
          }
        }
        if (crossed) break;
      }
      if (crossed) crossings += 1;
    }
  }

  let edgeNodeOverlaps = 0;
  for (const r of list) {
    for (const node of input.nodes) {
      if (node.id === r.edge.sourceId || node.id === r.edge.targetId) continue;
      if (r.segments.some((s) => segmentIntersectsRect(s, node, 1))) {
        edgeNodeOverlaps += 1;
        break;
      }
    }
  }

  let labelOverlaps = 0;
  const labels = list.map((r) => r.labelRect).filter((l): l is Rect => !!l);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (input.nodes.some((n) => rectsOverlap(l, n, -2))) labelOverlaps += 1;
    for (let j = i + 1; j < labels.length; j++) if (rectsOverlap(l, labels[j])) labelOverlaps += 1;
  }

  const all = [...input.nodes, ...(input.boundaries ?? [])];
  let area = 0;
  let aspect = 1;
  if (all.length > 0) {
    const minX = Math.min(...all.map((r) => r.x));
    const minY = Math.min(...all.map((r) => r.y));
    const maxX = Math.max(...all.map((r) => r.x + r.width));
    const maxY = Math.max(...all.map((r) => r.y + r.height));
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    area = w * h;
    aspect = Math.max(w / h, h / w);
  }
  const partial = { crossings, edgeNodeOverlaps, labelOverlaps, area, aspect };
  return { ...partial, score: scoreQuality(partial) };
}

export function formatQuality(q: LayoutQuality): string {
  const parts = [`${q.crossings} cruce${q.crossings === 1 ? '' : 's'}`, `${q.edgeNodeOverlaps + q.labelOverlaps} solape${q.edgeNodeOverlaps + q.labelOverlaps === 1 ? '' : 's'}`];
  if (q.candidates) parts.push(`${q.candidates} candidato${q.candidates === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
