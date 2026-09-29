import { describe, expect, it, vi } from 'vitest';
import { chatCompletion, HttpError, initialCompatState, stripReasoning } from './openaiCompat';

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}
const ok = (content: string, extra: Record<string, unknown> = {}) =>
  reply(200, { model: 'DeepSeek-V4-Pro', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 }, ...extra });

const base = { baseURL: 'https://r.openai.azure.com/openai/v1/', apiKey: 'k', model: 'DeepSeek-V4-Pro', messages: [{ role: 'user' as const, content: 'hola' }] };

describe('chatCompletion', () => {
  it('llama a /chat/completions con las credenciales, el esquema y el límite de tokens', async () => {
    const fetchMock = vi.fn(async () => ok('{"a":1}'));
    const r = await chatCompletion({ ...base, jsonSchema: { type: 'object' }, maxTokens: 1000, state: initialCompatState(), fetch: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://r.openai.azure.com/openai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('k');
    expect(headers.authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('DeepSeek-V4-Pro');
    expect(body.max_tokens).toBe(1000);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(r).toMatchObject({ text: '{"a":1}', inputTokens: 10, outputTokens: 20, finishReason: 'stop' });
  });

  it('degrada json_schema → json_object → sin formato y recuerda lo aprendido', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(400, '{"error":{"message":"response_format json_schema is not supported"}}'))
      .mockResolvedValueOnce(reply(400, '{"error":{"message":"Invalid response_format"}}'))
      .mockResolvedValueOnce(ok('{}'))
      .mockResolvedValueOnce(ok('{}'));
    const state = initialCompatState();
    await chatCompletion({ ...base, jsonSchema: { type: 'object' }, state, fetch: fetchMock as unknown as typeof fetch });
    expect(state.format).toBe('none');
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).not.toHaveProperty('response_format');
    await chatCompletion({ ...base, state, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cambia max_tokens por max_completion_tokens si el modelo lo exige', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."))
      .mockResolvedValueOnce(ok('{}'));
    await chatCompletion({ ...base, maxTokens: 500, state: initialCompatState(), fetch: fetchMock as unknown as typeof fetch });
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('propaga otros errores HTTP con su estado', async () => {
    const fetchMock = vi.fn(async () => reply(401, 'Access denied'));
    await expect(chatCompletion({ ...base, state: initialCompatState(), fetch: fetchMock as unknown as typeof fetch })).rejects.toMatchObject({ status: 401 });
    await expect(chatCompletion({ ...base, state: initialCompatState(), fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('stripReasoning', () => {
  it('quita los bloques <think>', () => {
    expect(stripReasoning('<think>pienso\n…</think>\n{"a":1}')).toBe('{"a":1}');
  });
});
