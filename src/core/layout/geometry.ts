import type { LayoutDirection } from '../model/types';
import type { Point, Rect } from './edgeAnchors';

/**
 * Coordenadas (flujo, transversal) independientes de la dirección del layout:
 * en DOWN/UP el flujo es `y` y lo transversal `x`; en RIGHT/LEFT al revés.
 */
export interface FC {
  flow: number;
  cross: number;
}

export function isVertical(direction: LayoutDirection): boolean {
  return direction === 'DOWN' || direction === 'UP';
}

export function toFC(p: Point, direction: LayoutDirection): FC {
  return isVertical(direction) ? { flow: p.y, cross: p.x } : { flow: p.x, cross: p.y };
}

export function fromFC(fc: FC, direction: LayoutDirection): Point {
  return isVertical(direction) ? { x: fc.cross, y: fc.flow } : { x: fc.flow, y: fc.cross };
}

/** Rectángulo en coordenadas (flujo, transversal). */
export interface FCRect {
  id: string;
  flow: number;
  cross: number;
  flowSize: number;
  crossSize: number;
}

export function rectToFC(r: Rect, direction: LayoutDirection): FCRect {
  return isVertical(direction)
    ? { id: r.id, flow: r.y, cross: r.x, flowSize: r.height, crossSize: r.width }
    : { id: r.id, flow: r.x, cross: r.y, flowSize: r.width, crossSize: r.height };
}

export function rectFromFC(r: FCRect, direction: LayoutDirection): Rect {
  return isVertical(direction)
    ? { id: r.id, x: r.cross, y: r.flow, width: r.crossSize, height: r.flowSize }
    : { id: r.id, x: r.flow, y: r.cross, width: r.flowSize, height: r.crossSize };
}
