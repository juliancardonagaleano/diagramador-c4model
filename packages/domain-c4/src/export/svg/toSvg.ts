import { renderGraphSvg, type GraphLayout, type ShapeKind } from '@iark/kernel';
import { deriveView, viewBounds, type DerivedView } from '../../model/viewDerivation';
import { C4_COLORS, C4_EXTERNAL_COLOR, ELEMENT_TYPE_LABELS, type C4Document, type C4Element, type ElementShape } from '../../model/types';

export class SvgExportError extends Error {}

export interface SvgOptions {
  /** Vista a dibujar (por defecto, la primera). */
  viewId?: string;
}

/** Figura de un elemento C4 según su `shape`: las mismas figuras del lienzo de los módulos. */
const SHAPES: Record<ElementShape, ShapeKind> = { default: 'rect', database: 'cylinder', queue: 'pipe', browser: 'card', mobile: 'rounded' };

function fillOf(el: C4Element): string {
  if (el.color) return el.color;
  return el.external ? C4_EXTERNAL_COLOR : C4_COLORS[el.type];
}

function linesOf(el: C4Element): string[] {
  return [el.name, el.technology ? `[${el.technology}]` : '', el.description ?? ''].filter(Boolean);
}

function layoutOf(derived: DerivedView): GraphLayout {
  const bounds = viewBounds(derived);
  if (!bounds) throw new SvgExportError(`La vista "${derived.view.id}" no tiene elementos colocados.`);
  const unpositioned = derived.nodes.filter((n) => !n.positioned);
  if (unpositioned.length > 0) {
    throw new SvgExportError(`La vista "${derived.view.id}" tiene elementos sin posición (${unpositioned.map((n) => n.id).join(', ')}). Ejecute el autolayout antes de exportar.`);
  }
  const dx = -bounds.x;
  const dy = -bounds.y;
  const nodes = derived.nodes.map((n) => ({ id: n.id, x: n.x! + dx, y: n.y! + dy, width: n.width, height: n.height }));
  const groups = derived.boundaries
    .filter((b) => b.x !== undefined && b.y !== undefined && b.width !== undefined && b.height !== undefined)
    .map((b) => ({ id: b.id, x: b.x! + dx, y: b.y! + dy, width: b.width!, height: b.height! }));
  const boxes = new Map([...nodes, ...groups].map((b) => [b.id, b]));
  const routes = new Map((derived.view.edges ?? []).map((r) => [r.id, r]));
  const edges = derived.edges.flatMap((e) => {
    const route = routes.get(e.id);
    if (route && route.points.length >= 2) {
      return [{ id: e.id, points: route.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), label: route.label ? { x: route.label.x + dx, y: route.label.y + dy } : undefined }];
    }
    // Sin ruta del autolayout: una recta entre los bordes de los dos nodos.
    const a = boxes.get(e.sourceId);
    const b = boxes.get(e.targetId);
    if (!a || !b) return [];
    const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const clip = (box: { x: number; y: number; width: number; height: number }, c: { x: number; y: number }, other: { x: number; y: number }) => {
      const vx = other.x - c.x;
      const vy = other.y - c.y;
      const t = Math.min(vx === 0 ? Infinity : box.width / 2 / Math.abs(vx), vy === 0 ? Infinity : box.height / 2 / Math.abs(vy));
      return { x: c.x + vx * t, y: c.y + vy * t };
    };
    const start = clip(a, from, to);
    const end = clip(b, to, from);
    return [{ id: e.id, points: [start, end], label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } }];
  });
  return { nodes, groups, edges, width: bounds.width, height: bounds.height };
}

/** Dibuja una vista C4 como SVG autocontenido con las figuras y colores C4 (persona, sistema, contenedor, componente). */
export function toSvg(doc: C4Document, options: SvgOptions = {}): string {
  const viewId = options.viewId ?? doc.views[0]?.id;
  if (!viewId) throw new SvgExportError('El documento no tiene vistas que exportar');
  const derived = deriveView(doc, viewId);
  const layout = layoutOf(derived);
  const nodes = new Map(derived.nodes.map((n) => [n.id, n]));
  const boundaries = new Map(derived.boundaries.map((b) => [b.id, b]));
  const edges = new Map(derived.edges.map((e) => [e.id, e]));
  return renderGraphSvg(layout, {
    title: derived.view.title ?? `${doc.workspace.name} - ${viewId}`,
    node: (id) => {
      const el = nodes.get(id)!.element;
      return {
        fill: fillOf(el),
        stroke: '#0f172a55',
        badge: `${ELEMENT_TYPE_LABELS[el.type]}${el.external ? ' externo' : ''}`,
        lines: linesOf(el),
        shape: el.type === 'person' ? 'actor' : SHAPES[el.shape ?? 'default'],
        dashed: el.external === true,
        maxLines: 3,
      };
    },
    edge: (id) => {
      const rel = edges.get(id)!.relationship;
      return { stroke: '#475569', width: 1.5, dashed: edges.get(id)!.implied, label: [rel.description, rel.technology ? `[${rel.technology}]` : ''].filter(Boolean).join(' ') || undefined };
    },
    group: (id) => {
      const el = boundaries.get(id)!.element;
      return { label: `${ELEMENT_TYPE_LABELS[el.type]}: ${el.name}` };
    },
  });
}
