import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

const cli = ['node_modules/.bin/tsx', 'src/cli/index.ts'];
const example = 'examples/banca.json';

function run(args: string[], input?: string) {
  return spawnSync(cli[0], [cli[1], ...args], { input, encoding: 'utf8' });
}

describe('c4diagram (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c4cli-'));

  it('layout escribe coordenadas en todas las vistas', () => {
    const out = join(dir, 'laid.json');
    const r = run(['layout', example, '--out', out, '--direction', 'right']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    for (const v of doc.views) for (const e of v.elements) expect(typeof e.x).toBe('number');
  });

  it('convert produce un .drawio válido con una página por vista (desde stdin, con bloque de código)', () => {
    const input = '```json\n' + readFileSync(example, 'utf8') + '\n```';
    const r = run(['convert', '--stdin', '--locale', 'en'], input);
    expect(r.status).toBe(0);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(r.stdout);
    expect([].concat(parsed.mxfile.diagram)).toHaveLength(3);
    expect(r.stdout).toContain('System Scope Boundary');
  });

  it('validate devuelve código 2 con un documento inválido y 0 con uno válido', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ model: { elements: [{ id: 'a', type: 'component', name: 'A' }], relationships: [{ id: 'r', sourceId: 'a', targetId: 'b' }] } }));
    const r = run(['validate', bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/destino inexistente/);
    const ok = run(['validate', example]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido/);
  });

  it('schema, prompt y example imprimen contenido útil', () => {
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'schema'], { encoding: 'utf8' })).type).toBe('object');
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'schema', '--generation'], { encoding: 'utf8' })).properties.views).toBeDefined();
    const prompt = execFileSync(cli[0], [cli[1], 'prompt', 'Un sistema de reservas', '--from', example], { encoding: 'utf8' });
    expect(prompt).toContain('Un sistema de reservas');
    expect(prompt).toContain('"cliente"');
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'example'], { encoding: 'utf8' })).views).toHaveLength(3);
  });

  it('generate falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(cli[0], [cli[1], 'generate', 'Una tienda'], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_PROFILE: 'inexistente-c4-test', HOME: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});
