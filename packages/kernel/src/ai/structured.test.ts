import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AiSpec } from '../module/types';
import { standalonePrompt } from './standalone';
import { generateStructured, GenerationError } from './structured';

interface Doc {
  nombre: string;
}

const schema = z.object({ nombre: z.string() });

const spec: AiSpec<Doc> = {
  generationSchema: schema,
  generationJsonSchema: () => ({ type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] }),
  system: () => 'Eres un generador de pruebas.',
  user: (instruction, base) => `Instrucción: ${instruction}${base ? `\nBase: ${base.nombre}` : ''}`,
  retry: (issues) => `Corrige: ${issues}`,
  toDocument(generated) {
    const g = generated as Doc;
    return g.nombre.trim() ? { ok: true, document: { nombre: g.nombre.trim() } } : { ok: false, issues: 'nombre vacío' };
  },
};

const env = { AI_BASE_URL: 'https://r.openai.azure.com/openai/v1/', AI_API_KEY: 'k' };
const reply = (content: string, finish = 'stop') =>
  new Response(JSON.stringify({ model: 'modelo-x', choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 7 } }), { status: 200 });

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('generateStructured (proveedor openai)', () => {
  it('genera un documento y suma el uso de tokens', async () => {
    const fetchMock = vi.fn(async () => reply('```json\n{"nombre":" Hola "}\n```'));
    const result = await withEnv(() => generateStructured(spec, { instruction: 'crea algo', defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(result.document).toEqual({ nombre: 'Hola' });
    expect(result).toMatchObject({ provider: 'openai', attempts: 1, model: 'modelo-x', usage: { inputTokens: 5, outputTokens: 7 } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('Eres un generador de pruebas.');
    expect(body.messages[0].content).toContain('"nombre"');
    expect(body.messages[1].content).toBe('Instrucción: crea algo');
  });

  it('al refinar conserva los ref (enlaces entre módulos) del documento base que el modelo no conoce', async () => {
    interface Linked {
      items: Array<{ id: string; ref?: string }>;
    }
    const linkedSpec: AiSpec<Linked> = {
      ...(spec as unknown as AiSpec<Linked>),
      generationSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
      toDocument: (generated) => ({ ok: true, document: generated as Linked }),
    };
    const base: Linked = { items: [{ id: 'a', ref: 'urn:iark:integration:a' }, { id: 'b' }] };
    const fetchMock = vi.fn(async () => reply('{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}'));
    const refined = await withEnv(() => generateStructured(linkedSpec, { instruction: 'añade c', base, defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(refined.document.items).toEqual([{ id: 'a', ref: 'urn:iark:integration:a' }, { id: 'b' }, { id: 'c' }]);
    const fresh = await withEnv(() => generateStructured(linkedSpec, { instruction: 'crea', defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(fresh.document.items).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('al refinar aplica el gancho carry del módulo con el documento base, y no al generar desde cero', async () => {
    interface Texts {
      items: Array<{ id: string; text?: string }>;
    }
    const carry = vi.fn((base: Texts, generated: Texts): Texts => ({ items: generated.items.map((i) => ({ ...i, text: base.items.find((b) => b.id === i.id)?.text })) }));
    const textSpec: AiSpec<Texts> = {
      ...(spec as unknown as AiSpec<Texts>),
      generationSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
      toDocument: (generated) => ({ ok: true, document: generated as Texts }),
      carry,
    };
    const base: Texts = { items: [{ id: 'a', text: 'contenido largo' }] };
    const fetchMock = vi.fn(async () => reply('{"items":[{"id":"a"},{"id":"b"}]}'));
    const refined = await withEnv(() => generateStructured(textSpec, { instruction: 'añade b', base, defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(refined.document.items).toEqual([{ id: 'a', text: 'contenido largo' }, { id: 'b', text: undefined }]);
    expect(carry).toHaveBeenCalledTimes(1);
    await withEnv(() => generateStructured(textSpec, { instruction: 'crea', defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(carry).toHaveBeenCalledTimes(1);
  });

  it('reintenta con la corrección cuando el JSON no cumple el esquema o el módulo rechaza el documento', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('no es json'))
      .mockResolvedValueOnce(reply('{"otro":1}'))
      .mockResolvedValueOnce(reply('{"nombre":"  "}'))
      .mockResolvedValueOnce(reply('{"nombre":"ok"}'));
    const progress: string[] = [];
    const result = await withEnv(() =>
      generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai', maxRetries: 3, fetch: fetchMock as unknown as typeof fetch, onProgress: (m) => progress.push(m) }),
    );
    expect(result.attempts).toBe(4);
    expect(result.document.nombre).toBe('ok');
    expect(result.usage.inputTokens).toBe(20);
    const lastBody = JSON.parse((fetchMock.mock.calls[3] as unknown as [string, RequestInit])[1].body as string);
    expect(lastBody.messages.some((m: { content: string }) => m.content === 'Corrige: nombre vacío')).toBe(true);
    expect(progress.at(-1)).toBe('Modelo válido.');
  });

  it('falla con los motivos del último intento cuando se agotan los reintentos', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre":""}'));
    await expect(
      withEnv(() => generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai', maxRetries: 1, fetch: fetchMock as unknown as typeof fetch })),
    ).rejects.toThrow(/tras 2 intentos:\nnombre vacío/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('avisa si la respuesta se corta por límite de tokens y si faltan credenciales', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre"', 'length'));
    await expect(withEnv(() => generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }))).rejects.toThrow(/límite de tokens/);

    const saved = { url: process.env.AI_BASE_URL, key: process.env.AI_API_KEY, fUrl: process.env.ANTHROPIC_FOUNDRY_BASE_URL, fKey: process.env.ANTHROPIC_FOUNDRY_API_KEY };
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    try {
      const error = await generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as Error).message).toMatch(/AI_API_KEY/);
    } finally {
      if (saved.url !== undefined) process.env.AI_BASE_URL = saved.url;
      if (saved.key !== undefined) process.env.AI_API_KEY = saved.key;
      if (saved.fUrl !== undefined) process.env.ANTHROPIC_FOUNDRY_BASE_URL = saved.fUrl;
      if (saved.fKey !== undefined) process.env.ANTHROPIC_FOUNDRY_API_KEY = saved.fKey;
    }
  });
});

describe('standalonePrompt', () => {
  it('reúne sistema, esquema JSON e instrucción (con el documento base al refinar)', () => {
    const prompt = standalonePrompt(spec, 'añade algo', { nombre: 'Base' });
    expect(prompt).toContain('Eres un generador de pruebas.');
    expect(prompt).toContain('ÚNICAMENTE con un objeto JSON');
    expect(prompt).toContain('"required": [');
    expect(prompt).toContain('Instrucción: añade algo\nBase: Base');
  });
});
