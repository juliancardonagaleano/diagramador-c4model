import { buildManifest, type ModuleManifest, type ModuleRegistry, type SuiteManifest } from '@iark/kernel';

export const SUITE_NAME = 'IArk - DIAgrams';

/** Módulos cuyo editor propio es la aplicación principal (`index.html`); el resto los abre el banco de trabajo (`modulos.html`). */
const OWN_EDITOR = new Set(['c4']);

export interface SuiteManifestOptions {
  version: string;
  /**
   * Prefijo de la API HTTP de la instancia, relativo al manifiesto (`../api`); solo lo declara `iark serve`. El sitio
   * estático (GitHub Pages) no tiene API, así que su manifiesto no anuncia `api`.
   */
  api?: string;
  /** La instancia sirve el sitio (editores embebibles y JSON Schema estáticos). Por defecto sí; un servicio solo con API, no. */
  site?: boolean;
}

/**
 * Manifiesto de federación de una instancia (`iark.manifest/1`). Las URL de `endpoints` son relativas al propio manifiesto,
 * que se publica en `/.well-known/iark.json`: `../modulos.html` es el banco de trabajo, `../schema/…` los JSON Schema.
 * Así el mismo manifiesto vale bajo cualquier ruta base (GitHub Pages sirve bajo `/<repositorio>/`).
 */
export function suiteManifest(registry: ModuleRegistry, options: SuiteManifestOptions): SuiteManifest {
  const site = options.site ?? true;
  const api = options.api?.replace(/\/+$/, '');
  const endpoints: Record<string, ModuleManifest['endpoints']> = {};
  for (const module of registry.list()) {
    const found = {
      ...(site ? { embed: OWN_EDITOR.has(module.id) ? '../' : `../modulos.html?module=${module.id}` } : {}),
      ...(site ? { schema: `../schema/${module.id}-document.schema.json` } : api ? { schema: `${api}/${module.id}/schema` } : {}),
      ...(api ? { api: `${api}/${module.id}` } : {}),
    };
    if (Object.keys(found).length > 0) endpoints[module.id] = found;
  }
  return buildManifest(registry, { name: SUITE_NAME, version: options.version, endpoints });
}
