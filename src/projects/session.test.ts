import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, parseBundle, ProjectError } from '@iark/kernel';
import { ProjectSession, type LastOpened, type PointerStorage } from './session';

const memoryPointer = (): PointerStorage & { value?: LastOpened } => {
  const pointer: PointerStorage & { value?: LastOpened } = {
    read: () => pointer.value,
    write: (v) => void (pointer.value = v),
  };
  return pointer;
};

async function setup(options: { pointer?: PointerStorage } = {}) {
  const store = new MemoryProjectStore();
  const session = new ProjectSession(store, { debounceMs: 50, broadcast: false, persist: false, ...options });
  await session.init();
  return { store, session };
}

describe('sesión de proyectos', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('crear un proyecto lo abre y lo recuerda; al volver a empezar ofrece reabrirlo', async () => {
    const pointer = memoryPointer();
    const { store, session } = await setup({ pointer });
    const project = await session.createProject('Tienda');
    expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: undefined });
    const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: '{"a":1}' });
    expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: meta.id, save: 'saved' });
    expect(pointer.value).toEqual({ projectId: project.id, diagramId: meta.id });

    const again = new ProjectSession(store, { pointer, broadcast: false, persist: false });
    expect(await again.init()).toEqual({ projectId: project.id, diagramId: meta.id });
    expect(again.project?.name).toBe('Tienda');
    // si lo recordado ya no existe, no se ofrece
    await store.deleteDiagram(project.id, meta.id);
    const third = new ProjectSession(store, { pointer, broadcast: false, persist: false });
    expect(await third.init()).toEqual({ projectId: project.id, diagramId: undefined });
    await store.deleteProject(project.id);
    expect(await new ProjectSession(store, { pointer, broadcast: false, persist: false }).init()).toBeUndefined();
  });

  it('guarda solo tras una pausa y agrupa los cambios seguidos', async () => {
    const { store, session } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'data', name: 'Ventas', text: 'v0' });
    const spy = vi.spyOn(store, 'saveDiagram');
    session.queueSave('v1');
    session.queueSave('v2');
    session.queueSave('v3');
    expect(session.getState().save).toBe('pending');
    expect(session.dirty).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe('v3');
    expect(session.getState().save).toBe('saved');
    expect(session.dirty).toBe(false);
  });

  it('flush guarda al momento lo pendiente (cambiar de diagrama no pierde lo último)', async () => {
    const { store, session } = await setup();
    const project = await session.createProject('Tienda');
    const a = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
    const b = await session.createDiagram({ module: 'c4', name: 'B', text: 'b0' });
    await session.openDiagram(project.id, a.id);
    session.queueSave('a1');
    const opened = await session.openDiagram(project.id, b.id);
    expect(opened.text).toBe('b0');
    expect((await store.getDiagram(project.id, a.id))?.text).toBe('a1');
    expect(session.getState().diagramId).toBe(b.id);
    // sin diagrama adjunto, queueSave no hace nada
    session.detach();
    session.queueSave('suelto');
    await vi.advanceTimersByTimeAsync(100);
    expect((await store.getDiagram(project.id, b.id))?.text).toBe('b0');
    expect(session.getState().save).toBe('idle');
  });

  it('si otra pestaña guardó el mismo diagrama, avisa del conflicto y deja elegir sin perder nada', async () => {
    const { store, session } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
    await store.saveDiagram(project.id, { id: meta.id, text: 'de la otra pestaña' });

    session.queueSave('mío');
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getState().save).toBe('conflict');
    expect(session.getState().saveError).toMatch(/cambió desde que se abrió/);
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe('de la otra pestaña');
    expect(session.dirty).toBe(true);

    // quedarse con lo de esta pestaña
    await session.resolveConflict('overwrite');
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe('mío');
    expect(session.getState().save).toBe('saved');

    // descartar lo de esta pestaña y cargar lo de la otra
    await store.saveDiagram(project.id, { id: meta.id, text: 'otra vez de la otra' });
    session.queueSave('segundo intento');
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getState().save).toBe('conflict');
    const reloaded = await session.resolveConflict('reload');
    expect(reloaded?.text).toBe('otra vez de la otra');
    expect(session.getState().save).toBe('idle');
    expect(session.dirty).toBe(false);
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe('otra vez de la otra');
  });

  it('un fallo de guardado se muestra y se puede reintentar sin perder el texto', async () => {
    const { store, session } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
    const original = store.saveDiagram.bind(store);
    let fail = true;
    store.saveDiagram = async (id, input) => {
      if (fail) throw new ProjectError('unavailable', 'sin espacio');
      return original(id, input);
    };
    session.queueSave('a1');
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getState()).toMatchObject({ save: 'error', saveError: 'sin espacio' });
    expect(session.dirty).toBe(true);
    fail = false;
    await session.retry();
    expect(session.getState().save).toBe('saved');
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe('a1');
  });

  it('borrar el diagrama abierto o su proyecto lo suelta y descarta lo pendiente', async () => {
    const { store, session } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
    session.queueSave('a1');
    await session.deleteDiagram(project.id, meta.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: undefined, save: 'idle' });
    expect((await store.getProject(project.id))?.diagrams).toEqual([]);
    await session.deleteProject(project.id);
    expect(session.getState()).toMatchObject({ projectId: undefined, projects: [] });
  });

  it('exporta el proyecto a un archivo y lo importa como proyecto nuevo, que queda abierto', async () => {
    const { session } = await setup();
    const project = await session.createProject('Tienda');
    const a = await session.createDiagram({ module: 'c4', name: 'A', text: JSON.stringify({ x: 1 }) });
    await session.openDiagram(project.id, a.id);
    session.queueSave(JSON.stringify({ x: 2 })); // lo pendiente entra en la exportación
    const { fileName, text } = await session.exportProject(project.id);
    expect(fileName).toBe('tienda.iark-project.json');
    expect(parseBundle(text).diagrams[0].document).toEqual({ x: 2 });
    const imported = await session.importProject(text);
    expect(imported.project.name).toBe('Tienda (2)');
    expect(imported.renamedFrom).toBe('Tienda');
    expect(session.getState()).toMatchObject({ projectId: imported.project.id, diagramId: undefined });
    expect(session.getState().projects.map((p) => p.name)).toEqual(['Tienda', 'Tienda (2)']);
    await expect(session.importProject('no es un proyecto')).rejects.toBeInstanceOf(ProjectError);
  });

  it('crear un diagrama sin proyecto abierto se rechaza con un mensaje claro', async () => {
    const { session } = await setup();
    await expect(session.createDiagram({ module: 'c4', text: '{}' })).rejects.toThrow(/Abre o crea un proyecto/);
  });

  it('con el almacén roto, la sesión lo cuenta en lugar de fallar', async () => {
    const store = new MemoryProjectStore();
    store.listProjects = async () => {
      throw new ProjectError('unavailable', 'sin almacenamiento');
    };
    const session = new ProjectSession(store, { broadcast: false, persist: false });
    await session.init();
    expect(session.getState()).toMatchObject({ ready: true, available: false, error: 'sin almacenamiento', projects: [] });
  });
});
