import { describe, expect, it } from 'vitest';
import { diffDocuments, hasChanges, ROOT_COLLECTION } from './diff';

const doc = (extra: Record<string, unknown> = {}): Record<string, any> => ({
  version: '1.0',
  workspace: { name: 'Tienda' },
  nodes: [
    { id: 'web', kind: 'system', name: 'Web', tags: ['a', 'b'] },
    { id: 'api', kind: 'service', name: 'API' },
    { id: 'db', kind: 'database', name: 'Base de datos' },
  ],
  interactions: [{ id: 'i1', sourceId: 'web', targetId: 'api', description: 'Pide' }],
  ...extra,
});

describe('diffDocuments: lo básico', () => {
  it('dos documentos iguales (o uno contra una copia) no tienen cambios', () => {
    const d = diffDocuments(doc(), structuredClone(doc()));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.moved).toEqual([]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0, fields: 0, total: 0, byCollection: {} });
    expect(hasChanges(d)).toBe(false);
  });

  it('el orden de las claves de un objeto no es un cambio', () => {
    const a = doc();
    const b = { interactions: a.interactions, nodes: a.nodes.map((n: object) => Object.fromEntries(Object.entries(n).reverse())), workspace: a.workspace, version: a.version };
    expect(hasChanges(diffDocuments(a, b))).toBe(false);
  });

  it('empareja por id: lo que falta es un quitado, lo que sobra un añadido, con etiqueta y tipo', () => {
    const b = doc();
    b.nodes = [b.nodes[0], b.nodes[1], { id: 'cache', kind: 'database', name: 'Caché' }];
    const d = diffDocuments(doc(), b);
    expect(d.added).toEqual([{ collection: 'nodes', id: 'cache', label: 'Caché', kind: 'database' }]);
    expect(d.removed).toEqual([{ collection: 'nodes', id: 'db', label: 'Base de datos', kind: 'database' }]);
    expect(d.changed).toEqual([]);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, changed: 0, total: 2, byCollection: { nodes: { added: 1, removed: 1, changed: 0, moved: 0 } } });
  });

  it('cambiar un id es quitar uno y añadir otro, no renombrar', () => {
    const b = doc();
    b.nodes[1].id = 'api-v2';
    const d = diffDocuments(doc(), b);
    expect(d.removed.map((e) => e.id)).toEqual(['api']);
    expect(d.added.map((e) => e.id)).toEqual(['api-v2']);
    expect(d.changed).toEqual([]);
  });

  it('cambiar un campo es una modificación con el valor antes y después; el resto del elemento no sale', () => {
    const b = doc();
    b.nodes[1].name = 'API pública';
    b.nodes[1].technology = 'Node';
    delete b.nodes[0].kind;
    const d = diffDocuments(doc(), b);
    expect(d.changed).toEqual([
      { collection: 'nodes', id: 'web', label: 'Web', fields: [{ path: 'kind', before: 'system' }] },
      {
        collection: 'nodes',
        id: 'api',
        label: 'API pública',
        kind: 'service',
        fields: [
          { path: 'name', before: 'API', after: 'API pública' },
          { path: 'technology', after: 'Node' },
        ],
      },
    ]);
    expect(d.summary).toMatchObject({ changed: 2, fields: 3, total: 2 });
  });

  it('una relación sin nombre se etiqueta «origen → destino»', () => {
    const b = doc();
    b.interactions[0].description = 'Consulta';
    expect(diffDocuments(doc(), b).changed[0]).toMatchObject({ collection: 'interactions', id: 'i1', label: 'web → api' });
  });

  it('los campos sueltos del documento (versión, workspace) van al grupo «documento»', () => {
    const b = doc();
    b.workspace.name = 'Tienda 2';
    b.workspace.description = 'Nueva';
    b.version = '1.1';
    const d = diffDocuments(doc(), b);
    expect(d.changed).toEqual([
      {
        collection: ROOT_COLLECTION,
        id: 'documento',
        label: 'Tienda 2',
        fields: [
          { path: 'version', before: '1.0', after: '1.1' },
          { path: 'workspace.name', before: 'Tienda', after: 'Tienda 2' },
          { path: 'workspace.description', after: 'Nueva' },
        ],
      },
    ]);
    expect(Object.keys(d.summary.byCollection)).toEqual([ROOT_COLLECTION]);
  });

  it('sin la lista o con la lista vacía es lo mismo; una lista nueva con elementos los añade todos', () => {
    const withEmpty = doc({ contracts: [] });
    expect(hasChanges(diffDocuments(doc(), withEmpty))).toBe(false);
    expect(hasChanges(diffDocuments(withEmpty, doc()))).toBe(false);
    const d = diffDocuments(doc(), doc({ contracts: [{ id: 'c1', name: 'Pedidos', format: 'openapi' }] }));
    expect(d.added).toEqual([{ collection: 'contracts', id: 'c1', label: 'Pedidos' }]);
  });
});

