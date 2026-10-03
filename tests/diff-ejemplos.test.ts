import { describe, expect, it } from 'vitest';
import { diffDocuments, hasChanges, type DomainModule } from '@iark/kernel';
import { autoLayoutDocument } from '@iark/domain-c4';
import { c4Module, dataModule, enterpriseModule, example, integrationModule, platformModule, securityModule } from '../src/modules-app/testing';

// `diffDocuments` es genérico: no tiene código por módulo. Estas pruebas lo ejecutan sobre los ejemplos de CADA módulo de la
// suite, con lo que declara cada uno (`module.diff`), y comprueban lo que tiene que cumplirse en todos: un documento contra sí
// mismo no tiene cambios; renombrar, cambiar un campo, añadir o quitar un elemento se ven; reordenar una lista no es un cambio.

interface Case {
  module: DomainModule<any>;
  file: string;
  /** Lista de elementos con id y nombre sobre la que se hacen las ediciones (ruta de claves). */
  list: string;
}

const CASES: Case[] = [
  { module: c4Module, file: 'banca.json', list: 'model.elements' },
  { module: integrationModule, file: 'pedidos-integracion.json', list: 'nodes' },
  { module: dataModule, file: 'ventas-datos.json', list: 'assets' },
  { module: dataModule, file: 'datos-catalogo.json', list: 'assets' },
  { module: enterpriseModule, file: 'empresa-arquitectura.json', list: 'applications' },
  { module: enterpriseModule, file: 'empresa-flujo-de-valor.json', list: 'applications' },
  { module: platformModule, file: 'plataforma-ejemplo.json', list: 'services' },
  { module: platformModule, file: 'plataforma-nubes.json', list: 'services' },
  { module: securityModule, file: 'seguridad-ejemplo.json', list: 'assets' },
];

/** El documento válido del ejemplo, tal como lo deja el esquema del módulo (con sus valores por defecto). */
function load(c: Case): Record<string, any> {
  const parsed = c.module.schema.safeParse(JSON.parse(example(c.file)));
  if (!parsed.success) throw new Error(`${c.file} no es válido: ${parsed.error.message}`);
  return parsed.data as Record<string, any>;
}

const at = (doc: Record<string, any>, path: string): any[] => path.split('.').reduce((node, key) => node[key], doc) as any[];

describe.each(CASES)('comparar versiones: $module.id ($file)', (c) => {
  const options = c.module.diff;

  it('un documento contra sí mismo (y contra una copia) no tiene ningún cambio', () => {
    const doc = load(c);
    for (const other of [doc, load(c), structuredClone(doc)]) {
      const d = diffDocuments(doc, other, options);
      expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0, fields: 0, total: 0, byCollection: {} });
    }
  });

  it('cambiar el nombre y un campo de un elemento da una sola modificación con esos campos', () => {
    const a = load(c);
    const b = structuredClone(a);
    const item = at(b, c.list)[0];
    const id = item.id;
    item.name = `${item.name} (renombrado)`;
    item.description = 'Descripción nueva';
    const d = diffDocuments(a, b, options);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ collection: c.list, id, label: item.name });
    expect(d.changed[0].fields.map((f) => f.path).sort()).toEqual(['description', 'name']);
    expect(d.changed[0].fields.find((f) => f.path === 'name')).toMatchObject({ before: at(a, c.list)[0].name, after: item.name });
    expect(d.summary).toMatchObject({ added: 0, removed: 0, changed: 1, fields: 2, total: 1 });
  });

  it('añadir un elemento lo da como añadido y quitarlo, como quitado; renombrar su id es quitar + añadir', () => {
    const a = load(c);
    const b = structuredClone(a);
    const list = at(b, c.list);
    list.push({ ...structuredClone(list[0]), id: 'elemento-nuevo-de-prueba', name: 'Elemento nuevo' });
    const added = diffDocuments(a, b, options);
    expect(added.added).toMatchObject([{ collection: c.list, id: 'elemento-nuevo-de-prueba', label: 'Elemento nuevo' }]);
    expect(added.removed).toEqual([]);
    expect(added.changed).toEqual([]);
    expect(diffDocuments(b, a, options).removed).toMatchObject([{ collection: c.list, id: 'elemento-nuevo-de-prueba' }]);

    const renamed = structuredClone(a);
    const oldId = at(renamed, c.list)[0].id;
    at(renamed, c.list)[0].id = `${oldId}-v2`;
    const d = diffDocuments(a, renamed, options);
    expect(d.removed.map((e) => e.id)).toEqual([oldId]);
    expect(d.added.map((e) => e.id)).toEqual([`${oldId}-v2`]);
  });

  it('reordenar los elementos de una lista no es un cambio (se anota como movidos)', () => {
    const a = load(c);
    const b = structuredClone(a);
    at(b, c.list).reverse();
    const d = diffDocuments(a, b, options);
    expect(hasChanges(d)).toBe(false);
    expect(d.summary.total).toBe(0);
    expect(d.moved.length).toBeGreaterThan(0);
    expect(d.moved.every((m) => m.collection === c.list)).toBe(true);
  });
});

