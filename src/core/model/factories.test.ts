import { describe, expect, it } from 'vitest';
import { childViewType, findChildView, findParentView, viewBreadcrumb, viewLevel } from './factories';
import { sampleDocument } from './sample';

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
});
