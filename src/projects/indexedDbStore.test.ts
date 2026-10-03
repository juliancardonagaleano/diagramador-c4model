import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { projectStoreContract } from '../../tests/helpers/projectStoreContract';
import { IndexedDbProjectStore, indexedDbAvailable } from './indexedDbStore';

// Cada prueba del contrato usa su propia base (una fábrica de IndexedDB nueva), sin estado compartido.
projectStoreContract('IndexedDB', async () => {
  const store = new IndexedDbProjectStore(new IDBFactory());
  return { store, cleanup: () => store.close() };
});

describe('almacén IndexedDB', () => {
  it('lo guardado sobrevive a cerrar y reabrir la base (persistencia real)', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbProjectStore(factory);
    const project = await first.createProject({ name: 'Tienda', description: 'Pedidos' });
    const diagram = await first.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"a":1}' });
    await first.close();

    const second = new IndexedDbProjectStore(factory);
    const [listed] = await second.listProjects();
    expect(listed).toMatchObject({ id: project.id, name: 'Tienda', description: 'Pedidos' });
    expect(listed.diagrams).toEqual([diagram]);
    expect((await second.getDiagram(project.id, diagram.id))?.text).toBe('{"a":1}');
    await second.close();
  });

  it('dos conexiones a la misma base ven los cambios de la otra (dos pestañas)', async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbProjectStore(factory);
    const tabB = new IndexedDbProjectStore(factory);
    const project = await tabA.createProject({ name: 'Tienda' });
    await expect(tabB.createProject({ name: 'tienda' })).rejects.toMatchObject({ code: 'exists' });
    const created = await tabB.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno' });
    // la pestaña A guarda con la marca que conocía: B ya lo cambió → conflicto, no se pisa
    const fromB = await tabB.saveDiagram(project.id, { id: created.id, text: 'dos', ifUpdatedAt: created.updatedAt });
    await expect(tabA.saveDiagram(project.id, { id: created.id, text: 'tres', ifUpdatedAt: created.updatedAt })).rejects.toMatchObject({ code: 'conflict' });
    expect((await tabA.getDiagram(project.id, created.id))?.text).toBe('dos');
    expect(fromB.updatedAt > created.updatedAt).toBe(true);
    await Promise.all([tabA.close(), tabB.close()]);
  });

  it('una operación que falla a mitad no deja cambios (transacción única)', async () => {
    const store = new IndexedDbProjectStore(new IDBFactory());
    const project = await store.createProject({ name: 'Tienda' });
    await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
    await expect(store.saveDiagram(project.id, { module: 'data', name: 'contexto', text: 'b' })).rejects.toBeInstanceOf(ProjectError);
    expect((await store.getProject(project.id))?.diagrams).toHaveLength(1);
    await store.close();
  });

  it('sin IndexedDB, todo falla con un error claro de almacenamiento no disponible', async () => {
    expect(indexedDbAvailable(null)).toBe(false);
    expect(indexedDbAvailable(new IDBFactory())).toBe(true);
    const store = new IndexedDbProjectStore(null);
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.createProject({ name: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
