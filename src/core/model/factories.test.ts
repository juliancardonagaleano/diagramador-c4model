import { describe, expect, it } from 'vitest';
import { childViewType, findChildView, findParentView, isValidParentType, relationshipCreationBlocked, typeChangeBlockedReason, viewBreadcrumb, viewLevel } from './factories';
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

  const twoSystemsDoc = (views: C4Document['views']): C4Document => ({
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
    views,
  });
  const c2A = { id: 'c2A', type: 'container' as const, scopeId: 'sysA', elements: [{ id: 'contA' }] };

  it('findParentView no adivina una vista de un sistema no relacionado cuando hay varios candidatos', () => {
    const doc = twoSystemsDoc([
      { id: 'ctxB', type: 'systemContext', scopeId: 'sysB', elements: [{ id: 'sysB' }] },
      { id: 'ctxOtra', type: 'systemContext', elements: [{ id: 'sysB' }] },
      c2A,
    ]);
    // Ninguna vista de contexto tiene alcance sysA ni muestra a sysA, y hay dos: antes caía en la
    // primera (`ctxB`, de otro sistema); ahora no adivina.
    expect(findParentView(doc, doc.views.find((v) => v.id === 'c2A')!)).toBeUndefined();
  });

  it('findParentView prefiere la vista general que muestra el sistema frente a las de otros sistemas', () => {
    const doc = twoSystemsDoc([
      { id: 'ctxB', type: 'systemContext', scopeId: 'sysB', elements: [{ id: 'sysB' }] },
      { id: 'ctxGeneral', type: 'systemContext', elements: [{ id: 'sysA' }, { id: 'sysB' }] },
      c2A,
    ]);
    expect(findParentView(doc, doc.views.find((v) => v.id === 'c2A')!)?.id).toBe('ctxGeneral');
  });

  it('findParentView sí usa una vista genérica del nivel superior cuando es la única del documento', () => {
    const doc = twoSystemsDoc([{ id: 'ctxGeneric', type: 'systemContext', elements: [{ id: 'sysB' }] }, c2A]);
    expect(findParentView(doc, doc.views.find((v) => v.id === 'c2A')!)?.id).toBe('ctxGeneric');
  });

  it('typeChangeBlockedReason bloquea cambiar el tipo de un elemento con hijos o que es alcance de una vista', () => {
    // "banca" (softwareSystem) tiene contenedores hijos y es el alcance de la vista de contenedores.
    expect(typeChangeBlockedReason(sampleDocument, 'banca', 'container')).toMatch(/hijos/);
    expect(typeChangeBlockedReason(sampleDocument, 'banca', 'person')).not.toBeNull();
    // "api" (container) tiene componentes hijos.
    expect(typeChangeBlockedReason(sampleDocument, 'api', 'softwareSystem')).toMatch(/hijos/);
    // Un elemento hoja sin vistas asociadas puede cambiar de tipo, y "mismo tipo" nunca se bloquea.
    expect(typeChangeBlockedReason(sampleDocument, 'db', 'component')).toBeNull();
    expect(typeChangeBlockedReason(sampleDocument, 'banca', 'softwareSystem')).toBeNull();
    // Un elemento que solo es alcance de una vista (sin hijos) también queda protegido.
    const doc = structuredClone(sampleDocument);
    doc.model.elements = doc.model.elements.filter((e) => e.parentId !== 'banca' && !['signin', 'accounts', 'security', 'mainframe-facade'].includes(e.id));
    expect(typeChangeBlockedReason(doc, 'banca', 'container')).toMatch(/alcance de la vista/);
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

});
