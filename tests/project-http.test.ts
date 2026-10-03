import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpProjectStore, ProjectError } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';
import { createSuiteServer } from '../src/cli/serve';
import { FolderProjectStore } from '../src/cli/workspace';
import { projectStoreContract } from './helpers/projectStoreContract';

/**
 * El cliente remoto contra el servidor de verdad: el mismo contrato de almacén que cumplen la memoria, IndexedDB y la carpeta,
 * pero pasando por HTTP (`iark serve --workspace` sobre una carpeta temporal).
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Running {
  base: string;
  root: string;
  server: Server;
  close(): Promise<void>;
}

async function startServer(): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'iark-http-'));
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
  return { base, root, server, close };
}

projectStoreContract('HttpProjectStore (servidor real)', async () => {
  const running = await startServer();
  return { store: new HttpProjectStore({ baseUrl: running.base }), cleanup: running.close };
});

describe('HttpProjectStore contra iark serve', () => {
  it('dos clientes comparten el espacio de trabajo y el segundo ve lo que guardó el primero', async () => {
    const running = await startServer();
    cleanups.push(running.close);
    const one = new HttpProjectStore({ baseUrl: running.base });
    const two = new HttpProjectStore({ baseUrl: `${running.base}/api/projects/` }); // también acepta la dirección completa de la API
    const project = await one.createProject({ name: 'Tienda' });
    const diagram = await one.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"v":1}' });
    expect((await two.listProjects()).map((p) => [p.name, p.diagrams.length])).toEqual([['Tienda', 1]]);
    expect((await two.getDiagram(project.id, diagram.id))?.text).toBe('{"v":1}');
    // y `ifUpdatedAt` detecta que el otro cliente guardó en medio
    await two.saveDiagram(project.id, { id: diagram.id, text: '{"v":2}', ifUpdatedAt: diagram.updatedAt });
    await expect(one.saveDiagram(project.id, { id: diagram.id, text: '{"v":3}', ifUpdatedAt: diagram.updatedAt })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('whoami reconoce un servidor sin autenticación y «probar la conexión» avisa si no hay proyectos o no se llega', async () => {
    const running = await startServer();
    cleanups.push(running.close);
    expect(await new HttpProjectStore({ baseUrl: running.base }).whoami()).toEqual({ auth: false, name: undefined, role: undefined });

    // un servidor que arrancó sin --workspace no ofrece proyectos
    const bare = createSuiteServer({ registry: createDefaultRegistry(), version: '1' });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => bare.close(() => resolve())));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const error = await new HttpProjectStore({ baseUrl: url }).whoami().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectError);
    expect(error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('espacio de trabajo'), info: { status: 404 } });

    // nada escucha en ese puerto
    await running.close();
    cleanups.length = 0;
    const down = await new HttpProjectStore({ baseUrl: running.base, timeoutMs: 2000 }).listProjects().catch((e: unknown) => e);
    expect(down).toMatchObject({ code: 'unavailable', message: expect.stringContaining('No se pudo conectar'), info: { network: true } });
  });

  it('el detalle del error dice si hubo respuesta (estado HTTP) o no (red), y el token se puede cambiar sin crear otro cliente', async () => {
    let seen: string | null = null;
    const needsToken = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init.headers).get('Authorization');
      return seen === 'Bearer bueno'
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'Falta un token válido.', code: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const store = new HttpProjectStore({ baseUrl: 'http://x.example', fetch: needsToken });
    const rejected = await store.listProjects().catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: 'unauthorized', info: { status: 401 } });
    expect(seen).toBeNull();

    store.setToken(' bueno ');
    expect(await store.listProjects()).toEqual([]);
    expect(seen).toBe('Bearer bueno');
    store.setToken(undefined);
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(seen).toBeNull();
  });
});