describe('comparar versiones: lo que declara cada módulo', () => {
  it('C4: mover coordenadas, cambiar tamaños, quitar rutas y layout no cambia nada; el autolayout tampoco', async () => {
    const a = JSON.parse(example('banca.json'));
    const moved = structuredClone(a);
    for (const view of moved.views) {
      view.layout = { direction: 'RIGHT', spacing: 99 };
      view.edges = [{ id: 'r1', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }];
      view.elements.forEach((e: Record<string, number>, i: number) => Object.assign(e, { x: i * 7, y: i * 11, width: 321, height: 123 }));
    }
    expect(hasChanges(diffDocuments(a, moved, c4Module.diff))).toBe(false);
    // Sin la lista de ignorados de C4, la maquetación sí aparecería: es el módulo quien sabe qué no es contenido.
    expect(hasChanges(diffDocuments(a, moved))).toBe(true);

    const laid = await autoLayoutDocument(c4Module.schema.parse(a));
    expect(laid.views[0].elements.every((e) => typeof e.x === 'number')).toBe(true);
    expect(hasChanges(diffDocuments(a, laid, c4Module.diff))).toBe(false);
  });

  it('C4: qué elementos muestra una vista sí es contenido', () => {
    const a = JSON.parse(example('banca.json'));
    const b = structuredClone(a);
    const quitado = b.views[0].elements.pop();
    const d = diffDocuments(a, b, c4Module.diff);
    expect(d.removed).toEqual([expect.objectContaining({ collection: `views[${a.views[0].id}].elements`, id: quitado.id })]);
  });

  it('integración: el orden de los pasos de un flujo es contenido', () => {
    const a = JSON.parse(example('pedidos-integracion.json'));
    const b = structuredClone(a);
    b.flows[0].steps.reverse();
    expect(hasChanges(diffDocuments(a, b))).toBe(false); // sin declararlo, es una lista más
    const d = diffDocuments(a, b, integrationModule.diff);
    expect(d.changed).toMatchObject([{ collection: 'flows', id: a.flows[0].id, fields: [{ path: 'steps' }] }]);
  });

  it('plataforma: el orden de las etapas de un pipeline es contenido; el de sus servicios no', () => {
    const a = JSON.parse(example('plataforma-ejemplo.json'));
    const b = structuredClone(a);
    b.pipelines[0].stages.reverse();
    expect(diffDocuments(a, b, platformModule.diff).changed).toMatchObject([{ collection: 'pipelines', id: a.pipelines[0].id, fields: [{ path: 'stages' }] }]);
    const c = structuredClone(a);
    c.pipelines[0].serviceIds.reverse();
    expect(hasChanges(diffDocuments(a, c, platformModule.diff))).toBe(false);
  });

  it('empresarial: reordenar las etapas de un flujo de valor es una modificación con su posición', () => {
    const a = JSON.parse(example('empresa-flujo-de-valor.json'));
    const b = structuredClone(a);
    const first = b.valueStages.shift();
    b.valueStages.push(first);
    const d = diffDocuments(a, b, enterpriseModule.diff);
    expect(d.moved).toEqual([]);
    expect(d.changed).toMatchObject([{ collection: 'valueStages', id: first.id, fields: [{ path: '(posición)', before: 1, after: b.valueStages.length }] }]);
  });

  it('datos: las columnas de una tabla se emparejan por nombre y las correspondencias de un pipeline por contenido', () => {
    const a = JSON.parse(example('datos-catalogo.json'));
    const withColumns = a.assets.find((x: { columns?: unknown[] }) => (x.columns?.length ?? 0) > 1);
    const b = structuredClone(a);
    const asset = b.assets.find((x: { id: string }) => x.id === withColumns.id);
    asset.columns[0].pii = !asset.columns[0].pii;
    asset.columns.reverse();
    const d = diffDocuments(a, b, dataModule.diff);
    expect(d.changed).toMatchObject([{ collection: `assets[${withColumns.id}].columns`, id: withColumns.columns[0].name, fields: [{ path: 'pii' }] }]);
    expect(d.moved.length).toBeGreaterThan(0);

    const withMappings = a.pipelines.find((p: { mappings?: unknown[] }) => (p.mappings?.length ?? 0) > 1);
    const c = structuredClone(a);
    const pipeline = c.pipelines.find((p: { id: string }) => p.id === withMappings.id);
    pipeline.mappings.reverse();
    expect(hasChanges(diffDocuments(a, c, dataModule.diff))).toBe(false);
    pipeline.mappings[0].transform = 'otra transformación';
    expect(diffDocuments(a, c, dataModule.diff).changed).toMatchObject([{ collection: `pipelines[${withMappings.id}].mappings`, fields: [{ path: 'transform' }] }]);
  });

  it('seguridad: los controles de una amenaza son un conjunto', () => {
    const a = JSON.parse(example('seguridad-ejemplo.json'));
    const threat = a.threats.find((t: { controlIds?: string[] }) => (t.controlIds?.length ?? 0) > 1);
    const b = structuredClone(a);
    b.threats.find((t: { id: string }) => t.id === threat.id).controlIds.reverse();
    expect(hasChanges(diffDocuments(a, b, securityModule.diff))).toBe(false);
    const quitado = b.threats.find((t: { id: string }) => t.id === threat.id).controlIds.pop();
    expect(diffDocuments(a, b, securityModule.diff).changed).toMatchObject([{ collection: 'threats', id: threat.id, fields: [{ path: 'controlIds', removed: [quitado] }] }]);
  });
});
