import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../core/model/sample';
import { parseHostAction } from './protocol';

describe('parseHostAction', () => {
  it('acepta objetos y cadenas JSON', () => {
    const a = parseHostAction({ action: 'load', document: sampleDocument, autosave: true });
    expect(a.ok).toBe(true);
    const b = parseHostAction(JSON.stringify({ action: 'export', format: 'drawio', requestId: 'x' }));
    expect(b.ok && b.action.action === 'export' && b.action.format === 'drawio').toBe(true);
  });

  it('rechaza acciones desconocidas y documentos inválidos', () => {
    expect(parseHostAction({ action: 'hack' }).ok).toBe(false);
    expect(parseHostAction({ foo: 1 }).ok).toBe(false);
    expect(parseHostAction('no json').ok).toBe(false);
    const r = parseHostAction({ action: 'load', document: { model: { elements: [{ id: 'a', type: 'container', name: 'A', parentId: 'zz' }] } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/padre inexistente/);
  });

  it('permite documentos como texto (se validan al aplicarse)', () => {
    const r = parseHostAction({ action: 'load', document: JSON.stringify(sampleDocument) });
    expect(r.ok).toBe(true);
  });
});
