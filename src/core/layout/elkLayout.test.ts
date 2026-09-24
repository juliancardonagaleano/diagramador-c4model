import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../model/sample';
import { deriveView } from '../model/viewDerivation';
import { autoLayoutDocument, layoutView } from './elkLayout';

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutView (ELK)', () => {
  it('posiciona todos los nodos de la vista de contexto sin solapes', async () => {
    const r = await layoutView(sampleDocument, 'contexto');
    expect(r.positions).toHaveLength(4);
    for (let i = 0; i < r.positions.length; i++) {
      for (let j = i + 1; j < r.positions.length; j++) {
        expect(overlaps(r.positions[i], r.positions[j])).toBe(false);
      }
    }
  });

  it('mantiene los contenedores dentro del boundary del sistema', async () => {
    const r = await layoutView(sampleDocument, 'contenedores');
    const banca = r.boundaries.find((b) => b.id === 'banca');
    expect(banca).toBeDefined();
    for (const id of ['api', 'db', 'spa', 'web-app', 'mobile-app']) {
      const p = r.positions.find((x) => x.id === id)!;
      expect(p.x).toBeGreaterThanOrEqual(banca!.x);
      expect(p.y).toBeGreaterThanOrEqual(banca!.y);
      expect(p.x + p.width).toBeLessThanOrEqual(banca!.x + banca!.width);
      expect(p.y + p.height).toBeLessThanOrEqual(banca!.y + banca!.height);
    }
    const cliente = r.positions.find((x) => x.id === 'cliente')!;
    expect(overlaps(cliente, banca!)).toBe(false);
  });

  it('respeta la dirección RIGHT (las capas avanzan en x)', async () => {
    const r = await layoutView(sampleDocument, 'contexto', { direction: 'RIGHT' });
    const cliente = r.positions.find((x) => x.id === 'cliente')!;
    const banca = r.positions.find((x) => x.id === 'banca')!;
    expect(banca.x).toBeGreaterThan(cliente.x);
  });

  it('autoLayoutDocument rellena x/y en todas las vistas y es idempotente sin force', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    for (const v of laid.views) {
      for (const ve of v.elements) {
        expect(ve.x).toBeTypeOf('number');
        expect(ve.y).toBeTypeOf('number');
      }
    }
    const again = await autoLayoutDocument(laid);
    expect(again.views).toEqual(laid.views);
    // La geometría del boundary derivada tras el layout envuelve a los hijos.
    const d = deriveView(laid, 'contenedores');
    expect(d.boundaries[0].width).toBeGreaterThan(240);
  });
});
