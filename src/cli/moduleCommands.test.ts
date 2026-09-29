import { ModuleRegistry, type DomainModule } from '@iark/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildProgram } from './main';

function fakeModule(run: (ctx: { args: string[]; options: Record<string, unknown> }) => string): DomainModule<{ n: number }> {
  return {
    id: 'demo',
    name: 'Módulo de prueba',
    version: '0.0.1',
    documentVersion: '1.0',
    schema: z.object({ n: z.number() }),
    jsonSchema: () => ({}),
    validate: () => [],
    importers: [],
    exporters: [],
    cliCommands: [
      {
        name: 'saluda',
        description: 'Saluda',
        args: [{ name: 'nombre', description: 'a quién', required: true }],
        options: [{ flags: '--fuerte', description: 'en mayúsculas', default: false }],
        run,
      },
    ],
  };
}

describe('comandos que aportan los módulos', () => {
  afterEach(() => vi.restoreAllMocks());

  it('un módulo registrado cuelga sus comandos de `iark <módulo>` y recibe argumentos y opciones', async () => {
    const seen: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const registry = new ModuleRegistry().register(
      fakeModule((ctx) => {
        seen.push(ctx);
        return ctx.options.fuerte ? ctx.args[0].toUpperCase() : `hola ${ctx.args[0]}`;
      }),
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (out.push(String(chunk)), true)) as never);

    await buildProgram(registry).parseAsync(['node', 'iark', 'demo', 'saluda', 'Ana']);
    await buildProgram(registry).parseAsync(['node', 'iark', 'demo', 'saluda', 'Ana', '--fuerte']);

    expect(out.join('')).toBe('hola Ana\nANA\n');
    expect(seen[0].args).toEqual(['Ana']);
    expect(seen[1].options.fuerte).toBe(true);
  });
});
