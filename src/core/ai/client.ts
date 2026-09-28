import Anthropic from '@anthropic-ai/sdk';

/**
 * Plataforma de IA:
 * - `anthropic`: API de Anthropic.
 * - `foundry`: Claude desplegado en Microsoft (Azure) Foundry (protocolo de mensajes de Anthropic).
 * - `openai`: cualquier modelo de Foundry (DeepSeek, Llama, Mistral, GPT…) o servicio compatible con Chat Completions.
 */
export type AiProvider = 'anthropic' | 'foundry' | 'openai';

export type Env = Record<string, string | undefined>;

/** Base URL, clave y modelo del endpoint compatible con OpenAI: `AI_*` y, si no, las `ANTHROPIC_FOUNDRY_*`. */
export function openaiSettings(env: Env = process.env): { baseURL?: string; apiKey?: string; model?: string } {
  return {
    baseURL: env.AI_BASE_URL || env.ANTHROPIC_FOUNDRY_BASE_URL || undefined,
    apiKey: env.AI_API_KEY || env.ANTHROPIC_FOUNDRY_API_KEY || undefined,
    model: env.AI_MODEL || env.ANTHROPIC_FOUNDRY_MODEL || undefined,
  };
}

/**
 * Elige la plataforma: la indicada explícitamente o, si no, la que sugiere el entorno:
 * una URL de Foundry con ruta `/openai/` (o `AI_BASE_URL`) → `openai` (cualquier modelo); otras variables
 * `ANTHROPIC_FOUNDRY_*` → `foundry` (Claude); nada de eso → `anthropic`.
 */
export function resolveProvider(explicit?: AiProvider | 'auto', env: Env = process.env): AiProvider {
  if (explicit && explicit !== 'auto') return explicit;
  const baseURL = env.AI_BASE_URL || env.ANTHROPIC_FOUNDRY_BASE_URL || '';
  if (env.AI_BASE_URL || /\/openai(\/|$)|\.openai\.azure\.com/i.test(baseURL)) return 'openai';
  const foundry = env.ANTHROPIC_FOUNDRY_API_KEY || env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_FOUNDRY_RESOURCE;
  return foundry ? 'foundry' : 'anthropic';
}

/**
 * Modelo a usar: el indicado, o el de `ANTHROPIC_FOUNDRY_MODEL` en Foundry (allí `model` es el nombre
 * de tu despliegue, no el id del catálogo), o el modelo por defecto.
 */
export function resolveModel(provider: AiProvider, requested: string | undefined, fallback: string, env: Env = process.env): string {
  if (requested) return requested;
  if (provider === 'openai') return openaiSettings(env).model || fallback;
  return (provider === 'foundry' ? env.ANTHROPIC_FOUNDRY_MODEL : undefined) || fallback;
}

/**
 * Crea el cliente de la plataforma. Foundry lee `ANTHROPIC_FOUNDRY_API_KEY` y
 * `ANTHROPIC_FOUNDRY_BASE_URL` (o `ANTHROPIC_FOUNDRY_RESOURCE`); el SDK se carga bajo demanda para que
 * quien solo usa la API de Anthropic no lo necesite.
 */
export async function createAiClient(provider: Exclude<AiProvider, 'openai'>, env: Env = process.env): Promise<Anthropic> {
  if (provider === 'anthropic') return new Anthropic();
  const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk');
  // El SDK rechaza tener a la vez URL base y recurso; si vienen las dos, manda la URL.
  const baseURL = env.ANTHROPIC_FOUNDRY_BASE_URL || undefined;
  return new AnthropicFoundry({ baseURL, resource: baseURL ? '' : env.ANTHROPIC_FOUNDRY_RESOURCE || undefined }) as unknown as Anthropic;
}

/** Mensaje de credenciales ausentes/inválidas según la plataforma. */
export function credentialsHint(provider: AiProvider): string {
  if (provider === 'openai') {
    return 'Credenciales inválidas o ausentes. Defina AI_API_KEY (o ANTHROPIC_FOUNDRY_API_KEY) y AI_BASE_URL (o ANTHROPIC_FOUNDRY_BASE_URL, p. ej. https://<recurso>.openai.azure.com/openai/v1).';
  }
  return provider === 'foundry'
    ? 'Credenciales inválidas o ausentes. Defina ANTHROPIC_FOUNDRY_API_KEY y ANTHROPIC_FOUNDRY_BASE_URL (o ANTHROPIC_FOUNDRY_RESOURCE).'
    : 'Credenciales inválidas o ausentes. Defina ANTHROPIC_API_KEY o inicie sesión con `ant auth login`.';
}
