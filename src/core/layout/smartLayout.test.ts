import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../model/sample';
import { deriveView } from '../model/viewDerivation';
import { layoutView, resolveLayoutParams } from './elkLayout';
import { smartLayout } from './smartLayout';

describe('smartLayout (autocorrección)', () => {
  it('la vista de contexto sale limpia: sin cruces ni solapes, personas arriba y externos abajo', async () => {
    const r = await layoutView(sampleDocument, 'contexto', { force: true });
    expect(r.quality).toBeDefined();
    expect(r.quality!.edgeNodeOverlaps).toBe(0);
    expect(r.quality!.labelOverlaps).toBe(0);
    expect(r.quality!.crossings).toBe(0);
    const pos = Object.fromEntries(r.positions.map((p) => [p.id, p]));
    expect(pos.cliente.y).toBeLessThan(pos.banca.y);
    expect(pos.mainframe.y).toBeGreaterThan(pos.banca.y);
  });

  it('la vista de contenedores queda sin solapes y con como mucho un cruce', async () => {
    const r = await layoutView(sampleDocument, 'contenedores', { force: true });
    expect(r.quality!.edgeNodeOverlaps).toBe(0);
    expect(r.quality!.labelOverlaps).toBe(0);
    expect(r.quality!.crossings).toBeLessThanOrEqual(1);
    expect(r.quality!.candidates).toBeGreaterThanOrEqual(1);
    expect(r.quality!.strategy).toBeTruthy();
  });

  it('la vista de componentes también queda limpia', async () => {
    const r = await layoutView(sampleDocument, 'componentes-api', { force: true });
    expect(r.quality!.edgeNodeOverlaps + r.quality!.labelOverlaps).toBe(0);
    expect(r.quality!.crossings).toBeLessThanOrEqual(1);
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
    expect(smart.quality!.score).toBeLessThanOrEqual(fast.quality!.score + 1e-6);
  });
});
