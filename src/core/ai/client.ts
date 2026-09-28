import Anthropic from '@anthropic-ai/sdk';

/** Plataforma desde la que se consume Claude: API de Anthropic o Microsoft (Azure) Foundry. */
export type AiProvider = 'anthropic' | 'foundry';

export type Env = Record<string, string | undefined>;

/**
 * Elige la plataforma: la indicada explícitamente o, si no, Foundry cuando el entorno trae alguna variable
 * `ANTHROPIC_FOUNDRY_*` y la API de Anthropic en cualquier otro caso.
 */
export function resolveProvider(explicit?: AiProvider | 'auto', env: Env = process.env): AiProvider {
  if (explicit && explicit !== 'auto') return explicit;
  const foundry = env.ANTHROPIC_FOUNDRY_API_KEY || env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_FOUNDRY_RESOURCE;
  return foundry ? 'foundry' : 'anthropic';
}

/**
 * Modelo a usar: el indicado, o el de `ANTHROPIC_FOUNDRY_MODEL` en Foundry (allí `model` es el nombre
 * de tu despliegue, no el id del catálogo), o el modelo por defecto.
 */
export function resolveModel(provider: AiProvider, requested: string | undefined, fallback: string, env: Env = process.env): string {
  if (requested) return requested;
  return (provider === 'foundry' ? env.ANTHROPIC_FOUNDRY_MODEL : undefined) || fallback;
}

/**
 * Crea el cliente de la plataforma. Foundry lee `ANTHROPIC_FOUNDRY_API_KEY` y
 * `ANTHROPIC_FOUNDRY_BASE_URL` (o `ANTHROPIC_FOUNDRY_RESOURCE`); el SDK se carga bajo demanda para que
 * quien solo usa la API de Anthropic no lo necesite.
 */
export async function createAiClient(provider: AiProvider): Promise<Anthropic> {
  if (provider === 'anthropic') return new Anthropic();
  const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk');
  return new AnthropicFoundry() as unknown as Anthropic;
}

/** Mensaje de credenciales ausentes/inválidas según la plataforma. */
export function credentialsHint(provider: AiProvider): string {
  return provider === 'foundry'
    ? 'Credenciales inválidas o ausentes. Defina ANTHROPIC_FOUNDRY_API_KEY y ANTHROPIC_FOUNDRY_BASE_URL (o ANTHROPIC_FOUNDRY_RESOURCE).'
    : 'Credenciales inválidas o ausentes. Defina ANTHROPIC_API_KEY o inicie sesión con `ant auth login`.';
}
