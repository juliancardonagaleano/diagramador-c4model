import { describe, expect, it } from 'vitest';
import { ProjectError, type ProjectStore } from '@iark/kernel';

/**
 * El contrato de `ProjectStore`: lo que cualquier almacén (memoria, IndexedDB, carpeta) debe cumplir igual. Cada almacén
 * lo ejecuta con una fábrica que devuelve uno vacío y limpio.
 */
export function projectStoreContract(label: string, create: () => Promise<{ store: ProjectStore; cleanup?: () => Promise<void> | void }>): void {
  describe(`contrato de ProjectStore: ${label}`, () => {
    const withStore = async (body: (store: ProjectStore) => Promise<void>): Promise<void> => {
      const { store, cleanup } = await create();
      try {
        await body(store);
      } finally {
        await cleanup?.();
      }
    };
    const rejects = async (promise: Promise<unknown>, code: string): Promise<void> => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProjectError);
      expect((error as ProjectError).code).toBe(code);
    };

    it('crea, lista, renombra y borra proyectos, ordenados por nombre', () =>
      withStore(async (store) => {
        expect(await store.listProjects()).toEqual([]);
        const b = await store.createProject({ name: '  Tienda   web ', description: 'Pedidos' });
        const a = await store.createProject({ name: 'Banca' });
        expect(b).toMatchObject({ name: 'Tienda web', description: 'Pedidos', diagrams: [] });
        expect((await store.listProjects()).map((p) => p.name)).toEqual(['Banca', 'Tienda web']);
        expect((await store.getProject(a.id))?.name).toBe('Banca');
        const renamed = await store.renameProject(a.id, 'Banca en línea');
        expect(renamed.name).toBe('Banca en línea');
        expect(renamed.updatedAt >= a.updatedAt).toBe(true);
        await store.deleteProject(b.id);
        expect((await store.listProjects()).map((p) => p.name)).toEqual(['Banca en línea']);
        expect(await store.getProject(b.id)).toBeUndefined();
      }));

    it('no admite nombres vacíos ni repetidos (sin distinguir mayúsculas) ni ids inexistentes', () =>
      withStore(async (store) => {
        const a = await store.createProject({ name: 'Tienda' });
        await rejects(store.createProject({ name: '   ' }), 'invalid');
        await rejects(store.createProject({ name: 'x'.repeat(500) }), 'invalid');
        await rejects(store.createProject({ name: 'TIENDA' }), 'exists');
        const b = await store.createProject({ name: 'Banca' });
        await rejects(store.renameProject(b.id, ' tienda '), 'exists');
        await store.renameProject(a.id, 'TIENDA'); // cambiar solo las mayúsculas del propio nombre es válido
        await rejects(store.renameProject('no-existe', 'Otro'), 'not-found');
        await rejects(store.deleteProject('no-existe'), 'not-found');
      }));

    it('guarda diagramas de varios módulos, los lista sin documento y los devuelve con él', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        const c4 = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"a":1}' });
        const data = await store.saveDiagram(project.id, { module: 'data', name: 'Ventas', text: 'borrador {' });
        expect(c4).toMatchObject({ module: 'c4', name: 'Contexto' });
        const listed = (await store.getProject(project.id))!;
        expect(listed.diagrams.map((d) => [d.name, d.module])).toEqual([
          ['Contexto', 'c4'],
          ['Ventas', 'data'],
        ]);
        expect(listed.diagrams[0]).not.toHaveProperty('text');
        expect(await store.getDiagram(project.id, c4.id)).toMatchObject({ id: c4.id, module: 'c4', name: 'Contexto', text: '{"a":1}' });
        // un borrador que no es JSON también se conserva tal cual
        expect((await store.getDiagram(project.id, data.id))?.text).toBe('borrador {');
        expect(await store.getDiagram(project.id, 'nada')).toBeUndefined();
      }));

    it('actualizar un diagrama cambia el documento y la fecha, no el nombre ni el módulo', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno' });
        const updated = await store.saveDiagram(project.id, { id: created.id, text: 'dos' });
        expect(updated).toMatchObject({ id: created.id, name: 'Contexto', module: 'c4', createdAt: created.createdAt });
        expect(updated.updatedAt > created.updatedAt).toBe(true);
        expect((await store.getDiagram(project.id, created.id))?.text).toBe('dos');
        await rejects(store.saveDiagram(project.id, { id: created.id, module: 'data', text: 'x' }), 'invalid');
        await rejects(store.saveDiagram(project.id, { id: 'nada', text: 'x' }), 'not-found');
      }));

    it('crear un diagrama exige un módulo válido y un nombre libre en el proyecto', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        const other = await store.createProject({ name: 'Banca' });
        await rejects(store.saveDiagram(project.id, { text: '{}' }), 'invalid');
        await rejects(store.saveDiagram(project.id, { module: 'No Válido', text: '{}' }), 'invalid');
        await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{}' });
        await rejects(store.saveDiagram(project.id, { module: 'data', name: 'CONTEXTO', text: '{}' }), 'exists');
        // el mismo nombre en otro proyecto es válido
        await store.saveDiagram(other.id, { module: 'c4', name: 'Contexto', text: '{}' });
        expect((await store.saveDiagram(project.id, { module: 'data', text: '{}' })).name).toBe('Sin título');
        await rejects(store.saveDiagram('no-existe', { module: 'c4', text: '{}' }), 'not-found');
      }));

    it('renombrar y borrar diagramas', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        const a = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
        const b = await store.saveDiagram(project.id, { module: 'data', name: 'Ventas', text: 'b' });
        const renamed = await store.renameDiagram(project.id, a.id, 'Visión general');
        expect(renamed.name).toBe('Visión general');
        expect((await store.getDiagram(project.id, a.id))?.text).toBe('a'); // el documento no se toca
        await rejects(store.renameDiagram(project.id, a.id, 'ventas'), 'exists');
        await rejects(store.renameDiagram(project.id, 'nada', 'x'), 'not-found');
        await store.deleteDiagram(project.id, b.id);
        expect((await store.getProject(project.id))!.diagrams.map((d) => d.name)).toEqual(['Visión general']);
        await rejects(store.deleteDiagram(project.id, b.id), 'not-found');
      }));

    it('borrar un proyecto borra sus diagramas', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
        await store.deleteProject(project.id);
        // al volver a crear uno con el mismo nombre arranca vacío
        const again = await store.createProject({ name: 'Tienda' });
        expect(again.diagrams).toEqual([]);
      }));

    it('guardar con `ifUpdatedAt` rechaza el cambio si alguien tocó el diagrama en medio', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Tienda' });
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno' });
        const second = await store.saveDiagram(project.id, { id: created.id, text: 'dos', ifUpdatedAt: created.updatedAt });
        await rejects(store.saveDiagram(project.id, { id: created.id, text: 'tres', ifUpdatedAt: created.updatedAt }), 'conflict');
        expect((await store.getDiagram(project.id, created.id))?.text).toBe('dos');
        await store.saveDiagram(project.id, { id: created.id, text: 'cuatro', ifUpdatedAt: second.updatedAt });
        expect((await store.getDiagram(project.id, created.id))?.text).toBe('cuatro');
      }));

    it('conserva acentos, saltos de línea y documentos grandes sin alterarlos', () =>
      withStore(async (store) => {
        const project = await store.createProject({ name: 'Ñandú – Pruebas ✓' });
        const text = JSON.stringify({ nombre: 'Gestión de pedidos', filas: Array.from({ length: 3000 }, (_, i) => ({ i, v: `línea ${i}\n` })) }, null, 2);
        const saved = await store.saveDiagram(project.id, { module: 'integration', name: 'Pedidos: «versión 2»', text });
        expect((await store.getDiagram(project.id, saved.id))?.text).toBe(text);
        expect((await store.getProject(project.id))?.name).toBe('Ñandú – Pruebas ✓');
        expect((await store.getProject(project.id))?.diagrams[0].name).toBe('Pedidos: «versión 2»');
      }));
  });
}
