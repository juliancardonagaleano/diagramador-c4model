import { MemoryProjectStore, ProjectError, type ProjectErrorCode, type ProjectStore } from '@iark/kernel';

/**
 * Apoyo de las pruebas: un `fetch` simulado que se comporta como la API `/api/projects` de `iark serve --workspace` (rutas,
 * códigos y cuerpos de error), sobre un almacén en memoria, con interruptores para provocar lo que pasa en la vida real:
 * red caída, un token que el servidor no acepta, un rol que no puede escribir, un servidor sin proyectos o un origen que el
 * navegador rechaza por CORS. No lo usa la aplicación.
 */
export interface FakeServer {
  fetch: typeof fetch;
  store: ProjectStore;
  /** Las peticiones recibidas (método y ruta), en orden. */
  log: string[];
  /** Red caída: toda petición falla como un `fetch` sin respuesta. */
  down: boolean;
  /** El navegador rechaza por CORS: las peticiones `cors` fallan sin respuesta, pero las `no-cors` llegan (opacas). */
  corsBlocked: boolean;
  /** Si es una cadena, el servidor exige ese token (`Authorization: Bearer`) y responde 401 si falta o no coincide. */
  token: string | undefined;
  /** Rol del token (`viewer` no puede escribir: 403). Solo cuenta si hay `token`. */
  role: 'viewer' | 'editor' | 'admin';
  name: string;
  /** Un servidor que arrancó sin `--workspace`: todo lo de `/api/projects` es 404. */
  noProjects: boolean;
}

const STATUS: Record<ProjectErrorCode, number> = { 'not-found': 404, exists: 409, conflict: 409, invalid: 400, unavailable: 500, unauthorized: 401, forbidden: 403 };

export function fakeServer(options: Partial<Pick<FakeServer, 'token' | 'role' | 'name' | 'noProjects'>> & { store?: ProjectStore } = {}): FakeServer {
  const server: FakeServer = {
    store: options.store ?? new MemoryProjectStore(),
    log: [],
    down: false,
    corsBlocked: false,
    token: options.token,
    role: options.role ?? 'editor',
    name: options.name ?? 'Ana',
    noProjects: options.noProjects ?? false,
    fetch: undefined as unknown as typeof fetch,
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    server.log.push(`${method} ${url.pathname}`);
    if (server.down) throw new TypeError('Failed to fetch');
    if (init.mode === 'no-cors') return new Response(null, { status: 200 }); // llega, pero opaca: no se puede leer
    if (server.corsBlocked) throw new TypeError('Failed to fetch');

    const headers = new Headers(init.headers);
    const authorization = headers.get('Authorization');
    const authorized = server.token === undefined || authorization === `Bearer ${server.token}`;
    const path = url.pathname;

    if (path === '/api/whoami') {
      if (server.noProjects) return json(404, { error: 'No existe esa ruta.' });
      if (server.token === undefined) return json(200, { auth: false });
      if (!authorized) return json(401, { error: 'Falta un token válido.', code: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return json(200, { auth: true, name: server.name, role: server.role });
    }
    if (!path.startsWith('/api/projects')) return json(404, { error: 'No existe esa ruta.' });
    if (server.noProjects) return json(404, { error: 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>).' });
    if (!authorized) return json(401, { error: 'Falta un token válido.', code: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (method !== 'GET' && server.role === 'viewer' && server.token !== undefined) return json(403, { error: 'Este token es de solo lectura.', code: 'forbidden' });

    const parts = path.split('/').slice(3).map(decodeURIComponent); // tras /api/projects
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const store = server.store;
    try {
      if (parts.length === 0) {
        if (method === 'GET') return json(200, await store.listProjects());
        if (method === 'POST') return json(201, await store.createProject({ name: String(body.name), description: body.description as string | undefined }));
      } else if (parts.length === 1) {
        if (method === 'GET') {
          const project = await store.getProject(parts[0]);
          return project ? json(200, project) : json(404, { error: `No existe el proyecto «${parts[0]}».`, code: 'not-found' });
        }
        if (method === 'PATCH') return json(200, await store.renameProject(parts[0], String(body.name)));
        if (method === 'DELETE') {
          await store.deleteProject(parts[0]);
          return json(200, { ok: true });
        }
      } else if (parts[1] === 'diagrams') {
        if (parts.length === 2 && method === 'POST') return json(201, await store.saveDiagram(parts[0], { module: body.module as string, name: body.name as string | undefined, text: String(body.text) }));
        if (parts.length === 3) {
          if (method === 'GET') {
            const diagram = await store.getDiagram(parts[0], parts[2]);
            return diagram ? json(200, diagram) : json(404, { error: `No existe el diagrama «${parts[2]}».`, code: 'not-found' });
          }
          if (method === 'PUT') return json(200, await store.saveDiagram(parts[0], { id: parts[2], text: String(body.text), ifUpdatedAt: body.ifUpdatedAt as string | undefined }));
          if (method === 'PATCH') return json(200, await store.renameDiagram(parts[0], parts[2], String(body.name)));
          if (method === 'DELETE') {
            await store.deleteDiagram(parts[0], parts[2]);
            return json(200, { ok: true });
          }
        }
      }
      return json(404, { error: 'No existe esa ruta.' });
    } catch (error) {
      if (error instanceof ProjectError) return json(STATUS[error.code], { error: error.message, code: error.code });
      throw error;
    }
  }) as typeof fetch;
  return server;
}
