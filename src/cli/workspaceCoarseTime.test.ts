import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectError } from '@iark/kernel';

// Un sistema de archivos que solo guarda marcas de modificación de 2 segundos (FAT): `utimes` trunca. Aquí se emula para
// comprobar que `updatedAt` sigue creciendo en cada guardado y que lo que devuelve un guardado es exactamente lo que se lee después
// (si no, `ifUpdatedAt` daría conflictos falsos).
const GRANULARITY_MS = 2000;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const truncate = (when: Date | number | string): Date => new Date(Math.floor(new Date(when).getTime() / GRANULARITY_MS) * GRANULARITY_MS);
  return { ...actual, utimes: (path: string, atime: Date, mtime: Date) => actual.utimes(path, truncate(atime), truncate(mtime)) };
});

const { FolderProjectStore } = await import('./workspace');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FolderProjectStore con marcas de modificación de 2 s', () => {
  it('updatedAt crece en cada guardado y coincide entre lo que devuelve guardar y lo que se lee', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-coarse-'));
    dirs.push(dir);
    const store = new FolderProjectStore(join(dir, 'espacio'));
    const project = await store.createProject({ name: 'P' });
    const created = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'v0' });
    expect(Date.parse(created.updatedAt) % GRANULARITY_MS).toBe(0); // de verdad se guardó truncado
    expect((await store.getDiagram(project.id, created.id))?.updatedAt).toBe(created.updatedAt);
    expect((await store.getProject(project.id))!.diagrams[0]).toMatchObject({ createdAt: created.createdAt, updatedAt: created.updatedAt });

    let previous = created;
    for (const text of ['v1', 'v2', 'v3', 'v4', 'v5']) {
      const next = await store.saveDiagram(project.id, { id: created.id, text, ifUpdatedAt: previous.updatedAt }); // sin conflictos falsos
      expect(next.updatedAt > previous.updatedAt, `${text}: ${previous.updatedAt} → ${next.updatedAt}`).toBe(true);
      expect(next.createdAt).toBe(created.createdAt);
      expect((await store.getDiagram(project.id, created.id))?.updatedAt).toBe(next.updatedAt);
      expect((await store.getProject(project.id))!.diagrams[0].updatedAt).toBe(next.updatedAt);
      previous = next;
    }
    // y el conflicto de verdad sigue siéndolo
    await expect(store.saveDiagram(project.id, { id: created.id, text: 'otro', ifUpdatedAt: created.updatedAt })).rejects.toBeInstanceOf(ProjectError);
    // renombrar el proyecto también hace crecer su fecha
    const before = (await store.getProject(project.id))!.updatedAt;
    expect((await store.renameProject(project.id, 'Q')).updatedAt >= before).toBe(true);
  });
});
