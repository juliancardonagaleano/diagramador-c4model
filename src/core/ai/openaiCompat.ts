/**
 * Cliente mínimo para endpoints compatibles con la API de Chat Completions de OpenAI, que es lo que expone
 * Microsoft (Azure) Foundry para casi todos sus modelos que no son Claude (DeepSeek, Llama, Mistral, GPT…):
 * `https://<recurso>.openai.azure.com/openai/v1/chat/completions`. Sin dependencias: solo `fetch`.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Cómo se le pide al modelo que devuelva JSON; se degrada solo si el modelo no admite el formato pedido. */
export type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

/** Estado que se conserva entre turnos para no repetir las degradaciones ya descubiertas. */
export interface CompatState {
  format: ResponseFormatMode;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
}

export const initialCompatState = (): CompatState => ({ format: 'json_schema', tokenParam: 'max_tokens' });

export interface ChatCompletionOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  state: CompatState;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }
}

interface ChatResponseBody {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Quita los bloques de razonamiento `<think>…</think>` que emiten algunos modelos (DeepSeek, Qwen…). */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const state = options.state;

  // Como mucho una degradación por cada parámetro que pueda rechazar el modelo.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body: Record<string, unknown> = { model: options.model, messages: options.messages };
    if (options.maxTokens) body[state.tokenParam] = options.maxTokens;
    if (options.jsonSchema && state.format === 'json_schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'c4_model', strict: true, schema: options.jsonSchema } };
    } else if (state.format !== 'none') {
      body.response_format = { type: 'json_object' };
    }

    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Azure acepta `api-key`; otros endpoints compatibles esperan `Authorization: Bearer`.
        'api-key': options.apiKey,
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 400 || response.status === 422) {
        if (/max_tokens|max_completion_tokens/i.test(text) && state.tokenParam === 'max_tokens') {
          state.tokenParam = 'max_completion_tokens';
          continue;
        }
        if (/response_format|json_schema|json_object|structured/i.test(text) && state.format !== 'none') {
          state.format = state.format === 'json_schema' ? 'json_object' : 'none';
          continue;
        }
      }
      throw new HttpError(response.status, text);
    }

    const data = (await response.json()) as ChatResponseBody;
    const choice = data.choices?.[0];
    return {
      text: stripReasoning(choice?.message?.content ?? ''),
      model: data.model ?? options.model,
      finishReason: choice?.finish_reason ?? null,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
  throw new HttpError(400, 'El endpoint rechazó todas las variantes de parámetros probadas (formato de respuesta / límite de tokens).');
}
