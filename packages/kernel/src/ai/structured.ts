import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AiSpec } from '../module/types';
import { extractJson } from '../util/extractJson';
import { createAiClient, credentialsHint, openaiSettings, resolveModel, resolveProvider, type AiProvider } from './client';
import { chatCompletion, HttpError, initialCompatState, type ChatMessage } from './openaiCompat';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StructuredOptions<TDoc> {
  /** Descripción en lenguaje natural del sistema (o instrucción de refinamiento si hay `base`). */
  instruction: string;
  /** Documento existente a refinar. */
  base?: TDoc;
  /** Modelo por defecto si no se indica otro (ni hay variable de entorno). */
  defaultModel: string;
  /** Cliente de Anthropic (inyectable para pruebas). Por defecto se crea según `provider`. */
  client?: Anthropic;
  /** Plataforma: `anthropic`, `foundry` (Claude), `openai` (cualquier modelo de Foundry) o `auto` (según el entorno). */
  provider?: AiProvider | 'auto';
  /** `fetch` inyectable para pruebas de la plataforma `openai`. */
  fetch?: typeof fetch;
  /** Modelo (en Foundry, el nombre de tu despliegue). */
  model?: string;
  effort?: Effort;
  /** Reintentos si el modelo devuelve un documento inválido. */
  maxRetries?: number;
  onProgress?: (message: string) => void;
}

export interface StructuredResult<TDoc> {
  document: TDoc;
  model: string;
  provider: AiProvider;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export class GenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/** Un turno de la conversación con el modelo: lo generado (o por qué no se pudo leer). */
interface TurnResult {
  generated: unknown | null;
  /** Por qué no hay `generated` (JSON ilegible o que incumple el esquema); se le devuelve al modelo para que lo corrija. */
  problem?: string;
  servedModel: string;
  inputTokens: number;
  outputTokens: number;
}

interface Conversation {
  ask(): Promise<TurnResult>;
  /** Añade un mensaje del usuario (la corrección tras un intento inválido). */
  feedback(text: string): void;
}

/** Conversación con Claude (API de Anthropic o Claude en Foundry) usando salida estructurada. */
function claudeConversation<TDoc>(
  client: Anthropic,
  provider: 'anthropic' | 'foundry',
  model: string,
  spec: AiSpec<TDoc>,
  options: StructuredOptions<TDoc>,
): Conversation {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: spec.user(options.instruction, options.base) }];
  return {
    async ask() {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        // Los fallbacks del servidor solo existen en la API de Anthropic, no en Foundry.
        ...(provider === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const } : {}),
        system: spec.system(),
        messages,
        output_config: {
          format: betaZodOutputFormat(spec.generationSchema as never),
          ...(options.effort ? { effort: options.effort } : {}),
        },
      });
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      if (response.stop_reason === 'refusal') throw new GenerationError('El modelo rechazó la solicitud (stop_reason: refusal).');
      if (response.stop_reason === 'max_tokens') {
        throw new GenerationError('La respuesta excedió max_tokens; simplifique la descripción o divida el sistema.');
      }
      if (!response.parsed_output) throw new GenerationError('La respuesta del modelo no pudo interpretarse como JSON válido.');
      messages.push({ role: 'assistant', content: response.content.filter((b) => b.type === 'text' || b.type === 'thinking') });
      return { generated: response.parsed_output, servedModel: response.model, ...usage };
    },
    feedback: (text) => void messages.push({ role: 'user', content: text }),
  };
}

/**
 * Conversación con cualquier modelo de Foundry (u otro servicio compatible con Chat Completions). No todos los modelos
 * garantizan el esquema, así que el JSON Schema va también en el prompt y la respuesta se valida aquí con zod.
 */
