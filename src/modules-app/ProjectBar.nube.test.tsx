// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, pretty } from '@iark/kernel';
import { createProjectSession } from '../projects/factory';
import { ProjectSession } from '../projects/session';
import { fakeServer, type FakeServer } from '../projects/testing';
import { WorkbenchController, type ModuleSource } from './controller';
import { ProjectBar } from './ProjectBar';
import { FAKE_DOC, fakeModule } from './testing-editor';

/** La barra del proyecto del banco de trabajo con los proyectos en un servidor: indica dónde se guarda y cómo recuperarse de un fallo. */
const URL_ = 'http://localhost:8787';
const DOC = pretty(FAKE_DOC);
const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con contratos', load: async () => fakeModule as never, example: async () => DOC }];

async function setup(session: ProjectSession) {
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'fake', name: 'Pedidos', text: DOC });
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: session });
  await controller.openDiagram(project.id, meta.id);
  const onManage = vi.fn();
  render(<ProjectBar controller={controller} state={controller.getState()} onManage={onManage} notify={vi.fn()} />);
  return { controller, onManage, project, meta };
}

const remote = async (server: FakeServer, token?: string): Promise<ProjectSession> => {
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
};
const status = (): HTMLElement => screen.getByTestId('save-status');

describe('barra del proyecto: indicación del almacén', () => {
  afterEach(() => cleanup());

  it('en este navegador el estado es el de siempre, sin mencionar ningún servidor', async () => {
    const session = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false, debounceMs: 10 });
    await session.init();
    await setup(session);
    expect(status()).toHaveTextContent(/^Guardado en «Tienda»$/);
    expect(screen.queryByTestId('reconnect')).toBeNull();
  });

  it('con un servidor, «Guardado en «X» · servidor»', async () => {
    const session = await remote(fakeServer());
    await setup(session);
    expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/);
    session.dispose();
  });

  it('un guardado que falla por la red muestra el motivo y «Reintentar», que lo guarda cuando vuelve la conexión', async () => {
    const server = fakeServer();
    const session = await remote(server);
    const { project, meta } = await setup(session);
    server.down = true;
    session.queueSave('lo último');
    await waitFor(() => expect(status()).toHaveTextContent(/No se pudo guardar: No se pudo conectar/));
    expect(status()).toHaveAttribute('data-save', 'error');
    expect(screen.queryByTestId('reconnect')).toBeNull();
    server.down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/));
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo último');
    session.dispose();
  });

  it('un token rechazado al guardar avisa «El servidor no aceptó el token» con «Volver a conectar» (abre el panel), sin «Reintentar» y sin perder el texto', async () => {
    const server = fakeServer({ token: 'viejo' });
    const session = await remote(server, 'viejo');
    const { onManage } = await setup(session);
    server.token = 'nuevo';
    session.queueSave('lo que escribí');
    await waitFor(() => expect(status()).toHaveTextContent('El servidor no aceptó el token'));
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(session.dirty).toBe(true);
    await userEvent.click(screen.getByTestId('reconnect'));
    expect(onManage).toHaveBeenCalledWith('storage');
    session.dispose();
  });

  it('un servidor que no responde al abrir lo dice, y un token rechazado al abrir ofrece volver a conectar', async () => {
    const server = fakeServer({ token: 'secreto' });
    const session = await remote(server); // sin token
    const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: session });
    const onManage = vi.fn();
    render(<ProjectBar controller={controller} state={controller.getState()} onManage={onManage} notify={vi.fn()} />);
    expect(status()).toHaveTextContent('El servidor no aceptó el token');
    await userEvent.click(screen.getByRole('button', { name: 'Volver a conectar' }));
    expect(onManage).toHaveBeenCalledWith('storage');
    cleanup();

    server.token = undefined;
    server.down = true;
    const down = await remote(server);
    render(<ProjectBar controller={new WorkbenchController(SOURCES, { projects: down })} state={controller.getState()} onManage={vi.fn()} notify={vi.fn()} />);
    expect(status()).toHaveTextContent('Servidor no disponible');
    expect(screen.queryByRole('button', { name: 'Volver a conectar' })).toBeNull();
    session.dispose();
    down.dispose();
  });

  it('un conflicto con otra persona se explica y se resuelve con los mismos botones', async () => {
    const server = fakeServer();
    const session = await remote(server);
    const { project, meta, controller } = await setup(session);
    await server.store.saveDiagram(project.id, { id: meta.id, text: pretty({ ...FAKE_DOC, name: 'de otra persona' }) });
    session.queueSave('mío');
    await waitFor(() => expect(screen.getByTestId('save-conflict')).toHaveTextContent('Otra persona u otro equipo guardó «Pedidos» mientras lo editabas.'));
    await userEvent.click(screen.getByRole('button', { name: 'Quedarme con mi versión' }));
    await waitFor(() => expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/));
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('mío');
    await act(async () => controller.dispose());
    session.dispose();
  });

  it('una lectura en segundo plano que falla no tira la barra: sigue «Guardado» y lo avisa', async () => {
    const server = fakeServer();
    const session = await remote(server);
    await setup(session);
    server.down = true;
    await act(async () => session.refresh({ background: true }));
    expect(status()).toHaveTextContent('Guardado en «Tienda» · servidor (sin conexión con el servidor)');
    expect(screen.getByRole('combobox', { name: 'Proyecto' })).toBeEnabled();
    session.dispose();
  });
});
