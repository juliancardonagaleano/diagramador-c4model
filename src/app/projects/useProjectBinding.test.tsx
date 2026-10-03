// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDocument } from '@core/model/schema';
import { sampleDocument } from '@core/model/sample';
import { MODULE_SOURCES } from '../../modules-app/modules';
import { useDocumentStore } from '../store/documentStore';

// La sesión del editor se crea con el almacén de IndexedDB; aquí se sustituye por uno en memoria que la prueba también puede tocar
// (es «la otra pestaña»).
const backing = vi.hoisted(() => ({ store: undefined as unknown as InstanceType<typeof import('@iark/kernel').MemoryProjectStore> }));
vi.mock('../../projects/indexedDbStore', async () => {
  const { MemoryProjectStore: Memory } = await import('@iark/kernel');
  return {
    IndexedDbProjectStore: class {
      constructor() {
        backing.store = new Memory();
        return backing.store;
      }
    },
  };
});

import { resetProjectSession, useProjectBinding } from './useProjectBinding';

const text = (name: string) => JSON.stringify({ ...structuredClone(sampleDocument), workspace: { ...sampleDocument.workspace, name } }, null, 2);

describe('useProjectBinding (editor C4)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProjectSession();
    useDocumentStore.getState().newDocument();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetProjectSession();
  });

  async function setup() {
    const hook = renderHook(() => useProjectBinding());
    const { session } = hook.result.current;
    await waitFor(() => expect(session?.getState().available).toBe(true));
    return { hook, session: session! };
  }

  it('abrir un diagrama C4 lo carga en el editor sin marcarlo como modificado y sus cambios se guardan solos tras una pausa', async () => {
    const { hook, session } = await setup();
    const project = await session.createProject('Banca');
    const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: text('Banca A') });
    await act(async () => {
      await hook.result.current.open(project.id, meta);
    });
    expect(useDocumentStore.getState().doc.workspace.name).toBe('Banca A');
    expect(useDocumentStore.getState().modified).toBe(false);
    expect(session.attached).toBe(true);

    vi.useFakeTimers();
    const spy = vi.spyOn(backing.store, 'saveDiagram');
    act(() => useDocumentStore.getState().setWorkspaceName('Banca B'));
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await backing.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('Banca B');
    expect(useDocumentStore.getState().modified).toBe(false);
  });

  it('el documento que se carga al abrir no se vuelve a guardar como si fuera una edición', async () => {
    const { hook, session } = await setup();
    const project = await session.createProject('Sin eco');
    const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: text('Original') });
    vi.useFakeTimers();
    const spy = vi.spyOn(backing.store, 'saveDiagram');
    await act(async () => {
      await hook.result.current.open(project.id, meta);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('un diagrama que no es un documento C4 válido se rechaza con el motivo y se deja de guardar sobre él', async () => {
    const { hook, session } = await setup();
    const project = await session.createProject('Roto');
    const meta = await session.createDiagram({ module: 'c4', name: 'Borrador', text: '{"workspace": 3}' });
    const before = useDocumentStore.getState().doc;
    await act(async () => {
      await expect(hook.result.current.open(project.id, meta)).rejects.toThrow(/no es un documento C4 válido/);
    });
    expect(session.attached).toBe(false);
    expect(useDocumentStore.getState().doc).toBe(before);
    const other = await session.createDiagram({ module: 'c4', name: 'Texto', text: 'esto no es JSON' });
    await act(async () => {
      await expect(hook.result.current.open(project.id, other)).rejects.toThrow(/no es JSON válido/);
    });
  });

  it('guardar el documento actual lo deja abierto: el editor y el proyecto coinciden y lo siguiente que se edita se guarda', async () => {
    const { hook, session } = await setup();
    await session.createProject('Nuevo');
    useDocumentStore.getState().setWorkspaceName('Mi banca');
    const { module, text: body, name } = hook.result.current.current();
    expect(module).toBe('c4');
    expect(name).toBe('Mi banca');
    const meta = await session.createDiagram({ module, name, text: body });
    expect(session.getState().diagramId).toBe(meta.id);

    vi.useFakeTimers();
    act(() => useDocumentStore.getState().setWorkspaceName('Mi banca 2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const project = session.project!;
    expect(JSON.parse((await backing.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('Mi banca 2');
  });

  it('si otra pestaña guardó antes, hay conflicto: cargar la otra trae su versión y quedarse con la propia la conserva', async () => {
    const { hook, session } = await setup();
    const project = await session.createProject('Conflicto');
    const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: text('Base') });
    await act(async () => {
      await hook.result.current.open(project.id, meta);
    });
    vi.useFakeTimers();
    // la otra pestaña guarda su versión
    await backing.store.saveDiagram(project.id, { id: meta.id, module: 'c4', name: 'Contexto', text: text('De la otra') });
    act(() => useDocumentStore.getState().setWorkspaceName('Mía'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(session.getState().save).toBe('conflict');
    expect(JSON.parse((await backing.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('De la otra');

    await act(async () => {
      await hook.result.current.resolveConflict('reload');
    });
    expect(useDocumentStore.getState().doc.workspace.name).toBe('De la otra');
    expect(useDocumentStore.getState().modified).toBe(false);
    expect(session.getState().save).toBe('idle');

    // y quedarse con la propia versión también guarda
    await backing.store.saveDiagram(project.id, { id: meta.id, module: 'c4', name: 'Contexto', text: text('Otra vez la otra') });
    act(() => useDocumentStore.getState().setWorkspaceName('Gana la mía'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(session.getState().save).toBe('conflict');
    await act(async () => {
      await hook.result.current.resolveConflict('overwrite');
    });
    expect(JSON.parse((await backing.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('Gana la mía');
  });

  it('el documento vacío con el que el gestor crea un diagrama C4 es válido y trae una vista para empezar a dibujar', async () => {
    const blank = await MODULE_SOURCES.find((m) => m.id === 'c4')!.blank!();
    const result = validateDocument(JSON.parse(blank));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.views).toHaveLength(1);
  });
});
