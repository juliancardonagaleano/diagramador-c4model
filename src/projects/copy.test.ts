// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { HttpProjectStore, MemoryProjectStore } from '@iark/kernel';
import { saveBackend } from './backend';
import { copyProject, copyTargetFor } from './copy';
import { fakeServer } from './testing';

const BASE = 'http://localhost:8787';

async function seed(store: MemoryProjectStore) {
  const project = await store.createProject({ name: 'Tienda', description: 'Pedidos y pagos' });
  const a = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: JSON.stringify({ workspace: { name: 'Contexto' } }) });
  const b = await store.saveDiagram(project.id, { module: 'data', name: 'Borrador', text: '{ esto aún no es JSON' });
  return { project, a, b };
}

describe('copiar un proyecto entre almacenes', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('del navegador a un servidor: todo el proyecto (también un borrador que no es JSON válido) y el original queda intacto', async () => {
    const local = new MemoryProjectStore();
    const { project } = await seed(local);
    const server = fakeServer({ token: 'secreto' });
    const remote = new HttpProjectStore({ baseUrl: BASE, token: 'secreto', fetch: server.fetch });

    const imported = await copyProject(local, project.id, remote);
    expect(imported).toMatchObject({ diagrams: 2, project: { name: 'Tienda', description: 'Pedidos y pagos' } });
    expect(imported.renamedFrom).toBeUndefined();

    const [copied] = await server.store.listProjects();
    expect(copied.diagrams.map((d) => [d.module, d.name])).toEqual([
      ['data', 'Borrador'],
      ['c4', 'Contexto'],
    ]);
    const texts = new Map<string, string>();
    for (const d of copied.diagrams) texts.set(d.name, (await server.store.getDiagram(copied.id, d.id))!.text);
    expect(JSON.parse(texts.get('Contexto')!)).toEqual({ workspace: { name: 'Contexto' } });
    expect(texts.get('Borrador')).toBe('{ esto aún no es JSON');
    // el proyecto de origen no cambió
    expect(await local.listProjects()).toHaveLength(1);
    expect((await local.getProject(project.id))?.diagrams).toHaveLength(2);
  });

  it('nunca pisa: copiar dos veces crea «Tienda (2)» y dice cómo se llamaba el original', async () => {
    const local = new MemoryProjectStore();
    const { project } = await seed(local);
    const server = fakeServer();
    const remote = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
    await copyProject(local, project.id, remote);
    const second = await copyProject(local, project.id, remote);
    expect(second.project.name).toBe('Tienda (2)');
    expect(second.renamedFrom).toBe('Tienda');
    expect((await server.store.listProjects()).map((p) => p.name).sort()).toEqual(['Tienda', 'Tienda (2)']);
  });

  it('de un servidor al navegador', async () => {
    const server = fakeServer();
    const remote = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
    const { project } = await seed(server.store as MemoryProjectStore);
    const local = new MemoryProjectStore();
    const imported = await copyProject(remote, project.id, local);
    expect(imported.project.name).toBe('Tienda');
    expect((await local.listProjects())[0].diagrams).toHaveLength(2);
  });

  it('si el servidor falla a mitad, no queda un proyecto a medias en el destino y el error llega entero', async () => {
    const local = new MemoryProjectStore();
    const { project } = await seed(local);
    const server = fakeServer();
    let posts = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/diagrams') && ++posts === 2) throw new TypeError('Failed to fetch');
      return server.fetch(input, init);
    }) as typeof fetch;
    const remote = new HttpProjectStore({ baseUrl: BASE, fetch: flaky });
    await expect(copyProject(local, project.id, remote)).rejects.toMatchObject({ code: 'unavailable', info: { network: true } });
    expect(await server.store.listProjects()).toEqual([]);
    expect(await local.listProjects()).toHaveLength(1);
  });

  it('con un token de solo lectura el servidor no deja copiar (unauthorized) y no se crea nada', async () => {
    const local = new MemoryProjectStore();
    const { project } = await seed(local);
    const server = fakeServer({ token: 'lector', role: 'viewer' });
    const remote = new HttpProjectStore({ baseUrl: BASE, token: 'lector', fetch: server.fetch });
    await expect(copyProject(local, project.id, remote)).rejects.toMatchObject({ code: 'forbidden', info: { status: 403 } });
    expect(await server.store.listProjects()).toEqual([]);
  });

  it('un proyecto que ya no existe en el origen se rechaza con not-found', async () => {
    await expect(copyProject(new MemoryProjectStore(), 'no-existe', new MemoryProjectStore())).rejects.toMatchObject({ code: 'not-found' });
  });

  describe('a dónde se puede copiar (el otro almacén)', () => {
    it('con servidor activo, al navegador (su propio almacén local, no el de la sesión)', () => {
      const target = copyTargetFor({ kind: 'remote', url: BASE, host: 'localhost:8787' });
      expect(target).toMatchObject({ kind: 'local', ready: true, label: 'Copiar a este navegador', where: 'en este navegador' });
      const { store } = target.open();
      expect(store.kind).toBe('indexeddb');
    });

    it('con el navegador activo y sin servidor conocido, hay que conectar primero', () => {
      const target = copyTargetFor({ kind: 'local' });
      expect(target).toMatchObject({ kind: 'remote', ready: false, label: 'Copiar a un servidor…' });
      expect(() => target.open()).toThrow(/Conecta primero/);
    });

    it('con el navegador activo y un servidor conocido, un cliente propio con su token (la sesión no se toca)', async () => {
      saveBackend({ url: BASE, token: 'secreto' }, { active: false });
      const server = fakeServer({ token: 'secreto' });
      const target = copyTargetFor({ kind: 'local' }, { fetch: server.fetch });
      expect(target).toMatchObject({ kind: 'remote', ready: true, label: 'Copiar al servidor (localhost:8787)', where: 'en el servidor localhost:8787' });
      const { store } = target.open();
      expect(store.kind).toBe('http');
      await store.listProjects();
      expect(server.log).toEqual(['GET /api/projects']);
    });
  });
});
