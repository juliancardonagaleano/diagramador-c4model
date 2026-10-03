import { ProjectError, type ProjectErrorCode } from './errors';
import type { Diagram, DiagramMeta, ProjectStore, ProjectSummary, SaveDiagramInput } from './types';

/**
 * Almacén de proyectos remoto: habla con la API `/api/projects` de `iark serve --workspace` (la carpeta de trabajo de un
 * servidor propio) y cumple el mismo contrato que los almacenes locales. Es lo que usa el navegador para «guardar en la
 * nube»; solo necesita `fetch`, así que sirve igual en el CLI.
 *
 * Los errores del servidor vuelven como `ProjectError` con el mismo código que daría un almacén local; hay dos más que
 * solo pasan aquí: `unauthorized` (el servidor pide un token, o el token no sirve o no alcanza para esa operación) y
 * `unavailable` (no se llega al servidor, responde con un fallo suyo o no ofrece proyectos).
 */

export interface HttpProjectStoreOptions {
  /** Dirección del servicio, p. ej. `https://iark.ejemplo.org` o `http://localhost:8787`. Si lleva `/api/projects` al final, se ignora. */
  baseUrl: string;
  /** Token de acceso (`Authorization: Bearer`). Sin él solo se puede usar un servicio abierto. */
  token?: string;
  fetch?: typeof fetch;
  /** Tiempo máximo de cada petición. Por defecto, 20 s. */
  timeoutMs?: number;
}

/** Quién es el token ante el servidor (`GET /api/whoami`); sin autenticación en el servidor, `auth` es `false`. */
export interface RemoteSession {
  auth: boolean;
  name?: string;
  role?: string;
}

const API = '/api/projects';
const LOCAL_CODES: ReadonlySet<string> = new Set<ProjectErrorCode>(['not-found', 'exists', 'invalid', 'conflict']);

/** `https://x.org/` o `https://x.org/api/projects/` → `https://x.org`. Lanza `invalid` si no es una dirección http(s). */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProjectError('invalid', `«${value.trim().slice(0, 100)}» no es una dirección válida (por ejemplo https://iark.ejemplo.org).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProjectError('invalid', 'La dirección del servidor debe empezar por http:// o https://.');
  if (url.username || url.password) throw new ProjectError('invalid', 'La dirección del servidor no debe llevar usuario ni contraseña: el token se indica aparte.');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/projects$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}`;
}

interface Payload {
  error?: unknown;
  code?: unknown;
  [key: string]: unknown;
}

/** El error que corresponde a una respuesta que no es 2xx. */
function errorFromResponse(status: number, payload: Payload, retryAfter: string | null): ProjectError {
  const message = typeof payload.error === 'string' && payload.error ? payload.error : '';
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  if (code && LOCAL_CODES.has(code)) return new ProjectError(code as ProjectErrorCode, message || `Error ${status}.`);
  if (status === 401 || code === 'unauthorized') return new ProjectError('unauthorized', message || 'El servidor pide un token de acceso válido.');
  if (status === 403 || code === 'forbidden') return new ProjectError('unauthorized', message || 'Este token no tiene permiso para esa operación.');
  if (status === 429 || code === 'rate-limited') {
    const wait = Number(retryAfter);
    return new ProjectError('unavailable', message || `Demasiados intentos fallidos${Number.isFinite(wait) && wait > 0 ? `: espera ${Math.ceil(wait)} s` : ''}.`);
  }
  if (status === 413) return new ProjectError('invalid', message || 'El documento es demasiado grande para el servidor.');
  if (status === 400) return new ProjectError('invalid', message || 'El servidor rechazó la petición.');
  if (status === 404) return new ProjectError('unavailable', message || 'Ese servidor no ofrece proyectos (¿arrancó sin --workspace, o la dirección no es la de IArk?).');
  return new ProjectError('unavailable', `El servidor respondió ${status}${message ? `: ${message}` : ''}.`);
}

