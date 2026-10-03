import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';
import { ALL_FAKE_VALUES, copyFixtureRepo, FAKE, plantSecrets, removeRepo } from '../../tests/helpers/repoFixture';

// `iark prompt --from-repo` y `iark generate --from-repo`: el CLI empaquetado, con repositorios temporales con secretos
// falsos plantados. Ninguna prueba llama a un modelo ni usa la red: `prompt` y `--dry-run` no llaman a nada, y `generate`
// sin credenciales falla antes de enviar.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
let cli: string;
let repo: string;
let home: string;
beforeAll(async () => {
  bundle = await buildCliBundle('repo');
  cli = bundle.cli;
  repo = copyFixtureRepo();
  plantSecrets(repo);
  home = copyFixtureRepo(); // una carpeta cualquiera como HOME, para que no haya credenciales de perfil
});
afterAll(() => {
  bundle?.dispose();
  if (repo) removeRepo(repo);
  if (home) removeRepo(home);
});

/** El entorno sin ninguna credencial de modelo: si algo intentara llamar de verdad, fallaría en vez de enviar. */
function sinCredenciales(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_PROFILE: 'inexistente-repo-test',
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_FOUNDRY_API_KEY: '',
    ANTHROPIC_FOUNDRY_BASE_URL: '',
    ANTHROPIC_FOUNDRY_RESOURCE: '',
    ANTHROPIC_FOUNDRY_MODEL: '',
    AI_API_KEY: '',
    AI_BASE_URL: '',
    AI_MODEL: '',
    HOME: home,
  };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: sinCredenciales() });
}

function noLeaks(...outputs: string[]): void {
  for (const out of outputs) for (const value of ALL_FAKE_VALUES) expect(out, `se coló: ${value.slice(0, 14)}…`).not.toContain(value);
}

