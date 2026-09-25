import { describe, expect, it } from 'vitest';
import { analyzeDocument } from './issues';
import { sampleDocument } from './sample';

describe('analyzeDocument', () => {
  it('el documento de ejemplo no tiene issues de severidad error', () => {
    const issues = analyzeDocument(sampleDocument);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('detecta una relación auto-referenciada', () => {
    const doc = structuredClone(sampleDocument);
    doc.model.relationships[0].targetId = doc.model.relationships[0].sourceId;
    const issues = analyzeDocument(doc);
    expect(issues.some((i) => i.severity === 'error' && i.relationshipId === doc.model.relationships[0].id && /no puede apuntar al mismo elemento/.test(i.message))).toBe(true);
  });

  it('detecta un parentId de tipo incoherente (no solo su ausencia)', () => {
    const doc = structuredClone(sampleDocument);
    // "api" es container (padre válido: softwareSystem); se le asigna otro container como padre.
    const api = doc.model.elements.find((e) => e.id === 'api')!;
    api.parentId = 'db'; // "db" también es container, no softwareSystem
    const issues = analyzeDocument(doc);
    expect(issues.some((i) => i.severity === 'error' && i.elementId === 'api' && /padre de tipo incorrecto/.test(i.message))).toBe(true);
  });

  it('no reporta padre incoherente cuando simplemente falta (ya lo cubre el otro aviso)', () => {
    const doc = structuredClone(sampleDocument);
    const api = doc.model.elements.find((e) => e.id === 'api')!;
    delete api.parentId;
    const issues = analyzeDocument(doc);
    expect(issues.some((i) => i.elementId === 'api' && /no tiene padre asignado/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.elementId === 'api' && /padre de tipo incorrecto/.test(i.message))).toBe(false);
  });

  it('detecta un scopeId de vista de tipo incoherente', () => {
    const doc = structuredClone(sampleDocument);
    const cont = doc.views.find((v) => v.id === 'contenedores')!;
    cont.scopeId = 'cliente'; // "cliente" es person, no softwareSystem
    const issues = analyzeDocument(doc);
    expect(issues.some((i) => i.severity === 'error' && i.viewId === 'contenedores' && /alcance de tipo incorrecto/.test(i.message))).toBe(true);
  });
});