export class HttpProjectStore implements ProjectStore {
  readonly kind = 'http';
  /** La dirección del servicio, ya normalizada. */
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpProjectStoreOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Quién es este token ante el servidor, o `{ auth: false }` si el servidor no pide autenticación. Sirve para «probar la conexión». */
  async whoami(): Promise<RemoteSession> {
    try {
      const found = (await this.request('GET', '/api/whoami')) as Payload;
      return { auth: found.auth === true, name: typeof found.name === 'string' ? found.name : undefined, role: typeof found.role === 'string' ? found.role : undefined };
    } catch (error) {
      // Un servidor anterior a la autenticación no tiene `/api/whoami` (404): basta con que ofrezca proyectos sin pedir token.
      if (!(error instanceof ProjectError) || error.code !== 'unavailable') throw error;
      await this.listProjects();
      return { auth: false };
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.request('GET', API)) as ProjectSummary[];
  }

  async getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.read(() => this.request('GET', `${API}/${encodeURIComponent(id)}`)) as Promise<ProjectSummary | undefined>;
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    return (await this.request('POST', API, { name: input.name, description: input.description })) as ProjectSummary;
  }

  async renameProject(id: string, name: string): Promise<ProjectSummary> {
    return (await this.request('PATCH', `${API}/${encodeURIComponent(id)}`, { name })) as ProjectSummary;
  }

  async deleteProject(id: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(id)}`);
  }

  async getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.read(() => this.request('GET', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`)) as Promise<Diagram | undefined>;
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    const project = `${API}/${encodeURIComponent(projectId)}/diagrams`;
    if (input.id === undefined) {
      return (await this.request('POST', project, { module: input.module, name: input.name, text: input.text })) as DiagramMeta;
    }
    // Un diagrama no cambia de módulo: el servidor lo ignora al actualizar, así que se comprueba aquí (solo si alguien lo pide).
    if (input.module !== undefined) {
      const current = await this.getDiagram(projectId, input.id);
      if (!current) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${projectId}».`);
      if (current.module !== input.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es «${current.module}», no «${input.module}»).`);
    }
    return (await this.request('PUT', `${project}/${encodeURIComponent(input.id)}`, { text: input.text, ifUpdatedAt: input.ifUpdatedAt })) as DiagramMeta;
  }

  async renameDiagram(projectId: string, diagramId: string, name: string): Promise<DiagramMeta> {
    return (await this.request('PATCH', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`, { name })) as DiagramMeta;
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`);
  }

  /** Una lectura por id: lo que no existe (o un id que el servidor no acepta) es `undefined`, como en los almacenes locales. */
  private async read(get: () => Promise<unknown>): Promise<unknown> {
    try {
      return await get();
    } catch (error) {
      if (error instanceof ProjectError && (error.code === 'not-found' || error.code === 'invalid')) return undefined;
      throw error;
    }
  }

  private async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    // El servidor exige `Content-Type: application/json` en todo lo que modifica (también DELETE, con el cuerpo vacío).
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Nada de cookies ni credenciales del navegador (el token es la única credencial) y nada de respuestas guardadas en caché.
        credentials: 'omit',
        cache: 'no-store',
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const reason = timedOut ? `no respondió en ${Math.round(this.timeoutMs / 1000)} s` : error instanceof Error ? error.message : String(error);
      throw new ProjectError('unavailable', `No se pudo conectar con ${this.baseUrl}: ${reason}.`);
    }
    const raw = await response.text().catch(() => '');
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // una respuesta que no es JSON (una página de error de un proxy, por ejemplo) no se puede interpretar
        if (response.ok) throw new ProjectError('unavailable', `${this.baseUrl} no respondió como un servidor de IArk (la respuesta no es JSON).`);
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, payload && typeof payload === 'object' ? (payload as Payload) : {}, response.headers.get('Retry-After'));
    return payload;
  }
}