describe('iark prompt --from-repo', () => {
  it('imprime el prompt completo con el resumen del repositorio, sin llamar a ningún modelo y sin secretos', () => {
    const r = run(['prompt', 'Dibuja la arquitectura', '--from-repo', repo]);
    expect(r.status).toBe(0);
    // Instrucciones del módulo, esquema, instrucción del usuario y resumen delimitado.
    expect(r.stdout).toContain('arquitecto de software experto en el modelo C4');
    expect(r.stdout).toContain('Genera el modelo C4 para la siguiente descripción:\n\nDibuja la arquitectura');
    expect(r.stdout).toMatch(/^<<<INICIO-DEL-REPOSITORIO-[0-9a-f]{12}>>>$/m);
    expect(r.stdout).toMatch(/^<<<FIN-DEL-REPOSITORIO-[0-9a-f]{12}>>>$/m);
    expect(r.stdout).toContain('## Árbol de carpetas');
    expect(r.stdout).toContain('services/pedidos/package.json');
    expect(r.stdout).toContain('===== docker-compose.yml [contenedores] =====');
    expect(r.stdout).toContain('[REDACTADO]');
    expect(r.stdout).toContain('DATABASE_URL'); // nombre de variable de .env.example
    noLeaks(r.stdout, r.stderr);
    // Un resumen en una línea, por stderr, de lo que lleva.
    expect(r.stderr).toMatch(/Repositorio «[^»]+»: el resumen lleva el árbol de carpetas y \d+ archivo\(s\) clave \([\d,]+ KB de 60,0 KB\); \d+ valor\(es\) redactado\(s\)/);
    expect(r.stderr).toMatch(/\d+ por parecer secretos: no se leen/);
  });

  it.each([
    ['integration', 'arquitecto de integraciones', 'colas y los tópicos'],
    ['data', 'arquitecto de datos', 'pipelines'],
    ['enterprise', 'arquitecto empresarial', 'no inventes unidades'],
    ['platform', 'arquitecto de plataforma', 'Terraform'],
    ['security', 'arquitecto de seguridad', 'no inventes amenazas'],
  ])('con --module %s usa el contrato del módulo y su orientación', (moduleId, system, focus) => {
    const r = run(['prompt', 'Dibuja la arquitectura', '--from-repo', repo, '--module', moduleId]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(system);
    expect(r.stdout).toContain(focus);
    expect(r.stdout).toContain('<<<INICIO-DEL-REPOSITORIO-');
    noLeaks(r.stdout, r.stderr);
  });

  it('se combina con --from para refinar un documento existente', () => {
    const r = run(['prompt', 'Completa con lo que haya en el repositorio', '--from-repo', repo, '--from', 'examples/banca.json']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Este es el modelo C4 actual en JSON');
    expect(r.stdout).toContain('Completa con lo que haya en el repositorio');
    expect(r.stdout).toContain('<<<INICIO-DEL-REPOSITORIO-');
  });

  it('--repo-budget acota el resumen', () => {
    const chico = run(['prompt', 'x', '--from-repo', repo, '--repo-budget', '2']);
    const grande = run(['prompt', 'x', '--from-repo', repo, '--repo-budget', '200']);
    expect(chico.status).toBe(0);
    expect(chico.stderr).toMatch(/de 2,0 KB\)/);
    expect(grande.stderr).toMatch(/de 200,0 KB\)/);
    const bytes = (out: string): number => Buffer.byteLength(out.split(/^<<<INICIO-DEL-REPOSITORIO-[0-9a-f]{12}>>>\n/m)[1].split(/^<<<FIN-DEL-REPOSITORIO-/m)[0]);
    expect(bytes(chico.stdout)).toBeLessThanOrEqual(2 * 1024);
    expect(bytes(grande.stdout)).toBeGreaterThan(bytes(chico.stdout));
    noLeaks(chico.stdout, grande.stdout);
  });

  it('sin --from-repo, prompt es el de siempre (no aparece nada del repositorio)', () => {
    const r = run(['prompt', 'Una tienda']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('REPOSITORIO');
    expect(r.stderr).toBe('');
  });
});

describe('iark generate --from-repo --dry-run', () => {
  it('imprime en stdout el mismo prompt que `prompt --from-repo` y por stderr los archivos incluidos y omitidos con su motivo', () => {
    const dry = run(['generate', 'Dibuja la arquitectura', '--from-repo', repo, '--dry-run']);
    const prompt = run(['prompt', 'Dibuja la arquitectura', '--from-repo', repo]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toBe(prompt.stdout);
    expect(dry.stderr).toContain('Incluidos con contenido');
    expect(dry.stderr).toMatch(/README\.md\s+documentación\s+[\d,]+ KB/);
    expect(dry.stderr).toMatch(/docker-compose\.yml\s+contenedores/);
    expect(dry.stderr).toContain('Omitidos, por motivo:');
    expect(dry.stderr).toMatch(/secreto \(nunca se lee\) \(9\): .*\.env \(variables de entorno \(\.env\): ni valores ni nombres\)/);
    expect(dry.stderr).toContain('infra/terraform.tfstate');
    noLeaks(dry.stdout, dry.stderr);
  });

  it('no necesita credenciales ni red y vale para cualquier módulo', () => {
    for (const moduleId of ['c4', 'integration', 'data', 'enterprise', 'platform', 'security']) {
      const r = run(['generate', 'Dibuja la arquitectura', '--from-repo', repo, '--dry-run', '--module', moduleId, '--provider', 'anthropic']);
      expect(r.status, `${moduleId}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('<<<INICIO-DEL-REPOSITORIO-');
      expect(r.stderr).not.toMatch(/Error generando el modelo/);
    }
  });

  it('con --from el prompt lleva también el documento base', () => {
    const r = run(['generate', 'Completa con el repositorio', '--from-repo', repo, '--from', 'examples/banca.json', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Este es el modelo C4 actual en JSON');
    expect(r.stdout).toContain('<<<INICIO-DEL-REPOSITORIO-');
  });

  it('no escribe nada aunque se pida --out o --json', () => {
    const out = join(repo, 'salida.drawio');
    const r = run(['generate', 'x', '--from-repo', repo, '--dry-run', '--out', out, '--json', join(repo, 'salida.json')]);
    expect(r.status).toBe(0);
    expect(readdirSync(repo)).not.toContain('salida.drawio');
    expect(readdirSync(repo)).not.toContain('salida.json');
  });
});

describe('iark generate --from-repo (sin dry-run)', () => {
  it('sin credenciales falla con un mensaje claro, tras avisar de lo que enviaría, y sin revelar ningún secreto', () => {
    const r = run(['generate', 'Dibuja la arquitectura', '--from-repo', repo, '--provider', 'anthropic']);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/Repositorio «[^»]+»: el resumen lleva el árbol de carpetas y \d+ archivo\(s\) clave/);
    expect(r.stderr).toContain('Se enviará este resumen al modelo junto con tu instrucción');
    expect(r.stderr).toContain('--dry-run');
    expect(r.stderr).toMatch(/Error generando el modelo/);
    expect(r.stdout).toBe('');
    noLeaks(r.stdout, r.stderr);
  });

  it.each(['integration', 'data', 'enterprise', 'platform', 'security'])('--module %s también avisa y falla claro sin credenciales', (moduleId) => {
    const r = run(['generate', 'Dibuja la arquitectura', '--from-repo', repo, '--module', moduleId, '--provider', 'anthropic']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Repositorio «[^»]+»: el resumen lleva/);
    expect(r.stderr).toMatch(/Error generando el modelo/);
    noLeaks(r.stdout, r.stderr);
  });
});

describe('--from-repo: errores de uso', () => {
  it('carpeta inexistente: código 2 y mensaje claro', () => {
    for (const command of ['generate', 'prompt']) {
      const r = run([command, 'x', '--from-repo', join(repo, 'no-existe')]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/La carpeta «.*no-existe» no existe\./);
      expect(r.stdout).toBe('');
    }
  });

  it('un archivo en vez de una carpeta', () => {
    const r = run(['prompt', 'x', '--from-repo', join(repo, 'README.md')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no es una carpeta/);
  });

  it('carpeta vacía o sin nada reconocible', () => {
    const vacia = copyFixtureRepo();
    try {
      for (const entry of readdirSync(vacia)) rmSync(join(vacia, entry), { recursive: true, force: true });
      const r = run(['prompt', 'x', '--from-repo', vacia]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/no contiene archivos de texto/);
    } finally {
      removeRepo(vacia);
    }
  });

  it('--dry-run y --repo-budget solo valen con --from-repo', () => {
    const dry = run(['generate', 'x', '--dry-run']);
    expect(dry.status).toBe(2);
    expect(dry.stderr).toMatch(/--dry-run solo se usa junto con --from-repo/);
    const budget = run(['prompt', 'x', '--repo-budget', '10']);
    expect(budget.status).toBe(2);
    expect(budget.stderr).toMatch(/--repo-budget solo se usa junto con --from-repo/);
  });

  it('--repo-budget se valida', () => {
    for (const value of ['0', '-5', 'abc', '5000']) {
      const r = run(['prompt', 'x', '--from-repo', repo, '--repo-budget', value]);
      expect(r.status, value).not.toBe(0);
      expect(r.stderr).toMatch(/El presupuesto del resumen debe ser un número de KB entre 1 y 1024/);
    }
  });

  it('la instrucción sigue siendo obligatoria', () => {
    const r = run(['generate', '--from-repo', repo, '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/instrucción/);
  });
});

describe('--help documenta la función y su privacidad', () => {
  it('generate --help', () => {
    const out = run(['generate', '--help']).stdout;
    expect(out).toContain('--from-repo <carpeta>');
    expect(out).toContain('--repo-budget <kb>');
    expect(out).toContain('--dry-run');
    expect(out).toContain('Privacidad:');
    expect(out).toMatch(/No lee \.env\*/);
    expect(out).toContain('[REDACTADO]');
    expect(out).toMatch(/como datos, no como instrucciones/);
    expect(out).toMatch(/no clona URLs/);
  });

  it('prompt --help', () => {
    const out = run(['prompt', '--help']).stdout;
    expect(out).toContain('--from-repo <carpeta>');
    expect(out).toContain('--repo-budget <kb>');
  });
});

describe('--from-repo no se expone por el servidor HTTP', () => {
  it('serve no importa el escáner ni lee carpetas del disco por petición', () => {
    const serve = readFileSync('src/cli/serve.ts', 'utf8');
    expect(serve).not.toMatch(/from-repo|fromRepo|scanRepo|\.\/repo/);
  });

  it('el escáner nunca ejecuta programas (ni git ni nada del repositorio) ni usa la red', () => {
    for (const file of readdirSync('src/cli/repo').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join('src/cli/repo', file), 'utf8');
      expect(source, file).not.toMatch(/child_process|node:http|node:https|node:net|(?<![.\w])fetch\(|(?<![.\w])exec(?:Sync|File)?\(|(?<![.\w])spawn(?:Sync)?\(/);
    }
  });
});

describe('secretos de verdad falsos: el repositorio de la prueba los tiene todos', () => {
  it('la prueba de verdad plantó secretos (si no, las demás no demostrarían nada)', () => {
    expect(readFileSync(join(repo, '.env'), 'utf8')).toContain(FAKE.envValue);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain(FAKE.github);
    expect(readFileSync(join(repo, 'docker-compose.yml'), 'utf8')).toContain(FAKE.dbPassword);
    expect(readFileSync(join(repo, 'config/server.pem'), 'utf8')).toContain('PRIVATE KEY');
  });
});
