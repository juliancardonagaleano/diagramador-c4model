import { describe, expect, it } from 'vitest';
import { computeEdgeAnchors, routeEdge, labelPosition, type Rect } from './edgeAnchors';
import { measureLayout } from './quality';
import { estimateLabelSize } from './labelMetrics';

const r = (id: string, x: number, y: number, w = 200, h = 100): Rect => ({ id, x, y, width: w, height: h });

describe('computeEdgeAnchors', () => {
  it('reparte tres aristas que salen por el mismo lado en puntos distintos y ordenados', () => {
    const rects = [r('src', 400, 0), r('a', 0, 300), r('b', 400, 300), r('c', 800, 300)];
    const edges = [
      { id: 'e-c', sourceId: 'src', targetId: 'c' },
      { id: 'e-a', sourceId: 'src', targetId: 'a' },
      { id: 'e-b', sourceId: 'src', targetId: 'b' },
    ];
    const anchors = computeEdgeAnchors(rects, edges, 'DOWN');
    const xs = ['e-a', 'e-b', 'e-c'].map((id) => anchors.get(id)!.source.x);
    expect(new Set(xs).size).toBe(3);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    for (const id of ['e-a', 'e-b', 'e-c']) {
      expect(anchors.get(id)!.source.side).toBe('bottom');
      expect(anchors.get(id)!.target.side).toBe('top');
    }
  });

  it('elige lados horizontales cuando el otro nodo está claramente al lado', () => {
    const rects = [r('a', 0, 0), r('b', 500, 10)];
    const anchors = computeEdgeAnchors(rects, [{ id: 'e', sourceId: 'a', targetId: 'b' }], 'DOWN');
    expect(anchors.get('e')!.source.side).toBe('right');
    expect(anchors.get('e')!.target.side).toBe('left');
  });

  it('routeEdge produce una ruta ortogonal con quiebre a mitad de camino', () => {
    const pts = routeEdge({ x: 100, y: 100, side: 'bottom' }, { x: 300, y: 400, side: 'top' });
    expect(pts).toHaveLength(4);
    expect(pts[1]).toEqual({ x: 100, y: 250 });
    expect(pts[2]).toEqual({ x: 300, y: 250 });
    const label = labelPosition(pts);
    expect(label.y).toBe(250);
  });
});

describe('measureLayout', () => {
  it('cuenta un cruce entre dos aristas en X y ninguno entre paralelas', () => {
    const rects = [r('a', 0, 0), r('b', 400, 0), r('c', 0, 400), r('d', 400, 400)];
    const crossed = measureLayout({ nodes: rects, edges: [{ id: '1', sourceId: 'a', targetId: 'd' }, { id: '2', sourceId: 'b', targetId: 'c' }] });
    expect(crossed.crossings).toBe(1);
    const parallel = measureLayout({ nodes: rects, edges: [{ id: '1', sourceId: 'a', targetId: 'c' }, { id: '2', sourceId: 'b', targetId: 'd' }] });
    expect(parallel.crossings).toBe(0);
    expect(parallel.score).toBeLessThan(crossed.score);
  });

  it('detecta una arista que atraviesa un nodo ajeno', () => {
    const rects = [r('a', 0, 0), r('mid', 0, 300), r('b', 0, 600)];
    const q = measureLayout({ nodes: rects, edges: [{ id: '1', sourceId: 'a', targetId: 'b' }] });
    expect(q.edgeNodeOverlaps).toBe(1);
    const clean = measureLayout({ nodes: [r('a', 0, 0), r('mid', 500, 300), r('b', 0, 600)], edges: [{ id: '1', sourceId: 'a', targetId: 'b' }] });
    expect(clean.edgeNodeOverlaps).toBe(0);
  });

  it('detecta etiquetas que pisan nodos', () => {
    const label = estimateLabelSize('Consulta sus cuentas y hace pagos', 'HTTPS');
    expect(label).not.toBeNull();
    // Nodos muy cerca: la etiqueta centrada entre a y b cae sobre ambos.
    const tight = measureLayout({ nodes: [r('a', 0, 0), r('b', 0, 110)], edges: [{ id: '1', sourceId: 'a', targetId: 'b', label }] });
    expect(tight.labelOverlaps).toBeGreaterThan(0);
    const roomy = measureLayout({ nodes: [r('a', 0, 0), r('b', 0, 300)], edges: [{ id: '1', sourceId: 'a', targetId: 'b', label }] });
    expect(roomy.labelOverlaps).toBe(0);
  });
});
