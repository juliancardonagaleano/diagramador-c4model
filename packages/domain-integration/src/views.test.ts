import { describe, expect, it } from 'vitest';
import { validateIntegrationDocument } from './schema';
import { findView, listViews, numberByOrder } from './views';
import { domainOf, isZoneId, zoneColors, zoneId, zonesOf } from './zones';
import type { IntegrationDocument } from './types';

const parse = (input: unknown): IntegrationDocument => {
  const r = validateIntegrationDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};

const doc = parse({
  nodes: [
    { id: 'a', kind: 'system', name: 'A', domain: 'Ventas' },
    { id: 'a-api', kind: 'api', name: 'API de A', parentId: 'a' },
    { id: 'b', kind: 'system', name: 'B', domain: 'ventas' },
    { id: 'c', kind: 'system', name: 'C' },
    { id: 'k', kind: 'broker', name: 'K', domain: 'Plataforma' },
    { id: 't', kind: 'topic', name: 'T', parentId: 'k' },
    { id: 'lejos', kind: 'system', name: 'Lejos' },
  ],
  interactions: [
    { id: 'c-api', sourceId: 'c', targetId: 'a-api', style: 'request-response', order: 20 },
    { id: 'a-t', sourceId: 'a', targetId: 't', style: 'event', order: 10 },
    { id: 't-b', sourceId: 't', targetId: 'b', style: 'event' },
    { id: 'b-lejos', sourceId: 'b', targetId: 'lejos', style: 'request-response' },
  ],
  flows: [{ id: 'f', name: 'F', steps: [{ interactionId: 'a-t' }, { interactionId: 't-b' }] }],
});

describe('numeración por orden', () => {
  it('numera (1, 2, 3…) por orden creciente y deja al final las que no tienen orden', () => {
    const numbered = numberByOrder(doc.interactions);
    expect(numbered.map((n) => [n.interaction.id, n.step])).toEqual([
      ['a-t', 1],
      ['c-api', 2],
      ['t-b', undefined],
      ['b-lejos', undefined],
    ]);
  });

  it('el valor solo ordena: los huecos y los empates no dejan números sueltos', () => {
    const items = numberByOrder([
      { id: 'x', sourceId: 'a', targetId: 'b', style: 'event', order: 100 },
      { id: 'y', sourceId: 'a', targetId: 'b', style: 'event', order: 100 },
      { id: 'z', sourceId: 'a', targetId: 'b', style: 'event', order: 5.5 },
    ]);
    expect(items.map((i) => [i.interaction.id, i.step])).toEqual([['z', 1], ['x', 2], ['y', 3]]);
  });

  it('sin ningún orden se conserva el orden del documento y no hay números', () => {
    const none = numberByOrder(doc.interactions.map(({ order: _order, ...rest }) => rest));
    expect(none.map((n) => n.interaction.id)).toEqual(['c-api', 'a-t', 't-b', 'b-lejos']);
    expect(none.every((n) => n.step === undefined)).toBe(true);
  });

  it('el mapa numera por orden y un flujo, por la posición de sus pasos', () => {
    expect(findView(doc, 'map').interactions.map((i) => i.step)).toEqual([1, 2, undefined, undefined]);
    expect(findView(doc, 'flow:f').interactions.map((i) => [i.interaction.id, i.step])).toEqual([['a-t', 1], ['t-b', 2]]);
  });
});

describe('vista de un sistema', () => {
  it('hay una por sistema, con él, lo que contiene y sus vecinos directos', () => {
    expect(listViews(doc).map((v) => v.id)).toEqual(['map', 'flow:f', 'system:a', 'system:b', 'system:c', 'system:lejos']);
    const a = findView(doc, 'system:a');
    expect(a.type).toBe('system');
    expect(a.title).toBe('Sistema - A');
    expect(a.nodeIds.sort()).toEqual(['a', 'a-api', 'c', 'k', 't']);
    expect(a.nodeIds).not.toContain('b');
    expect(a.interactions.map((i) => [i.interaction.id, i.step])).toEqual([['a-t', 1], ['c-api', 2]]);
  });

  it('solo llega a los vecinos de primer grado, no a los de sus vecinos', () => {
    const b = findView(doc, 'system:b');
    expect(b.nodeIds.sort()).toEqual(['b', 'k', 'lejos', 't']);
    expect(b.nodeIds).not.toContain('a');
  });

  it('se puede pedir por el id del sistema a secas y un id desconocido lista las vistas', () => {
    expect(findView(doc, 'c').id).toBe('system:c');
    expect(() => findView(doc, 'nada')).toThrow(/system:a/);
  });
});

describe('zonas por dominio', () => {
  it('el mismo nombre con otra mayúscula es la misma zona y el hijo sigue a su padre', () => {
    const zones = zonesOf(doc.nodes);
    expect(zones.map((z) => [z.id, z.nodeIds])).toEqual([
      ['domain:ventas', ['a', 'b']],
      ['domain:plataforma', ['k']],
    ]);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    expect(domainOf(byId.get('a-api')!, byId)).toBe('Ventas');
    expect(domainOf(byId.get('c')!, byId)).toBeUndefined();
  });

  it('en una vista solo cuentan los nodos visibles', () => {
    const zones = zonesOf(doc.nodes, new Set(findView(doc, 'system:a').nodeIds));
    expect(zones.map((z) => [z.id, z.nodeIds])).toEqual([['domain:ventas', ['a']], ['domain:plataforma', ['k']]]);
  });

  it('el id y el color de una zona son estables', () => {
    expect(zoneId('Equipo de Pedidos')).toBe('domain:equipo-de-pedidos');
    expect(isZoneId('domain:x')).toBe(true);
    expect(isZoneId('x')).toBe(false);
    expect(zoneColors('Ventas')).toEqual(zoneColors('ventas'));
    expect(zoneColors('Ventas').stroke).toMatch(/^#[0-9a-f]{6}$/);
  });
});
