import { buildManifest, type ModuleManifest, type ModuleRegistry, type SuiteManifest } from '@iark/kernel';

export const SUITE_NAME = 'IArk - DIAgrams';

/** Módulos cuyo editor propio es la aplicación principal (`index.html`); el resto los abre el banco de trabajo (`modulos.html`). */
const OWN_EDITOR = new Set(['c4']);

export interface SuiteManifestOptions {
  version: string;
  /**
   * Prefijo de la API HTTP de la instancia (`/api`); solo lo declara `iark serve`. El sitio estático (GitHub Pages) no
   * tiene API, así que su manifiesto no anuncia `api`.
   */
  api?: string;
}

/**
 * Manifiesto de federación de una instancia (`iark.manifest/1`). Las URL de `endpoints` son relativas al propio manifiesto,
 * que se publica en `/.well-known/iark.json`: `../modulos.html` es el banco de trabajo, `../schema/…` los JSON Schema.
 * Así el mismo manifiesto vale bajo cualquier ruta base (GitHub Pages sirve bajo `/<repositorio>/`).
 */
export function suiteManifest(registry: ModuleRegistry, options: SuiteManifestOptions): SuiteManifest {
  const endpoints: Record<string, ModuleManifest['endpoints']> = {};
  for (const module of registry.list()) {
    endpoints[module.id] = {
      embed: OWN_EDITOR.has(module.id) ? '../' : `../modulos.html?module=${module.id}`,
      schema: `../schema/${module.id}-document.schema.json`,
      ...(options.api ? { api: `${options.api.replace(/\/+$/, '')}/${module.id}` } : {}),
    };
  }
  return buildManifest(registry, { name: SUITE_NAME, version: options.version, endpoints });
}
