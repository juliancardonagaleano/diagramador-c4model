import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../model/sample';
import { deriveView } from '../model/viewDerivation';
import { layoutView, resolveLayoutParams } from './elkLayout';
import { buildCandidates, gridLayout, smartLayout } from './smartLayout';

describe('smartLayout (autocorrección y prioridad por nivel)', () => {
  it('C1 sale arriba→abajo, centrado y limpio; personas arriba y externos abajo', async () => {
    const r = await layoutView(sampleDocument, 'contexto', { force: true });
    expect(r.direction).toBe('DOWN');
    expect(r.distribution).toBe('centered');
    expect(r.quality!.strategy).toMatch(/^DOWN\/centered/);
    expect(r.quality!.crossings + r.quality!.edgeNodeOverlaps + r.quality!.labelOverlaps).toBe(0);
    const pos = Object.fromEntries(r.positions.map((p) => [p.id, p]));
    expect(pos.cliente.y).toBeLessThan(pos.banca.y);
    expect(pos.mainframe.y).toBeGreaterThan(pos.banca.y);
    // Capa central (banca) centrada respecto a la capa de externos.
    const externosCenter = (Math.min(pos.mainframe.x, pos.email.x) + Math.max(pos.mainframe.x + pos.mainframe.width, pos.email.x + pos.email.width)) / 2;
    expect(Math.abs(pos.banca.x + pos.banca.width / 2 - externosCenter)).toBeLessThanOrEqual(1);
  });

  it('C2 y C3 salen izquierda→derecha, centrados y limpios', async () => {
    for (const id of ['contenedores', 'componentes-api']) {
      const r = await layoutView(sampleDocument, id, { force: true });
      expect(r.direction).toBe('RIGHT');
      expect(r.distribution).toBe('centered');
      expect(r.quality!.crossings + r.quality!.edgeNodeOverlaps + r.quality!.labelOverlaps).toBe(0);
      const maxX = Math.max(...r.positions.map((p) => p.x + p.width));
      const maxY = Math.max(...r.positions.map((p) => p.y + p.height));
      expect(maxX).toBeGreaterThan(maxY);
      expect(r.routes.length).toBe(deriveView(sampleDocument, id).edges.length);
    }
  });

  it('una dirección fija solo prueba esa dirección; distribution=elk usa la colocación de ELK', async () => {
    const derived = deriveView(sampleDocument, 'contenedores');
    const fixed = buildCandidates(resolveLayoutParams(derived, { direction: 'LEFT' }));
    expect(fixed.every((c) => c.direction === 'LEFT')).toBe(true);
    const auto = buildCandidates(resolveLayoutParams(derived, {}));
    expect(auto[0]).toMatchObject({ direction: 'RIGHT', distribution: 'centered', preferred: true });
    expect(auto.some((c) => c.direction === 'DOWN')).toBe(true);
    const elk = await layoutView(sampleDocument, 'contenedores', { force: true, distribution: 'elk', direction: 'UP' });
    expect(elk.distribution).toBe('elk');
    expect(elk.direction).toBe('UP');
    const pos = Object.fromEntries(elk.positions.map((p) => [p.id, p]));
    expect(pos.cliente.y).toBeGreaterThan(pos.api.y);
  });

  it('la densidad ajusta el espaciado y "fast" hace una sola pasada', async () => {
    const derived = deriveView(sampleDocument, 'contenedores');
    const auto = resolveLayoutParams(derived, {});
    const compact = resolveLayoutParams(derived, { density: 'compact' });
    const spacious = resolveLayoutParams(derived, { density: 'spacious' });
    expect(compact.spacing).toBeLessThan(auto.spacing);
    expect(spacious.spacing).toBeGreaterThan(auto.spacing);
    const fast = await layoutView(sampleDocument, 'contenedores', { force: true, fast: true });
    expect(fast.quality?.candidates).toBeUndefined();
    const smart = await smartLayout(derived, auto);
    expect(smart.quality!.candidates).toBeGreaterThanOrEqual(1);
  });

  describe('cuadrícula de último recurso (cuando ELK falla en todos los candidatos)', () => {
    it('sin candidatos usa la cuadrícula en vez de fallar', async () => {
      const derived = deriveView(sampleDocument, 'contenedores');
      const r = await smartLayout(derived, resolveLayoutParams(derived, {}), []);
      expect(r.quality!.strategy).toMatch(/grid$/);
      expect(r.positions).toHaveLength(derived.nodes.length);
    });

    for (const id of ['contexto', 'contenedores', 'componentes-api']) {
      it(`gridLayout (${id}): posiciona todos los nodos sin solapes y los boundaries contienen solo a sus hijos`, () => {
        const derived = deriveView(sampleDocument, id);
        const r = gridLayout(derived, resolveLayoutParams(derived, {}));
        expect(r.positions.map((p) => p.id).sort()).toEqual(derived.nodes.map((n) => n.id).sort());
        for (let i = 0; i < r.positions.length; i++) {
          for (let j = i + 1; j < r.positions.length; j++) {
            const a = r.positions[i], b = r.positions[j];
            expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
          }
        }
        for (const b of r.boundaries) {
          const boundary = derived.boundaries.find((x) => x.id === b.id)!;
          const inside = new Set(derived.nodes.filter((n) => n.boundaryId === boundary.id).map((n) => n.id));
          for (const p of r.positions) {
            const within = p.x >= b.x && p.y >= b.y && p.x + p.width <= b.x + b.width && p.y + p.height <= b.y + b.height;
            if (inside.has(p.id)) expect(within).toBe(true);
            else if (!derived.boundaries.some((o) => o.boundaryId === boundary.id)) expect(within).toBe(false);
          }
        }
        expect(r.routes.length).toBe(derived.edges.length);
      });
    }
  });
});