describe('diffDocuments: listas anidadas y sin id', () => {
  const withViews = (): Record<string, any> => ({
    version: '1.0',
    workspace: { name: 'C4' },
    views: [
      { id: 'ctx', type: 'systemContext', title: 'Contexto', elements: [{ id: 'a' }, { id: 'b' }] },
      { id: 'cont', type: 'container', title: 'Contenedores', elements: [{ id: 'a' }] },
    ],
  });

  it('recorre las listas que cuelgan de un elemento y las nombra por el elemento: views[ctx].elements', () => {
    const b = withViews();
    b.views[0].elements.push({ id: 'c' });
    b.views[0].title = 'Contexto del sistema';
    b.views[1].elements = [];
    const d = diffDocuments(withViews(), b);
    expect(d.added).toEqual([{ collection: 'views[ctx].elements', id: 'c', label: 'c' }]);
    expect(d.removed).toEqual([{ collection: 'views[cont].elements', id: 'a', label: 'a' }]);
    // La vista modificada va delante de sus listas anidadas en el recuento por colección.
    expect(d.changed).toEqual([{ collection: 'views', id: 'ctx', label: 'Contexto del sistema', kind: 'systemContext', fields: [{ path: 'title', before: 'Contexto', after: 'Contexto del sistema' }] }]);
    expect(Object.keys(d.summary.byCollection)).toEqual(['views', 'views[ctx].elements', 'views[cont].elements']);
  });

  it('un elemento añadido o quitado no se desglosa: sus listas internas van con él', () => {
    const b = withViews();
    b.views.pop();
    const d = diffDocuments(withViews(), b);
    expect(d.removed).toEqual([{ collection: 'views', id: 'cont', label: 'Contenedores', kind: 'container' }]);
    expect(d.removed).toHaveLength(1);
  });

  it('las listas sin id se emparejan por nombre (las columnas de una tabla)', () => {
    const table = (columns: object[]): Record<string, any> => ({ assets: [{ id: 't', name: 'clientes', columns }] });
    const d = diffDocuments(table([{ name: 'id', type: 'int' }, { name: 'email', type: 'text' }]), table([{ name: 'id', type: 'bigint' }, { name: 'alta', type: 'date' }]));
    expect(d.changed).toEqual([{ collection: 'assets[t].columns', id: 'id', label: 'id', kind: 'bigint', fields: [{ path: 'type', before: 'int', after: 'bigint' }] }]);
    expect(d.added).toEqual([{ collection: 'assets[t].columns', id: 'alta', label: 'alta', kind: 'date' }]);
    expect(d.removed).toEqual([{ collection: 'assets[t].columns', id: 'email', label: 'email', kind: 'text' }]);
  });

  it('las listas sin id ni nombre se emparejan por igualdad y, lo que sobra, por parecido; el orden no cuenta', () => {
    const ref = (assetId: string, column: string) => ({ assetId, column });
    const pipe = (mappings: object[]): Record<string, any> => ({ pipelines: [{ id: 'p', name: 'Carga', mappings }] });
    const before = pipe([
      { from: ref('a', 'x'), to: ref('b', 'x') },
      { from: ref('a', 'y'), to: ref('b', 'y'), transform: 'upper' },
      { from: ref('a', 'z'), to: ref('b', 'z') },
    ]);
    const reordered = pipe([
      { from: ref('a', 'z'), to: ref('b', 'z') },
      { from: ref('a', 'x'), to: ref('b', 'x') },
      { from: ref('a', 'y'), to: ref('b', 'y'), transform: 'upper' },
    ]);
    expect(hasChanges(diffDocuments(before, reordered))).toBe(false);

    const edited = pipe([
      { from: ref('a', 'x'), to: ref('b', 'x') },
      { from: ref('a', 'y'), to: ref('b', 'y'), transform: 'lower' },
      { from: ref('a', 'w'), to: ref('b', 'w') },
    ]);
    const d = diffDocuments(before, edited);
    expect(d.changed).toEqual([{ collection: 'pipelines[p].mappings', id: '#2', label: 'a · y → b · y', fields: [{ path: 'transform', before: 'upper', after: 'lower' }] }]);
    expect(d.removed).toEqual([{ collection: 'pipelines[p].mappings', id: '#3', label: 'a · z → b · z' }]);
    expect(d.added).toEqual([{ collection: 'pipelines[p].mappings', id: '#3', label: 'a · w → b · w' }]);
  });

  it('los objetos anidados se recorren por campo: la ruta lleva los puntos', () => {
    const a = { nodes: [{ id: 'n', name: 'N', slo: { availability: '99%', latency: '1s' } }] };
    const b = { nodes: [{ id: 'n', name: 'N', slo: { availability: '99.9%', latency: '1s', errors: '1%' } }] };
    expect(diffDocuments(a, b).changed[0].fields).toEqual([
      { path: 'slo.availability', before: '99%', after: '99.9%' },
      { path: 'slo.errors', after: '1%' },
    ]);
  });
});

