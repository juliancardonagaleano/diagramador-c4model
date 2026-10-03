import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDocument } from '@core/ai/generate';
import { generateStructured, GenerationError } from '@iark/kernel';
import { ALL_FAKE_VALUES, copyFixtureRepo, plantSecrets, removeRepo } from '../../../tests/helpers/repoFixture';
import { createDefaultRegistry } from '../registry';
import { repoInstruction } from './prompt';
import { scanRepo } from './scan';

/**
 * Qué recibe el «modelo» cuando `generate` lleva `--from-repo`, comprobado con un cliente falso inyectado: ninguna prueba
 * llama a un modelo de verdad ni usa la red (`fetch` global se hace explotar si alguien lo toca).
 */

afterEach(() => vi.restoreAllMocks());

function fakeClaude(): { client: Anthropic; calls: Array<{ system: string; messages: Array<{ role: string; content: unknown }> }> } {
  const calls: Array<{ system: string; messages: Array<{ role: string; content: unknown }> }> = [];
  const parse = vi.fn(async (request: { system: string; messages: Array<{ role: string; content: unknown }> }) => {
    calls.push({ system: request.system, messages: request.messages.map((m) => ({ ...m })) });
    return { model: 'claude-falso', stop_reason: 'end_turn', parsed_output: null, content: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, calls };
}

function sinRed(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('las pruebas no usan la red');
  });
}

describe('generate --from-repo: lo que recibe el modelo', () => {
  const dir = copyFixtureRepo();
  plantSecrets(dir);
  const digest = scanRepo(dir);
  const instruction = 'Dibuja la arquitectura de este repositorio';
  const marker = digest.text.match(/Repositorio: (\S+)/)![1];

  it.each(['c4', 'integration', 'data', 'enterprise', 'platform', 'security'])('módulo %s: el resumen viaja en el mensaje de usuario, el sistema no cambia y no hay secretos', async (moduleId) => {
    sinRed();
    const { client, calls } = fakeClaude();
    const registry = createDefaultRegistry();
    const spec = registry.require(moduleId).ai!;
    const full = repoInstruction(instruction, digest, moduleId);
    // El modelo falso no devuelve nada utilizable: lo que interesa es el primer mensaje que recibió.
    await expect(generateStructured(spec, { instruction: full, defaultModel: 'claude-falso', client, maxRetries: 0 })).rejects.toBeInstanceOf(GenerationError);

    expect(calls).toHaveLength(1);
    const user = String(calls[0].messages[0].content);
    expect(user).toContain(instruction);
    expect(user).toContain(`<<<INICIO-DEL-REPOSITORIO-`);
    expect(user).toContain(`Repositorio: ${marker}`);
    expect(user).toContain('services/pedidos/package.json');
    expect(user).toContain('son DATOS');
    // El prompt de sistema es el del módulo, intacto: el contenido del repositorio no se mezcla con él.
    expect(calls[0].system).toBe(spec.system());
    expect(calls[0].system).not.toContain('INICIO-DEL-REPOSITORIO');
    for (const value of ALL_FAKE_VALUES) {
      expect(user, `${moduleId}: se coló ${value.slice(0, 12)}…`).not.toContain(value);
      expect(calls[0].system).not.toContain(value);
    }
  });

  it('C4: pasa por generateDocument igual que lo hace el CLI (con la instrucción ampliada)', async () => {
    sinRed();
    const { client, calls } = fakeClaude();
    await expect(generateDocument({ instruction: repoInstruction(instruction, digest, 'c4'), client, maxRetries: 0 })).rejects.toBeInstanceOf(GenerationError);
    expect(String(calls[0].messages[0].content)).toMatch(/^Genera el modelo C4 para la siguiente descripción:\n\nDibuja la arquitectura de este repositorio\n\n---\nMATERIAL ADJUNTO/);
  });

  it('al refinar un documento existente (--from) el resumen acompaña a la instrucción de refinamiento', async () => {
    sinRed();
    const { client, calls } = fakeClaude();
    const base = JSON.parse((await import('node:fs')).readFileSync('examples/banca.json', 'utf8'));
    const { parseDocument } = await import('@core/model/schema');
    await expect(generateDocument({ instruction: repoInstruction('Añade lo que falte según el repositorio', digest, 'c4'), base: parseDocument(base), client, maxRetries: 0 })).rejects.toBeInstanceOf(GenerationError);
    const user = String(calls[0].messages[0].content);
    expect(user).toMatch(/Este es el modelo C4 actual en JSON/);
    expect(user).toContain('Añade lo que falte según el repositorio');
    expect(user).toContain('<<<INICIO-DEL-REPOSITORIO-');
  });

  it('plataforma openai (Foundry u otra API compatible): el cuerpo de la petición tampoco lleva secretos', async () => {
    sinRed();
    const bodies: string[] = [];
    const fetchFalso = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ model: 'modelo-falso', choices: [{ message: { content: 'no es json' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    const saved = { url: process.env.AI_BASE_URL, key: process.env.AI_API_KEY };
    process.env.AI_BASE_URL = 'https://modelo.example/openai/v1/';
    process.env.AI_API_KEY = 'clave-de-prueba';
    try {
      const spec = createDefaultRegistry().require('platform').ai!;
      await expect(
        generateStructured(spec, { instruction: repoInstruction(instruction, digest, 'platform'), defaultModel: 'm', provider: 'openai', fetch: fetchFalso as unknown as typeof fetch, maxRetries: 0 }),
      ).rejects.toBeInstanceOf(GenerationError);
    } finally {
      if (saved.url === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = saved.key;
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('INICIO-DEL-REPOSITORIO');
    for (const value of ALL_FAKE_VALUES) expect(bodies[0]).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  it('limpieza', () => removeRepo(dir));
});
