import type { Point } from './layout';

/** Punto medio de una poligonal, medido sobre su longitud. */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : Math.min(1, left / lengths[i]);
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    left -= lengths[i];
  }
  return points[0];
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Trazado SVG de una ruta ortogonal con los codos redondeados (radio `radius`, menor si el tramo es corto): el mismo aspecto que
 * da React Flow a sus líneas de ángulos rectos, pero pasando por todos los puntos de la ruta. Sirve al lienzo para pintar las rutas
 * con varios codos que fija la colocación de una vista (`EdgeRoute.points`).
 */
export function routePath(points: readonly Point[], radius = 5): string {
  if (points.length === 0) return '';
  const out = [`M${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const [inLen, outLen] = [Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y)];
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0) {
      out.push(`L${round(b.x)} ${round(b.y)}`);
      continue;
    }
    const before = { x: b.x - ((b.x - a.x) / inLen) * r, y: b.y - ((b.y - a.y) / inLen) * r };
    const after = { x: b.x + ((c.x - b.x) / outLen) * r, y: b.y + ((c.y - b.y) / outLen) * r };
    out.push(`L${round(before.x)} ${round(before.y)}`, `Q${round(b.x)} ${round(b.y)} ${round(after.x)} ${round(after.y)}`);
  }
  if (points.length > 1) out.push(`L${round(points[points.length - 1].x)} ${round(points[points.length - 1].y)}`);
  return out.join(' ');
}
