import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './registry';
import { createSuiteServer } from './serve';

// POST /api/<módulo>/diff: la comparación de versiones de un documento, la misma que `iark diff`.
const example = (file: string): Record<string, any> => JSON.parse(readFileSync(`examples/${file}`, 'utf8'));

describe('iark serve: POST /api/<módulo>/diff', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createSuiteServer({ registry: createDefaultRegistry(), version: '1' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('devuelve el DocumentDiff de dos documentos del módulo', async () => {
    const before = example('seguridad-ejemplo.json');
    before.controls.push({ ...before.controls[0], id: 'control-retirado', name: 'Control retirado' });
    const after = structuredClone(before);
    after.threats[0].status = 'mitigated';
    after.controls.pop();
    after.assets.push({ ...after.assets[0], id: 'nuevo', name: 'Activo nuevo' });
    const res = await post('/api/security/diff', { before, after });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const diff = await res.json();
    expect(Object.keys(diff)).toEqual(['added', 'removed', 'changed', 'moved', 'summary']);
    expect(diff.added).toMatchObject([{ collection: 'assets', id: 'nuevo', label: 'Activo nuevo' }]);
    expect(diff.removed).toMatchObject([{ collection: 'controls', id: 'control-retirado', label: 'Control retirado' }]);
    expect(diff.changed).toMatchObject([{ collection: 'threats', id: before.threats[0].id, fields: [{ path: 'status', after: 'mitigated' }] }]);
    expect(diff.summary).toMatchObject({ added: 1, removed: 1, changed: 1, total: 3 });
  });

  it('un documento contra sí mismo no tiene cambios, y en C4 la maquetación no cuenta', async () => {
    const same = await (await post('/api/integration/diff', { before: example('pedidos-integracion.json'), after: example('pedidos-integracion.json') })).json();
    expect(same.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0, fields: 0, total: 0, byCollection: {} });

    const before = example('banca.json');
    const after = structuredClone(before);
    for (const view of after.views) for (const e of view.elements) Object.assign(e, { x: 1, y: 2, width: 3, height: 4 });
    after.views[0].layout = { direction: 'LEFT' };
    expect((await (await post('/api/c4/diff', { before, after })).json()).summary.total).toBe(0);
  });

  it('acepta cada documento como objeto o como texto JSON', async () => {
    const before = example('seguridad-ejemplo.json');
    const after = structuredClone(before);
    after.zones[0].name = 'Otra zona';
    const diff = await (await post('/api/security/diff', { before: JSON.stringify(before), after })).json();
    expect(diff.changed).toMatchObject([{ collection: 'zones', fields: [{ path: 'name', after: 'Otra zona' }] }]);
  });

  it('responde 400 si falta una versión o el cuerpo no es JSON, 422 (diciendo cuál) si no cumple el esquema, 404 y 405 como las demás rutas', async () => {
    const doc = example('seguridad-ejemplo.json');
    const noBefore = await post('/api/security/diff', { after: doc });
    expect(noBefore.status).toBe(400);
    expect((await noBefore.json()).error).toContain('Falta "before"');
    expect((await post('/api/security/diff', { before: doc })).status).toBe(400);
    expect((await post('/api/security/diff', '{ roto')).status).toBe(400);
    expect((await post('/api/security/diff', '')).status).toBe(400);
    expect((await post('/api/security/diff', 'null')).status).toBe(400);
    expect((await post('/api/security/diff', { before: doc, after: '{ roto' })).status).toBe(400);

    const invalid = await post('/api/security/diff', { before: doc, after: { zones: [{ id: 'z', name: 'Z', trust: 'x' }] } });
    expect(invalid.status).toBe(422);
    const body = await invalid.json();
    expect(body.error).toContain('«after»');
    expect(body.issues[0].path).toContain('zones');
    expect((await (await post('/api/security/diff', { before: { zones: 1 }, after: doc })).json()).error).toContain('«before»');

    expect((await post('/api/nada/diff', { before: doc, after: doc })).status).toBe(404);
    const wrong = await fetch(`${base}/api/security/diff`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await (await fetch(`${base}/api/security/inventada`)).json()).error).toContain('import, diff o run');
  });
});