function openaiConversation<TDoc>(model: string, spec: AiSpec<TDoc>, options: StructuredOptions<TDoc>): Conversation {
  const { baseURL, apiKey } = openaiSettings();
  if (!baseURL || !apiKey) throw new GenerationError(credentialsHint('openai'));
  const schema = spec.generationJsonSchema();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${spec.system()}\n\nResponde ÚNICAMENTE con un objeto JSON (sin comentarios ni texto adicional) que cumpla este JSON Schema; ` +
        `usa null en los campos opcionales sin valor:\n${JSON.stringify(schema)}`,
    },
    { role: 'user', content: spec.user(options.instruction, options.base) },
  ];
  const state = initialCompatState();
  return {
    async ask() {
      const result = await chatCompletion({ baseURL, apiKey, model, messages, jsonSchema: schema as Record<string, unknown>, maxTokens: 16000, state, fetch: options.fetch });
      if (result.finishReason === 'length') {
        throw new GenerationError('La respuesta excedió el límite de tokens; simplifique la descripción o divida el sistema.');
      }
      messages.push({ role: 'assistant', content: result.text });
      const usage = { servedModel: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      let json: unknown;
      try {
        json = JSON.parse(extractJson(result.text));
      } catch {
        return { generated: null, problem: 'La respuesta no es un JSON válido. Devuelve solo el objeto JSON.', ...usage };
      }
      const parsed = spec.generationSchema.safeParse(json);
      if (!parsed.success) {
        return { generated: null, problem: parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n'), ...usage };
      }
      return { generated: parsed.data, ...usage };
    },
    feedback: (text) => void messages.push({ role: 'user', content: text }),
  };
}

/**
 * Genera (o refina) un documento de cualquier módulo a partir de una instrucción, con Claude (salida estructurada) o
 * con cualquier modelo de Foundry (JSON validado aquí). El módulo aporta el esquema, los prompts y la conversión
 * a documento (`AiSpec`); aquí se gestionan el proveedor, los reintentos y el uso de tokens.
 */
export async function generateStructured<TDoc>(spec: AiSpec<TDoc>, options: StructuredOptions<TDoc>): Promise<StructuredResult<TDoc>> {
  // Un cliente de Anthropic inyectado implica el protocolo de Anthropic, sea cual sea el entorno.
  const provider = resolveProvider(options.provider ?? (options.client ? 'anthropic' : undefined));
  const model = resolveModel(provider, options.model, options.defaultModel);
  const maxRetries = options.maxRetries ?? 1;
  const progress = options.onProgress ?? (() => {});

  let conversation: Conversation;
  try {
    conversation =
      provider === 'openai'
        ? openaiConversation(model, spec, options)
        : claudeConversation(options.client ?? (await createAiClient(provider)), provider, model, spec, options);
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError(describeApiError(error, provider), error);
  }

  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastIssues = '';
  let servedModel = model;

  while (attempts <= maxRetries) {
    attempts += 1;
    progress(attempts === 1 ? `Consultando a ${model}…` : `Reintento ${attempts - 1}: corrigiendo el modelo…`);

    let turn: TurnResult;
    try {
      turn = await conversation.ask();
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(describeApiError(error, provider), error);
    }
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    servedModel = turn.servedModel;

    if (!turn.generated) {
      lastIssues = turn.problem ?? 'La respuesta del modelo no pudo interpretarse.';
      conversation.feedback(spec.retry(lastIssues));
      continue;
    }
    const result = spec.toDocument(turn.generated);
    if (result.ok) {
      progress('Modelo válido.');
      return { document: result.document, model: servedModel, provider, attempts, usage: { inputTokens, outputTokens } };
    }
    lastIssues = result.issues;
    conversation.feedback(spec.retry(lastIssues));
  }

  throw new GenerationError(`El modelo no produjo un documento válido tras ${attempts} intentos:\n${lastIssues}`);
}

function describeApiError(error: unknown, provider: AiProvider): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return credentialsHint(provider);
    if (error.status === 429) return 'Límite de tasa alcanzado. Inténtelo de nuevo en unos segundos.';
    return `Error de la API (${error.status}): ${error.body.slice(0, 300)}`;
  }
  if (provider === 'openai' && error instanceof Error && error.name !== 'Error') return `No se pudo conectar con la API: ${error.message}`;
  if (error instanceof Anthropic.AuthenticationError) {
    return credentialsHint(provider);
  }
  if (error instanceof Anthropic.RateLimitError) return 'Límite de tasa alcanzado. Inténtelo de nuevo en unos segundos.';
  if (error instanceof Anthropic.BadRequestError) return `Solicitud rechazada por la API: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `No se pudo conectar con la API: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Error de la API (${error.status}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
