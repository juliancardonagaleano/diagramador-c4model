import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { autoLayoutDocument } from '../layout/elkLayout';
import { formatIssues } from '../model/schema';
import type { C4Document, LayoutDensity, LayoutDirection } from '../model/types';
import { generatedDocumentSchema, generatedToDocument, type GeneratedDocument } from './generationSchema';
import { retryPrompt, systemPrompt, userPrompt } from './prompt';

export const DEFAULT_AI_MODEL = 'claude-opus-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateOptions {
  /** Descripción en lenguaje natural del sistema (o instrucción de refinamiento si hay `base`). */
  instruction: string;
  /** Documento existente a refinar. */
  base?: C4Document;
  /** Cliente de Anthropic (inyectable para pruebas). Por defecto `new Anthropic()`. */
  client?: Anthropic;
  model?: string;
  effort?: Effort;
  /** Reintentos si el modelo devuelve un documento inválido. */
  maxRetries?: number;
  /** Dirección del autolayout. */
  direction?: LayoutDirection;
  /** Densidad del autolayout. */
  density?: LayoutDensity;
  /** Desactivar el autolayout posterior (devuelve el modelo sin coordenadas). */
  skipLayout?: boolean;
  onProgress?: (message: string) => void;
}

export interface GenerateResult {
  document: C4Document;
  model: string;
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

/**
 * Genera (o refina) un documento C4 a partir de una instrucción usando Claude con
 * salida estructurada, valida el resultado y aplica autolayout.
 */
export async function generateDocument(options: GenerateOptions): Promise<GenerateResult> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_AI_MODEL;
  const maxRetries = options.maxRetries ?? 1;
  const progress = options.onProgress ?? (() => {});

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: userPrompt(options.instruction, options.base) },
  ];

  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastIssues = '';

  while (attempts <= maxRetries) {
    attempts += 1;
    progress(attempts === 1 ? `Consultando a ${model}…` : `Reintento ${attempts - 1}: corrigiendo el modelo…`);

    let generated: GeneratedDocument | null;
    let servedModel = model;
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(),
        messages,
        output_config: {
          format: betaZodOutputFormat(generatedDocumentSchema),
          ...(options.effort ? { effort: options.effort } : {}),
        },
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      servedModel = response.model;
      if (response.stop_reason === 'refusal') {
        throw new GenerationError('El modelo rechazó la solicitud (stop_reason: refusal).');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new GenerationError('La respuesta excedió max_tokens; simplifique la descripción o divida el sistema.');
      }
      generated = response.parsed_output;
      if (!generated) throw new GenerationError('La respuesta del modelo no pudo interpretarse como JSON válido.');
      messages.push({ role: 'assistant', content: response.content.filter((b) => b.type === 'text' || b.type === 'thinking') });
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(describeApiError(error), error);
    }

    const result = generatedToDocument(generated);
    if (result.ok) {
      progress('Modelo válido. Aplicando autolayout…');
      const document = options.skipLayout
        ? result.document
        : await autoLayoutDocument(result.document, { direction: options.direction, density: options.density, force: true });
      return { document, model: servedModel, attempts, usage: { inputTokens, outputTokens } };
    }
    lastIssues = formatIssues(result.issues);
    messages.push({ role: 'user', content: retryPrompt(lastIssues) });
  }

  throw new GenerationError(`El modelo no produjo un documento válido tras ${attempts} intentos:\n${lastIssues}`);
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'Credenciales inválidas o ausentes. Defina ANTHROPIC_API_KEY o inicie sesión con `ant auth login`.';
  }
  if (error instanceof Anthropic.RateLimitError) return 'Límite de tasa alcanzado. Inténtelo de nuevo en unos segundos.';
  if (error instanceof Anthropic.BadRequestError) return `Solicitud rechazada por la API: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `No se pudo conectar con la API: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Error de la API (${error.status}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
