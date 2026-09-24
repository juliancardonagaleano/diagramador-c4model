import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { generateDocument, GenerationError } from './generate';
import type { GeneratedDocument } from './generationSchema';
import { standalonePrompt } from './prompt';

const good: GeneratedDocument = {
  workspace: { name: 'Tienda', description: null },
  elements: [
    { id: 'cliente', type: 'person', name: 'Cliente', description: 'Compra', technology: null, external: false, parentId: null, shape: null },
    { id: 'tienda', type: 'softwareSystem', name: 'Tienda en línea', description: 'Vende', technology: null, external: false, parentId: null, shape: null },
    { id: 'web', type: 'container', name: 'Web', description: null, technology: 'React', external: false, parentId: 'tienda', shape: 'browser' },
    { id: 'api', type: 'container', name: 'API', description: null, technology: 'Node.js', external: false, parentId: 'tienda', shape: null },
    { id: 'db', type: 'container', name: 'BD', description: null, technology: 'PostgreSQL', external: false, parentId: 'tienda', shape: 'database' },
    { id: 'pagos', type: 'softwareSystem', name: 'Pasarela de pagos', description: null, technology: null, external: true, parentId: null, shape: null },
  ],
  relationships: [
    { id: 'r1', sourceId: 'cliente', targetId: 'web', description: 'Usa', technology: 'HTTPS' },
    { id: 'r2', sourceId: 'web', targetId: 'api', description: 'Llama', technology: 'JSON/HTTPS' },
    { id: 'r3', sourceId: 'api', targetId: 'db', description: 'Lee y escribe', technology: 'SQL' },
    { id: 'r4', sourceId: 'api', targetId: 'pagos', description: 'Cobra con', technology: 'HTTPS' },
  ],
  views: [
    { id: 'ctx', type: 'systemContext', scopeId: 'tienda', title: 'Contexto', elementIds: ['cliente', 'tienda', 'pagos'] },
    { id: 'cont', type: 'container', scopeId: 'tienda', title: 'Contenedores', elementIds: ['cliente', 'web', 'api', 'db', 'pagos', 'tienda'] },
  ],
};

const bad: GeneratedDocument = {
  ...good,
  relationships: [...good.relationships, { id: 'rx', sourceId: 'api', targetId: 'nope', description: null, technology: null }],
};

function fakeClient(outputs: Array<GeneratedDocument | null>, stopReason = 'end_turn'): Anthropic {
  const parse = vi.fn(async () => {
    const parsed = outputs.shift() ?? null;
    return {
      model: 'claude-opus-5',
      stop_reason: stopReason,
      parsed_output: parsed,
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    };
  });
  return { beta: { messages: { parse } } } as unknown as Anthropic;
}

describe('generateDocument', () => {
  it('convierte la salida estructurada en un documento con autolayout', async () => {
    const client = fakeClient([good]);
    const r = await generateDocument({ instruction: 'Una tienda en línea', client });
    expect(r.attempts).toBe(1);
    expect(r.document.model.elements).toHaveLength(6);
    expect(r.document.views).toHaveLength(2);
    // El scope no se incluye como elemento de su propia vista de contenedores.
    const cont = r.document.views.find((v) => v.id === 'cont')!;
    expect(cont.elements.map((e) => e.id)).not.toContain('tienda');
    // Autolayout aplicado
    for (const v of r.document.views) for (const e of v.elements) expect(e.x).toBeTypeOf('number');
    expect(r.usage.inputTokens).toBe(100);
  });

  it('reintenta con los errores de validación y luego acepta', async () => {
    const client = fakeClient([bad, good]);
    const r = await generateDocument({ instruction: 'Una tienda', client, skipLayout: true });
    expect(r.attempts).toBe(2);
    const parse = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondMessages = (parse[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(secondMessages.length).toBeGreaterThanOrEqual(3);
    expect(secondMessages[2].role).toBe('user');
    expect(String(secondMessages[2].content)).toMatch(/destino inexistente/);
  });

  it('falla tras agotar los reintentos', async () => {
    const client = fakeClient([bad, bad]);
    await expect(generateDocument({ instruction: 'x', client, maxRetries: 1 })).rejects.toThrow(GenerationError);
  });

  it('informa de un rechazo', async () => {
    const client = fakeClient([good], 'refusal');
    await expect(generateDocument({ instruction: 'x', client })).rejects.toThrow(/rechazó/);
  });

  it('usa el modelo por defecto y salida estructurada', async () => {
    const client = fakeClient([good]);
    await generateDocument({ instruction: 'x', client, skipLayout: true, effort: 'high' });
    const params = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5');
    expect(params.fallbacks).toBe('default');
    expect((params.output_config as Record<string, unknown>).effort).toBe('high');
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });
});

describe('standalonePrompt', () => {
  it('incluye reglas, esquema e instrucción', () => {
    const p = standalonePrompt('Un sistema de reservas');
    expect(p).toContain('modelo C4');
    expect(p).toContain('"$schema"');
    expect(p).toContain('Un sistema de reservas');
  });
});
