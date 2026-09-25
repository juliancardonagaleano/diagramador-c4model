import { describe, expect, it } from 'vitest';
import { childViewType, findChildView, findParentView, isValidParentType, relationshipCreationBlocked, viewBreadcrumb, viewLevel } from './factories';
import { sampleDocument } from './sample';
import type { C4Document } from './types';

describe('niveles C1/C2/C3', () => {
  it('viewLevel mapea el tipo de vista al nivel', () => {
    expect(viewLevel({ type: 'systemContext' })).toBe('C1');
    expect(viewLevel({ type: 'container' })).toBe('C2');
    expect(viewLevel({ type: 'component' })).toBe('C3');
  });

  it('childViewType: sistema → contenedores, contenedor → componentes, otros → null', () => {
    expect(childViewType({ type: 'softwareSystem' })).toBe('container');
    expect(childViewType({ type: 'container' })).toBe('component');
    expect(childViewType({ type: 'person' })).toBeNull();
    expect(childViewType({ type: 'component' })).toBeNull();
  });

  it('findChildView encuentra la vista que detalla a un elemento', () => {
    expect(findChildView(sampleDocument, 'banca')?.id).toBe('contenedores');
    expect(findChildView(sampleDocument, 'api')?.id).toBe('componentes-api');
    expect(findChildView(sampleDocument, 'db')).toBeUndefined();
    expect(findChildView(sampleDocument, 'cliente')).toBeUndefined();
    expect(findChildView(sampleDocument, 'nope')).toBeUndefined();
  });

  it('findParentView sube de C3 a C2 y de C2 a C1', () => {
    const c3 = sampleDocument.views.find((v) => v.id === 'componentes-api')!;
    const c2 = findParentView(sampleDocument, c3)!;
    expect(c2.id).toBe('contenedores');
    const c1 = findParentView(sampleDocument, c2)!;
    expect(c1.id).toBe('contexto');
    expect(findParentView(sampleDocument, c1)).toBeUndefined();
  });

  it('viewBreadcrumb devuelve la cadena C1 › C2 › C3', () => {
    expect(viewBreadcrumb(sampleDocument, 'componentes-api').map((v) => v.id)).toEqual(['contexto', 'contenedores', 'componentes-api']);
    expect(viewBreadcrumb(sampleDocument, 'contexto').map((v) => v.id)).toEqual(['contexto']);
    expect(viewBreadcrumb(sampleDocument, 'nope')).toEqual([]);
  });

  it('findParentView no adivina una vista de un sistema no relacionado cuando hay varios candidatos', () => {
    const doc: C4Document = {
      version: '1.0',
      workspace: { name: 'dos sistemas' },
      model: {
        elements: [
          { id: 'sysA', type: 'softwareSystem', name: 'Sistema A' },
          { id: 'sysB', type: 'softwareSystem', name: 'Sistema B' },
          { id: 'contA', type: 'container', name: 'Contenedor A', parentId: 'sysA' },
        ],
        relationships: [],
      },
      views: [
        { id: 'ctxB', type: 'systemContext', scopeId: 'sysB', elements: [{ id: 'sysB' }] },
        { id: 'ctxGeneric', type: 'systemContext', elements: [{ id: 'sysA' }, { id: 'sysB' }] },
        { id: 'c2A', type: 'container', scopeId: 'sysA', elements: [{ id: 'contA' }] },
      ],
    };
    const c2A = doc.views.find((v) => v.id === 'c2A')!;
    // Ninguna vista de contexto tiene scopeId="sysA" exacto, y hay dos vistas de contexto en el
    // documento: antes caía en la primera (`ctxB`, de otro sistema); ahora no adivina.
    expect(findParentView(doc, c2A)).toBeUndefined();
  });

  it('relationshipCreationBlocked detecta auto-referencia y duplicados', () => {
    const relationships = [{ sourceId: 'a', targetId: 'b' }];
    expect(relationshipCreationBlocked(relationships, undefined, 'b')).toBeNull();
    expect(relationshipCreationBlocked(relationships, 'a', 'a')).toBe('self');
    expect(relationshipCreationBlocked(relationships, 'a', 'b')).toBe('duplicate');
    expect(relationshipCreationBlocked(relationships, 'b', 'a')).toBeNull(); // el par inverso sí es válido
    expect(relationshipCreationBlocked(relationships, 'a', 'c')).toBeNull();
  });

  it('isValidParentType: el padre solo sigue siendo válido si es del tipo que exige el nuevo tipo', () => {
    // component → container exige un padre `container`.
    expect(isValidParentType('container', 'component')).toBe(true);
    // container → component exige un padre `softwareSystem`; un `container` ya no vale.
    expect(isValidParentType('container', 'container')).toBe(false);
    expect(isValidParentType('softwareSystem', 'container')).toBe(true);
    // Tipos sin padre (person, softwareSystem) nunca son "válidos" como destino.
    expect(isValidParentType('softwareSystem', 'person')).toBe(false);
    expect(isValidParentType(undefined, 'container')).toBe(false);
  });

  it('findParentView sí usa una vista genérica del nivel superior cuando es la única del documento', () => {
    const doc: C4Document = {
      version: '1.0',
      workspace: { name: 'un sistema' },
      model: {
        elements: [
          { id: 'sysA', type: 'softwareSystem', name: 'Sistema A' },
          { id: 'contA', type: 'container', name: 'Contenedor A', parentId: 'sysA' },
        ],
        relationships: [],
      },
      views: [
        { id: 'ctxGeneric', type: 'systemContext', elements: [{ id: 'sysA' }] },
        { id: 'c2A', type: 'container', scopeId: 'sysA', elements: [{ id: 'contA' }] },
      ],
    };
    const c2A = doc.views.find((v) => v.id === 'c2A')!;
    expect(findParentView(doc, c2A)?.id).toBe('ctxGeneric');
  });
});
