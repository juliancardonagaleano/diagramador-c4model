import { describe, expect, it, vi } from 'vitest';
import { HttpProjectStore, normalizeBaseUrl } from './http';
import { ProjectError } from './errors';

/** Un `fetch` que responde lo que se le diga y recuerda las peticiones. */
function fakeFetch(respond: (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const out = respond(url, init);
    if (out instanceof Error) throw out;
    const text = out.text ?? (out.body === undefined ? '' : JSON.stringify(out.body));
    return new Response(text, { status: out.status ?? 200, headers: out.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const store = (respond: Parameters<typeof fakeFetch>[0], options: { token?: string; baseUrl?: string } = {}) => {
  const { fetch, calls } = fakeFetch(respond);
  return { store: new HttpProjectStore({ baseUrl: options.baseUrl ?? 'https://iark.example/', token: options.token, fetch }), calls };
};

const failure = async (promise: Promise<unknown>): Promise<ProjectError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  return error as ProjectError;
};

describe('normalizeBaseUrl', () => {
  it('deja el origen (y la ruta de un proxy), sin barra final ni la ruta de la API', () => {
    expect(normalizeBaseUrl(' https://iark.example/ ')).toBe('https://iark.example');
    expect(normalizeBaseUrl('https://iark.example/api/projects/')).toBe('https://iark.example');
    expect(normalizeBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeBaseUrl('https://example.org/iark/api')).toBe('https://example.org/iark');
  });

  it('rechaza lo que no es una dirección http(s) y las que llevan usuario o contraseña', () => {
    for (const bad of ['', 'iark.example', 'ftp://iark.example', 'javascript:alert(1)', 'https://user:pass@iark.example']) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(ProjectError);
    }
  });
});

describe('HttpProjectStore', () => {
  it('pide cada operación a su ruta, con los ids codificados y el cuerpo que espera la API', async () => {
    const { store: s, calls } = store((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/projects')) return { status: 201, body: { id: 'tienda', name: 'Tienda', diagrams: [] } };
      return { body: { id: 'x' } };
    });
    await s.listProjects();
    await s.createProject({ name: 'Tienda', description: 'Pedidos' });
    await s.renameProject('a b', 'Otro');
    await s.saveDiagram('p', { module: 'c4', name: 'Contexto', text: '{}' });
    await s.saveDiagram('p', { id: 'd/1', text: '{"a":1}', ifUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await s.renameDiagram('p', 'd', 'Nuevo');
    await s.deleteDiagram('p', 'd');
    await s.deleteProject('p');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://iark.example', '')}`)).toEqual([
      'GET /api/projects',
      'POST /api/projects',
      'PATCH /api/projects/a%20b',
      'POST /api/projects/p/diagrams',
      'PUT /api/projects/p/diagrams/d%2F1',
      'PATCH /api/projects/p/diagrams/d',
      'DELETE /api/projects/p/diagrams/d',
      'DELETE /api/projects/p',
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ name: 'Tienda', description: 'Pedidos' });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ module: 'c4', name: 'Contexto', text: '{}' });
    expect(JSON.parse(String(calls[4].init.body))).toEqual({ text: '{"a":1}', ifUpdatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('manda el token como Bearer, JSON también en DELETE, y nunca cookies ni credenciales', async () => {
    const { store: s, calls } = store(() => ({ body: [] }), { token: ' iark_secreto ' });
    await s.listProjects();
    await s.deleteProject('p');
    const [get, del] = calls.map((c) => ({ headers: c.init.headers as Record<string, string>, credentials: (c.init as { credentials?: string }).credentials }));
    expect(get.headers.Authorization).toBe('Bearer iark_secreto');
    expect(get.headers['Content-Type']).toBeUndefined();
    expect(del.headers['Content-Type']).toBe('application/json');
    expect([get.credentials, del.credentials]).toEqual(['omit', 'omit']);
    const anonymous = store(() => ({ body: [] }));
    await anonymous.store.listProjects();
    expect((anonymous.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('traduce los errores del servidor a los códigos del contrato', async () => {
    const cases: Array<[number, unknown, string]> = [
      [404, { error: 'No existe', code: 'not-found' }, 'not-found'],
      [409, { error: 'Ya existe', code: 'exists' }, 'exists'],
      [409, { error: 'Cambió', code: 'conflict' }, 'conflict'],
      [400, { error: 'Mal', code: 'invalid' }, 'invalid'],
      [400, { error: 'Id inválido' }, 'invalid'],
      [413, { error: 'Grande' }, 'invalid'],
      [401, { error: 'Falta token', code: 'unauthorized' }, 'unauthorized'],
      [403, { error: 'Sin permiso', code: 'forbidden' }, 'forbidden'],
      [403, { error: 'Origen no autorizado «https://x.org»' }, 'forbidden'],
      [429, { error: 'Calma', code: 'rate-limited' }, 'unavailable'],
      [404, { error: 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)' }, 'unavailable'],
      [500, { error: 'Fallo', code: 'unavailable' }, 'unavailable'],
      [502, '<html>Bad gateway</html>', 'unavailable'],
    ];
    for (const [status, body, code] of cases) {
      const s = store(() => (typeof body === 'string' ? { status, text: body } : { status, body })).store;
      const error = await failure(s.createProject({ name: 'x' }));
      expect(error.code, `${status} ${JSON.stringify(body)}`).toBe(code);
      if (typeof body === 'object' && body && 'error' in body) expect(error.message).toContain(String(body.error));
    }
  });

  it('el 429 dice cuánto esperar y un 401 sin mensaje lo explica', async () => {
    const limited = store(() => ({ status: 429, body: {}, headers: { 'Retry-After': '12' } })).store;
    expect((await failure(limited.listProjects())).message).toContain('12 s');
    const noToken = store(() => ({ status: 401, body: {} })).store;
    expect((await failure(noToken.listProjects())).message).toContain('token');
  });

  it('una lectura de algo que no existe (o de un id que el servidor no acepta) es `undefined`; otros fallos siguen siéndolo', async () => {
    const missing = store(() => ({ status: 404, body: { error: 'No existe', code: 'not-found' } })).store;
    expect(await missing.getProject('x')).toBeUndefined();
    expect(await missing.getDiagram('x', 'y')).toBeUndefined();
    const badId = store(() => ({ status: 400, body: { error: 'Identificador inválido' } })).store;
    expect(await badId.getProject('../x')).toBeUndefined();
    const denied = store(() => ({ status: 401, body: { error: 'x', code: 'unauthorized' } })).store;
    expect((await failure(denied.getProject('x'))).code).toBe('unauthorized');
  });

  it('un fallo de red o de tiempo es `unavailable` con la dirección, y una respuesta que no es JSON no se da por buena', async () => {
    const offline = store(() => new TypeError('fetch failed')).store;
    const error = await failure(offline.listProjects());
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error.message).toContain('https://iark.example');
    expect(error.message).toContain('fetch failed');
    const timeout = store(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })).store;
    expect((await failure(timeout.listProjects())).message).toContain('no respondió');
    const html = store(() => ({ text: '<html>login</html>' })).store;
    expect((await failure(html.listProjects())).message).toContain('no es JSON');
  });

  it('cambiar el módulo de un diagrama al guardarlo se rechaza sin llegar a escribir', async () => {
    const { store: s, calls } = store((_url, init) => (init.method === 'GET' ? { body: { id: 'd', module: 'c4', name: 'A', text: '{}' } } : { body: {} }));
    expect((await failure(s.saveDiagram('p', { id: 'd', module: 'data', text: 'x' }))).code).toBe('invalid');
    expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    await s.saveDiagram('p', { id: 'd', module: 'c4', text: 'x' }); // el mismo módulo es válido
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'PUT']);
  });

  it('whoami lee quién es el token; con un servidor anterior a la autenticación comprueba que ofrezca proyectos', async () => {
    const auth = store(() => ({ body: { auth: true, name: 'ana', role: 'editor' } }), { token: 'iark_x' }).store;
    expect(await auth.whoami()).toEqual({ auth: true, name: 'ana', role: 'editor' });
    const open = store(() => ({ body: { auth: false } })).store;
    expect(await open.whoami()).toEqual({ auth: false, name: undefined, role: undefined });
    const legacy = store((url) => (url.endsWith('/api/whoami') ? { status: 404, body: { error: 'módulo desconocido' } } : { body: [] })).store;
    expect((await legacy.whoami()).auth).toBe(false);
    const locked = store(() => ({ status: 401, body: { error: 'Token inválido', code: 'unauthorized' } })).store;
    expect((await failure(locked.whoami())).code).toBe('unauthorized');
  });
});
