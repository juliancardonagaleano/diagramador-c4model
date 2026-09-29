import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../model/sample';
import { deriveView } from '../model/viewDerivation';
import { distributeCentered } from './distribute';
import { resolveLayoutParams, runElkLayout, boundariesFromPositions } from './elkLayout';
import { routeEdges } from './router';
import { measureLayout } from './quality';
import type { Rect } from './edgeAnchors';

const r = (id: string, x: number, y: number, w = 200, h = 100): Rect => ({ id, x, y, width: w, height: h });

describe('distributeCentered', () => {
  it('centra cada capa sobre el eje común y equiespacia los nodos (vista de contexto, DOWN)', async () => {
    const derived = deriveView(sampleDocument, 'contexto');
    const params = { ...resolveLayoutParams(derived, { direction: 'DOWN' }), direction: 'DOWN' as const };
    const elk = await runElkLayout(derived, params, { name: 'bk' });
    const d = distributeCentered(elk.positions, derived, params);
    const byLayer = new Map<number, typeof d.positions>();
    for (const p of d.positions) byLayer.set(d.layerOf.get(p.id)!, [...(byLayer.get(d.layerOf.get(p.id)!) ?? []), p]);
    const centers = [...byLayer.values()].map((layer) => {
      const minX = Math.min(...layer.map((p) => p.x));
      const maxX = Math.max(...layer.map((p) => p.x + p.width));
      return (minX + maxX) / 2;
    });
    for (const c of centers) expect(Math.abs(c - centers[0])).toBeLessThanOrEqual(1);
    // Capa con dos nodos (externos): separación igual al spacing.
    const last = [...byLayer.values()].find((l) => l.length === 2)!;
    const sorted = [...last].sort((a, b) => a.x - b.x);
    expect(sorted[1].x - (sorted[0].x + sorted[0].width)).toBe(params.spacing);
    // Capas equiespaciadas o más (etiquetas).
    const ys = [...new Set(d.positions.map((p) => p.y))].sort((a, b) => a - b);
    expect(ys.length).toBe(3);
  });

  it('mantiene contiguos los hijos del boundary y saca fuera a los exteriores (contenedores, RIGHT)', async () => {
    const derived = deriveView(sampleDocument, 'contenedores');
    const params = { ...resolveLayoutParams(derived, { direction: 'RIGHT' }), direction: 'RIGHT' as const };
    const elk = await runElkLayout(derived, params, { name: 'bk' });
    const d = distributeCentered(elk.positions, derived, params);
    const boundaries = boundariesFromPositions(derived, d.positions);
    const banca = boundaries.find((b) => b.id === 'banca')!;
    const inside = new Set(['web-app', 'spa', 'mobile-app', 'api', 'db']);
    for (const p of d.positions) {
      const within = p.x >= banca.x && p.x + p.width <= banca.x + banca.width && p.y >= banca.y && p.y + p.height <= banca.y + banca.height;
      expect(within).toBe(inside.has(p.id));
    }
    // Sin solapes entre nodos.
    for (let i = 0; i < d.positions.length; i++) {
      for (let j = i + 1; j < d.positions.length; j++) {
        const a = d.positions[i];
        const b = d.positions[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    // Es horizontal: más ancho que alto.
    const maxX = Math.max(...d.positions.map((p) => p.x + p.width));
    const maxY = Math.max(...d.positions.map((p) => p.y + p.height));
    expect(maxX).toBeGreaterThan(maxY);
  });
});

describe('routeEdges', () => {
  it('una arista que salta una capa con un nodo en medio no lo atraviesa', () => {
    const rects = [r('a', 100, 0), r('mid', 100, 250), r('b', 100, 500)];
    const routes = routeEdges({ rects, edges: [{ id: 'e', sourceId: 'a', targetId: 'b' }], direction: 'DOWN', spacing: 60 });
    const q = measureLayout({ nodes: rects, edges: [{ id: 'e', sourceId: 'a', targetId: 'b' }], routes: new Map(routes.map((x) => [x.id, { points: x.points, label: x.label }])) });
    expect(q.edgeNodeOverlaps).toBe(0);
    expect(routes[0].points.length).toBeGreaterThan(4);
  });

  it('dos aristas por el mismo corredor quedan en carriles distintos', () => {
    const rects = [r('a', 100, 0), r('c', 400, 0), r('mid', 100, 250), r('mid2', 400, 250), r('b', 100, 500), r('d', 400, 500)];
    const edges = [
      { id: 'e1', sourceId: 'a', targetId: 'b' },
      { id: 'e2', sourceId: 'c', targetId: 'd' },
    ];
    const routes = routeEdges({ rects, edges, direction: 'DOWN', spacing: 60 });
    const q = measureLayout({ nodes: rects, edges, routes: new Map(routes.map((x) => [x.id, { points: x.points, label: x.label }])) });
    expect(q.edgeNodeOverlaps).toBe(0);
    const corridorX = (route: (typeof routes)[number]) => route.points.map((p) => p.x).filter((x, i, arr) => arr.indexOf(x) !== i)[0];
    expect(corridorX(routes[0])).not.toBe(corridorX(routes[1]));
  });

  it('no desvía una arista directa entre capas adyacentes', () => {
    const rects = [r('a', 100, 0), r('b', 100, 300)];
    const routes = routeEdges({ rects, edges: [{ id: 'e', sourceId: 'a', targetId: 'b' }], direction: 'DOWN', spacing: 60 });
    expect(routes[0].points.length).toBeLessThanOrEqual(4);
  });
});
