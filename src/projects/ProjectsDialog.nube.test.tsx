// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from '@iark/kernel';
import { loadBackend } from './backend';
import type { CopyTarget } from './copy';
import { createProjectSession } from './factory';
import { ProjectsDialog, type ProjectsDialogProps } from './ProjectsDialog';
import { ProjectSession } from './session';
import { fakeServer, type FakeServer } from './testing';

/** El gestor con el almacén en la nube: pie, panel «Dónde se guardan», copiar entre almacenes y refresco de la lista. */
const URL_ = 'http://localhost:8787';
const DEV = { protocol: 'http:', origin: 'http://localhost:5173' };
const MODULES = [{ id: 'c4', label: 'C4' }];

const localSession = async (): Promise<{ session: ProjectSession; store: MemoryProjectStore }> => {
  const store = new MemoryProjectStore();
  const session = new ProjectSession(store, { broadcast: false, persist: false });
  await session.init();
  return { session, store };
};

async function remoteSession(server: FakeServer, token?: string): Promise<ProjectSession> {
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
}

function renderDialog(session: ProjectSession, extra: Partial<ProjectsDialogProps> = {}) {
  const props = { onOpen: vi.fn(), onClose: vi.fn(), notify: vi.fn() };
  render(<ProjectsDialog session={session} modules={MODULES} template={async () => '{}'} {...props} {...extra} />);
  return props;
}

const memoryTarget = (store: MemoryProjectStore, kind: CopyTarget['kind'] = 'remote'): CopyTarget => ({
  kind,
  where: kind === 'remote' ? 'en el servidor' : 'en este navegador',
  label: kind === 'remote' ? 'Copiar al servidor (prueba)' : 'Copiar a este navegador',
  ready: true,
  open: () => ({ store, close: () => undefined }),
});

