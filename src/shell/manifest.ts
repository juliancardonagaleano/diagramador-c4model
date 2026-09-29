import { manifestSchema, type ModuleManifest } from '@iark/kernel';

/** Un módulo del manifiesto con sus endpoints ya resueltos a URL absolutas. */
export interface ResolvedModule extends ModuleManifest {
  embedUrl?: string;
  schemaUrl?: string;
  apiUrl?: string;
}

export interface ResolvedManifest {
  manifestUrl: string;
  name: string;
  version: string;
  modules: ResolvedModule[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Descubre los módulos que ofrece una instancia de la suite (esta u otra, incluso de otro origen) a partir de su
 * manifiesto `iark.manifest/1`. No necesita conocer el interior de ningún módulo: solo el manifiesto y los endpoints.
 * Los endpoints son relativos al manifiesto.
 */
export async function loadManifest(url: string, fetchImpl: typeof fetch = fetch): Promise<ResolvedManifest> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ManifestError(`No se pudo leer el manifiesto en ${url}: ${(error as Error).message}. Si la instancia es de otro origen, debe permitir CORS.`);
  }
  if (!response.ok) throw new ManifestError(`El manifiesto en ${url} respondió ${response.status}.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ManifestError(`El manifiesto en ${url} no es JSON válido.`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ManifestError(`El manifiesto en ${url} no es un iark.manifest/1 válido (${first.path.join('.') || 'raíz'}: ${first.message}).`);
  }
  const resolve = (endpoint: string | undefined): string | undefined => (endpoint ? new URL(endpoint, url).toString() : undefined);
  return {
    manifestUrl: url,
    name: parsed.data.name,
    version: parsed.data.version,
    modules: parsed.data.modules.map((m) => ({ ...m, embedUrl: resolve(m.endpoints?.embed), schemaUrl: resolve(m.endpoints?.schema), apiUrl: resolve(m.endpoints?.api) })),
  };
}
