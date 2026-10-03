import { HttpProjectStore } from '@iark/kernel';
import { hostOf, loadBackend, pointerKey, type BackendConfig } from './backend';
import { IndexedDbProjectStore } from './indexedDbStore';
import { localPointer, pointerAt, ProjectSession, type SessionOptions } from './session';

/**
 * La única fábrica de sesiones de proyectos de la app web: el banco de trabajo (`modulos.html`) y el editor C4 le piden la
 * suya y ella elige el almacén según lo configurado (`backend.ts`): IndexedDB de este navegador o un servidor propio por HTTP.
 * Cambiar de almacén recarga la página, así que una pestaña usa siempre el mismo.
 */

export interface CreateSessionOptions {
  /** Configuración a usar; por defecto, la guardada en el navegador. */
  config?: BackendConfig;
  /** `fetch` del cliente remoto (las pruebas ponen uno simulado). */
  fetch?: typeof fetch;
  /** Ajustes de la sesión (las pruebas acortan las esperas). */
  session?: SessionOptions;
}

/** Una pausa algo más larga que en el navegador: cada guardado es una petición de red con el documento entero. */
const REMOTE_DEBOUNCE_MS = 800;

export function createProjectSession(options: CreateSessionOptions = {}): ProjectSession {
  const config = options.config ?? loadBackend();
  if (config.kind === 'remote') {
    const store = new HttpProjectStore({ baseUrl: config.url, token: config.token, fetch: options.fetch });
    return new ProjectSession(store, {
      // el último abierto y el canal entre pestañas son de ese servidor; un servidor no necesita pedir almacenamiento persistente
      pointer: pointerAt(pointerKey({ ...config, url: store.baseUrl })),
      channel: `iark-projects:${store.baseUrl}`,
      persist: false,
      debounceMs: REMOTE_DEBOUNCE_MS,
      backend: { kind: 'remote', url: store.baseUrl, host: hostOf(store.baseUrl), ...(config.label ? { label: config.label } : {}) },
      ...options.session,
    });
  }
  return new ProjectSession(new IndexedDbProjectStore(), { pointer: localPointer, ...options.session });
}

let shared: ProjectSession | undefined;

/** La sesión de proyectos de esta pestaña (una sola, la de la configuración que había al cargar la página). */
export function getProjectSession(): ProjectSession {
  shared ??= createProjectSession();
  return shared;
}

/** Suelta la sesión compartida (la siguiente petición crea otra). Solo para las pruebas. */
export function resetProjectSession(): void {
  shared?.dispose();
  shared = undefined;
}