describe('gestor de proyectos con el almacén en la nube', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  describe('con los proyectos en este navegador', () => {
    it('el pie es el de siempre, el panel dice «Este navegador» y Escape pliega el panel antes de cerrar el diálogo', async () => {
      const { session } = await localSession();
      const { onClose } = renderDialog(session);
      expect(screen.getByTestId('projects-foot')).toHaveTextContent('Los proyectos se guardan en este navegador. Para llevarlos a otro equipo o tener una copia de seguridad, usa Exportar e Importar proyecto.');
      expect(screen.getByTestId('storage-summary')).toHaveTextContent('Este navegador');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar a un servidor…' }));
      expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('form', { name: 'Conectar a un servidor' })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('«Copiar a un servidor…» sin servidor conocido lleva al formulario de conexión, que ofrece copiar ese proyecto', async () => {
      const { session } = await localSession();
      await session.createProject('Tienda');
      renderDialog(session);
      await userEvent.click(screen.getByRole('button', { name: 'Copiar a un servidor…' }));
      expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copiar «Tienda» al servidor' })).toBeInTheDocument();
    });

    it('conectar el servidor desde ahí copia el proyecto con su documento, muestra el resultado y no cambia de almacén', async () => {
      const server = fakeServer({ token: 'secreto' });
      const { session, store } = await localSession();
      const project = await session.createProject('Tienda');
      await session.createDiagram({ module: 'c4', name: 'Contexto', text: '{"x":1}' });
      const reload = vi.fn();
      const { notify } = renderDialog(session, { storage: { fetch: server.fetch, page: DEV, reload } });
      await userEvent.click(screen.getByRole('button', { name: 'Copiar a un servidor…' }));
      await userEvent.type(screen.getByLabelText('Dirección del servidor'), URL_);
      await userEvent.type(screen.getByLabelText('Token de acceso'), 'secreto');
      await userEvent.click(screen.getByRole('button', { name: 'Copiar «Tienda» al servidor' }));

      expect(await screen.findByTestId('projects-note')).toHaveTextContent('Copiado como «Tienda» en el servidor localhost:8787.');
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('Copiado como «Tienda»'));
      const [copied] = await server.store.listProjects();
      expect(copied.name).toBe('Tienda');
      expect(JSON.parse((await server.store.getDiagram(copied.id, copied.diagrams[0].id))!.text)).toEqual({ x: 1 });
      // este navegador sigue siendo el almacén: no se recargó, el proyecto original está donde estaba y el servidor quedó conocido
      expect(reload).not.toHaveBeenCalled();
      expect(await store.getProject(project.id)).toBeDefined();
      expect(session.remote).toBe(false);
      expect(loadBackend()).toMatchObject({ kind: 'local', server: { url: URL_, token: 'secreto' } });
      // con el servidor ya conocido, el botón copia directamente (y no pisa: «Tienda (2)»)
      await userEvent.click(await screen.findByRole('button', { name: 'Copiar al servidor (localhost:8787)' }));
      await waitFor(() => expect(screen.getByTestId('projects-note')).toHaveTextContent('Copiado como «Tienda (2)» en el servidor localhost:8787: ya había uno llamado «Tienda».'));
      expect((await server.store.listProjects()).map((p) => p.name).sort()).toEqual(['Tienda', 'Tienda (2)']);
    });

    it('copiar con el servidor conocido pero un token que ya no vale muestra el motivo y abre el formulario para escribirlo de nuevo', async () => {
      const server = fakeServer({ token: 'nuevo' });
      const { session } = await localSession();
      await session.createProject('Tienda');
      const { saveBackend } = await import('./backend');
      saveBackend({ url: URL_, token: 'viejo' }, { active: false });
      renderDialog(session, { storage: { fetch: server.fetch, page: DEV, reload: vi.fn() } });
      await userEvent.click(screen.getByRole('button', { name: 'Copiar al servidor (localhost:8787)' }));
      expect(await screen.findByTestId('projects-error')).toHaveTextContent('No se pudo copiar «Tienda» en el servidor localhost:8787');
      expect(screen.getByTestId('projects-error')).toHaveTextContent('Falta un token válido');
      expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
      expect(await server.store.listProjects()).toEqual([]);
    });

    it('un destino inyectado (otro almacén) recibe la copia sin tocar la sesión', async () => {
      const { session } = await localSession();
      await session.createProject('Tienda');
      const target = new MemoryProjectStore();
      renderDialog(session, { copyTarget: memoryTarget(target) });
      await userEvent.click(screen.getByRole('button', { name: 'Copiar al servidor (prueba)' }));
      expect(await screen.findByTestId('projects-note')).toHaveTextContent('Copiado como «Tienda» en el servidor.');
      expect((await target.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
    });
  });

  describe('con los proyectos en un servidor', () => {
    it('el pie corresponde al servidor, y la copia va al navegador', async () => {
      const server = fakeServer();
      const session = await remoteSession(server);
      await session.createProject('Tienda');
      const local = new MemoryProjectStore();
      renderDialog(session, { copyTarget: memoryTarget(local, 'local') });
      expect(screen.getByTestId('projects-foot')).toHaveTextContent('Los proyectos se guardan en el servidor localhost:8787');
      expect(screen.getByTestId('projects-foot')).not.toHaveTextContent('en este navegador');
      await userEvent.click(screen.getByRole('button', { name: 'Copiar a este navegador' }));
      expect(await screen.findByTestId('projects-note')).toHaveTextContent('Copiado como «Tienda» en este navegador.');
      expect((await local.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
      // la lista del servidor no cambió
      expect((await server.store.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
    });

    it('al abrirlo lee la lista del servidor (otra persona pudo cambiarla) y la mantiene al día mientras está abierto', async () => {
      const server = fakeServer();
      const session = await remoteSession(server);
      await server.store.createProject({ name: 'De otro equipo' });
      server.log.length = 0;
      renderDialog(session);
      expect(await screen.findByRole("button", { name: /^De otro equipo/ })).toBeInTheDocument();
      expect(server.log).toContain('GET /api/projects');
    });

    it('un error de permiso al crear (token de solo lectura) se explica y despliega «Dónde se guardan»', async () => {
      const server = fakeServer({ token: 'lector', role: 'viewer' });
      const session = await remoteSession(server, 'lector');
      renderDialog(session);
      expect(screen.queryByRole('form', { name: 'Conectar a un servidor' })).toBeNull();
      await userEvent.type(screen.getByPlaceholderText('Nombre del proyecto'), 'Tienda');
      await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
      expect(await screen.findByTestId('projects-error')).toHaveTextContent('Este token es de solo lectura');
      expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
    });

    it('si el servidor rechaza el token al abrir, el panel aparece desplegado con el aviso', async () => {
      const server = fakeServer({ token: 'secreto' });
      const session = await remoteSession(server); // sin token
      renderDialog(session);
      expect(screen.getByTestId('storage-rejected')).toBeInTheDocument();
      expect(screen.getByText(/No se pudo usar el servidor localhost:8787/)).toBeInTheDocument();
      const form = screen.getByRole('form', { name: 'Conectar a un servidor' });
      expect(within(form).getByLabelText('Token de acceso')).toBeInTheDocument();
    });

    it('con el servidor caído al abrir, lo dice y remite a «Dónde se guardan»', async () => {
      const server = fakeServer();
      server.down = true;
      const session = await remoteSession(server);
      renderDialog(session);
      expect(screen.getByText(/No se pudo usar el servidor localhost:8787: No se pudo conectar/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled();
    });

    it('un corte de red posterior solo avisa (la lista y los botones siguen), y se pide abrir directamente el panel con initialPanel', async () => {
      const server = fakeServer();
      const session = await remoteSession(server);
      await session.createProject('Tienda');
      server.down = true;
      await session.refresh({ background: true });
      renderDialog(session, { initialPanel: 'storage' });
      expect(screen.getByTestId('projects-sync-error')).toHaveTextContent('Sin conexión con el servidor localhost:8787');
      expect(screen.getByRole("button", { name: /^Tienda/ })).toBeInTheDocument();
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Sin conexión');
      expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
    });
  });
});
