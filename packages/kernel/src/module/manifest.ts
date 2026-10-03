import { z } from 'zod';
import type { ModuleRegistry } from './registry';

/**
 * Manifiesto de federación: cada instancia publica `/.well-known/iark.json` con los módulos que ofrece, para que un
 * shell o un anfitrión los descubra sin acoplarse a su código. `buildManifest` lo genera y `manifestSchema` valida el
 * de una instancia remota antes de usarlo.
 */
export const MANIFEST_SCHEMA_ID = 'iark.manifest/1';

export const moduleManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  documentVersion: z.string(),
  importFormats: z.array(z.string()),
  exportFormats: z.array(z.string()),
  /** URLs (absolutas o relativas al manifiesto) de las superficies que ofrece la instancia para este módulo. */
  endpoints: z
    .object({
      embed: z.string().optional(),
      api: z.string().optional(),
      schema: z.string().optional(),
    })
    .optional(),
});

/** Cómo se autentica quien llama a la API de proyectos de la instancia: `bearer` (cabecera `Authorization: Bearer <token>`) o `none` (sin autenticación). */
export const PROJECTS_AUTH = ['bearer', 'none'] as const;
export type ProjectsAuth = (typeof PROJECTS_AUTH)[number];

export const manifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA_ID),
  name: z.string(),
  version: z.string(),
  modules: z.array(moduleManifestSchema),
  /** URL (absoluta o relativa al manifiesto) de la API de proyectos; solo la declara una instancia con espacio de trabajo (`iark serve --workspace`). */
  projects: z.string().optional(),
  /** Cómo se autentica esa API; acompaña a `projects`. */
  projectsAuth: z.enum(PROJECTS_AUTH).optional(),
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type SuiteManifest = z.infer<typeof manifestSchema>;

export interface ManifestOptions {
  name: string;
  version: string;
  /** Endpoints por id de módulo (p. ej. la URL del widget embebible). */
  endpoints?: Record<string, ModuleManifest['endpoints']>;
}

export function buildManifest(registry: ModuleRegistry, options: ManifestOptions): SuiteManifest {
  return {
    schema: MANIFEST_SCHEMA_ID,
    name: options.name,
    version: options.version,
    modules: registry.list().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      ...(m.description ? { description: m.description } : {}),
      documentVersion: m.documentVersion,
      importFormats: m.importers.map((i) => i.id),
      exportFormats: m.exporters.map((e) => e.id),
      ...(options.endpoints?.[m.id] ? { endpoints: options.endpoints[m.id] } : {}),
    })),
  };
}