describe('diffDocuments: listas de valores', () => {
  it('se comparan como conjunto: dicen qué entró y qué salió, y cambiar solo el orden no es un cambio', () => {
    const b = doc();
    b.nodes[0].tags = ['b', 'c'];
    const d = diffDocuments(doc(), b);
    expect(d.changed[0].fields).toEqual([{ path: 'tags', before: ['a', 'b'], after: ['b', 'c'], added: ['c'], removed: ['a'] }]);

    const swapped = doc();
    swapped.nodes[0].tags = ['b', 'a'];
    expect(hasChanges(diffDocuments(doc(), swapped))).toBe(false);
  });

  it('respeta los duplicados y el paso de «sin lista» a «con valores»', () => {
    const a = { nodes: [{ id: 'n', tags: ['x', 'x'] }] };
    const b = { nodes: [{ id: 'n', tags: ['x'] }] };
    expect(diffDocuments(a, b).changed[0].fields[0]).toMatchObject({ path: 'tags', added: [], removed: ['x'] });
    expect(diffDocuments({ nodes: [{ id: 'n' }] }, { nodes: [{ id: 'n', tags: ['x'] }] }).changed[0].fields).toEqual([{ path: 'tags', after: ['x'], added: ['x'], removed: [] }]);
  });
});

describe('diffDocuments: lo que no es contenido (ignore)', () => {
  const c4 = (x: number, edges = true): Record<string, any> => ({
    version: '1.0',
    workspace: { name: 'C4' },
    model: { elements: [{ id: 'a', type: 'person', name: 'A' }], relationships: [] },
    views: [
      {
        id: 'ctx',
        type: 'systemContext',
        elements: [{ id: 'a', x, y: x * 2, width: 200, height: 100 }],
        ...(edges ? { edges: [{ id: 'r', points: [{ x, y: x }] }], layout: { direction: 'DOWN', spacing: x } } : {}),
      },
    ],
  });
  const ignore = ['views.elements.x', 'views.elements.y', 'views.elements.width', 'views.elements.height', 'views.edges', 'views.layout'];

  it('mover coordenadas, cambiar tamaños y recalcular rutas no cambia nada', () => {
    expect(hasChanges(diffDocuments(c4(10), c4(500), { ignore }))).toBe(false);
    expect(hasChanges(diffDocuments(c4(10), c4(10, false), { ignore }))).toBe(false);
  });

  it('sin la lista de ignorados, todo cuenta', () => {
    expect(hasChanges(diffDocuments(c4(10), c4(500)))).toBe(true);
  });

  it('lo ignorado no tapa lo que sí es contenido de la misma lista', () => {
    const b = c4(500);
    b.views[0].elements.push({ id: 'b', x: 1, y: 1 });
    b.model.elements[0].name = 'A2';
    const d = diffDocuments(c4(10), b, { ignore });
    expect(d.added).toEqual([{ collection: 'views[ctx].elements', id: 'b', label: 'b' }]);
    expect(d.changed.map((e) => e.id)).toEqual(['a']);
  });

  it('una ruta ignorada cubre todo lo que cuelga de ella', () => {
    const a = { nodes: [{ id: 'n', name: 'N', meta: { a: 1, b: { c: 2 } } }] };
    const b = { nodes: [{ id: 'n', name: 'N', meta: { a: 9, b: { c: 3 } } }] };
    expect(hasChanges(diffDocuments(a, b, { ignore: ['nodes.meta'] }))).toBe(false);
    expect(hasChanges(diffDocuments(a, b, { ignore: ['nodes.meta.a'] }))).toBe(true);
  });
});

describe('diffDocuments: reordenamientos', () => {
  const list = (ids: string[]): Record<string, any> => ({ nodes: ids.map((id) => ({ id, name: id.toUpperCase() })) });

  it('cambiar solo el orden no es un cambio: se anota como movido, sin sumar al total', () => {
    const d = diffDocuments(list(['a', 'b', 'c', 'd']), list(['c', 'a', 'b', 'd']));
    expect(d.changed).toEqual([]);
    expect(d.summary).toMatchObject({ added: 0, removed: 0, changed: 0, total: 0, moved: 1 });
    expect(d.moved).toEqual([{ collection: 'nodes', id: 'c', label: 'C', from: 3, to: 1 }]);
    expect(hasChanges(d)).toBe(false);
  });

  it('añadir o quitar elementos en medio no mueve a los demás', () => {
    const d = diffDocuments(list(['a', 'b', 'c']), list(['a', 'x', 'b', 'c']));
    expect(d.moved).toEqual([]);
    expect(d.added.map((e) => e.id)).toEqual(['x']);
  });

  it('en una lista cuyo orden es contenido, un reordenamiento es una modificación con su posición', () => {
    const d = diffDocuments(list(['a', 'b', 'c']), list(['b', 'c', 'a']), { ordered: ['nodes'] });
    expect(d.moved).toEqual([]);
    expect(d.changed).toEqual([{ collection: 'nodes', id: 'a', label: 'A', fields: [{ path: '(posición)', before: 1, after: 3 }] }]);
    expect(hasChanges(d)).toBe(true);
  });

  it('una lista sin ids cuyo orden es contenido (los pasos de un flujo) se compara entera', () => {
    const flow = (steps: string[]): Record<string, any> => ({ flows: [{ id: 'f', name: 'Pedido', steps: steps.map((interactionId) => ({ interactionId })) }] });
    const options = { ordered: ['flows.steps'] };
    expect(hasChanges(diffDocuments(flow(['a', 'b', 'c']), flow(['a', 'b', 'c']), options))).toBe(false);
    const d = diffDocuments(flow(['a', 'b', 'c']), flow(['a', 'c', 'b']), options);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ collection: 'flows', id: 'f' });
    expect(d.changed[0].fields).toEqual([{ path: 'steps', before: [{ interactionId: 'a' }, { interactionId: 'b' }, { interactionId: 'c' }], after: [{ interactionId: 'a' }, { interactionId: 'c' }, { interactionId: 'b' }] }]);
    // Sin declararlo, reordenar los pasos no se ve (es lo que pasa con cualquier lista).
    expect(hasChanges(diffDocuments(flow(['a', 'b', 'c']), flow(['a', 'c', 'b'])))).toBe(false);
  });
});

describe('diffDocuments: casos límite', () => {
  it('ids repetidos: se prueba con el nombre y, si tampoco sirve, se empareja por contenido sin romper', () => {
    const byName = diffDocuments({ nodes: [{ id: 'x', name: 'Uno' }, { id: 'x', name: 'Dos' }] }, { nodes: [{ id: 'x', name: 'Uno' }, { id: 'x', name: 'Tres' }] });
    expect(byName.removed.map((e) => e.id)).toEqual(['Dos']);
    expect(byName.added.map((e) => e.id)).toEqual(['Tres']);
    const a = { nodes: [{ id: 'x', name: 'N', v: 1 }, { id: 'x', name: 'N', v: 2 }] };
    const b = { nodes: [{ id: 'x', name: 'N', v: 1 }, { id: 'x', name: 'N', v: 3 }] };
    const d = diffDocuments(a, b);
    expect(d.summary).toMatchObject({ added: 0, removed: 0, changed: 1 });
    expect(d.changed[0]).toMatchObject({ id: '#2', fields: [{ path: 'v', before: 2, after: 3 }] });
  });

  it('valores que no son objetos ni listas son un campo suelto (null, números, tipos distintos)', () => {
    expect(diffDocuments({ n: 1, z: null, t: 'a', l: [1] }, { n: 2, z: 'x', t: ['a'], l: { k: 1 } }).changed[0].fields.map((f) => f.path)).toEqual(['n', 'z', 't', 'l']);
    expect(diffDocuments(1, 2).changed[0].fields).toEqual([{ path: '(raíz)', before: 1, after: 2 }]);
  });

  it('no modifica los documentos que compara', () => {
    const a = doc();
    const b = doc();
    b.nodes[0].name = 'Otro';
    const snapshot = JSON.stringify([a, b]);
    diffDocuments(a, b, { ignore: ['nodes.tags'], ordered: ['nodes'] });
    expect(JSON.stringify([a, b])).toBe(snapshot);
  });
});
