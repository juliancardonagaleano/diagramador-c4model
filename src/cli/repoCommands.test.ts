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

describe('--repo-exclude y --repo-include', () => {
  /** El tramo «Archivos clave» del prompt (lo que lleva contenido): sin el árbol ni los componentes. */
  const keyFiles = (out: string): string => out.split('## Archivos clave')[1].split(/^<<<FIN-DEL-REPOSITORIO-/m)[0];
  const keyPaths = (out: string): string[] => [...keyFiles(out).matchAll(/^===== (\S+) \[/gm)].map((m) => m[1]);

  it('--repo-exclude (repetible) quita archivos y carpetas del resumen entero y lo cuenta por stderr', () => {
    const r = run(['prompt', 'Dibuja la arquitectura', '--from-repo', repo, '--repo-exclude', 'docker-compose.yml', '--repo-exclude', 'k8s/', '--repo-exclude', '**/*.controller.ts']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('===== docker-compose.yml');
    expect(r.stdout).not.toContain('k8s/deployment.yaml');
    expect(r.stdout).not.toContain('pedidos.controller.ts');
    expect(keyPaths(r.stdout)).toContain('README.md');
    expect(r.stdout).toContain('Filtros del usuario: 3 entrada(s) excluida(s) con --repo-exclude (no salen ni en el árbol).');
    expect(r.stderr).toMatch(/3 excluida\(s\) por --repo-exclude/);
    noLeaks(r.stdout, r.stderr);
  });

  it('--dry-run lista lo excluido con su motivo y da el mismo prompt que `prompt`', () => {
    const args = ['--from-repo', repo, '--repo-exclude', 'docker-compose.yml', '--repo-exclude', 'services/facturacion/'];
    const dry = run(['generate', 'x', ...args, '--dry-run']);
    const prompt = run(['prompt', 'x', ...args]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toBe(prompt.stdout);
    expect(dry.stderr).toMatch(/excluido por --repo-exclude \(2\): .*docker-compose\.yml.*services\/facturacion\//);
    expect(dry.stderr).not.toMatch(/===== docker-compose/);
    expect(dry.stderr).not.toMatch(/^\s*docker-compose\.yml\s+contenedores/m); // ya no está entre los incluidos
    noLeaks(dry.stdout, dry.stderr);
  });

  it('--repo-include limita el contenido a lo que cuadre; el árbol sigue entero y lo de fuera se lista como omitido', () => {
    const r = run(['generate', 'x', '--from-repo', repo, '--repo-include', 'services/pedidos/', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(keyPaths(r.stdout)).toEqual(['services/pedidos/package.json', 'services/pedidos/src/server.ts']);
    expect(r.stdout).toContain('## Árbol de carpetas');
    expect(r.stdout).toContain('services/facturacion/'); // el árbol sigue completo
    expect(r.stdout).toContain('Filtros del usuario: el contenido de los archivos clave se limitó con --repo-include');
    expect(r.stderr).toMatch(/fuera de --repo-include \(el contenido se limitó a otros archivos\) \(\d+\): .*README\.md/);
    expect(r.stderr).toMatch(/\d+ archivo\(s\) clave fuera de --repo-include/);
    noLeaks(r.stdout, r.stderr);
  });

  it('varios --repo-include se suman, y combinados con --repo-exclude gana el exclude', () => {
    const r = run(['prompt', 'x', '--from-repo', repo, '--repo-include', 'README.md', '--repo-include', 'services/', '--repo-exclude', '**/package.json']);
    expect(r.status, r.stderr).toBe(0);
    const files = keyPaths(r.stdout);
    expect(files).toEqual(expect.arrayContaining(['README.md', 'services/facturacion/pom.xml', 'services/pedidos/src/server.ts']));
    expect(files).not.toContain('services/pedidos/package.json'); // incluido por services/, pero excluido
    expect(files).not.toContain('docker-compose.yml'); // ni README ni services/ lo incluyen
    expect(files.every((f) => f === 'README.md' || f.startsWith('services/'))).toBe(true);
  });

  it('un --repo-include que nombra los secretos NO los abre: error claro si no queda nada y ningún valor sale', () => {
    for (const glob of ['.env', '.env.production', '*.pem', 'config/', 'infra/', 'credentials.json']) {
      const r = run(['prompt', 'x', '--from-repo', repo, '--repo-include', glob]);
      expect(r.status, glob).toBe(2);
      expect(r.stderr, glob).toMatch(/Ningún archivo clave de «.*» cuadra con --repo-include/);
      expect(r.stdout, glob).toBe('');
      noLeaks(r.stdout, r.stderr);
    }
  });

  it('con un include que lo abarca todo, los secretos siguen sin leerse y lo que entra sigue redactado', () => {
    const args = ['--from-repo', repo, '--repo-include', '**', '--repo-include', '.env*', '--repo-include', '*.pem', '--repo-include', 'infra/', '--repo-include', 'config/'];
    const r = run(['generate', 'x', ...args, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[REDACTADO]');
    expect(r.stdout).toContain('DATABASE_URL'); // el .env.example: solo nombres de variables
    expect(r.stdout).not.toContain('===== .env ');
    expect(r.stdout).not.toContain('===== config/server.pem');
    expect(r.stderr).toMatch(/secreto \(nunca se lee\) \(9\): .*\.env /);
    expect(r.stderr).toContain('infra/terraform.tfstate');
    noLeaks(r.stdout, r.stderr);
    noLeaks(run(['prompt', 'x', ...args]).stdout);
  });

  it('con un exclude que no deja nada, o un include que no cuadra con nada, el error es de uso (código 2)', () => {
    const todo = run(['prompt', 'x', '--from-repo', repo, '--repo-exclude', '**']);
    expect(todo.status).toBe(2);
    expect(todo.stderr).toMatch(/no contiene archivos de texto que leer \(omitidos: .*excluido por --repo-exclude/);
    const nada = run(['prompt', 'x', '--from-repo', repo, '--repo-include', 'no-existe/']);
    expect(nada.status).toBe(2);
    expect(nada.stderr).toMatch(/solo reduce lo que la lista de archivos clave ya lee/);
    expect(nada.stdout + todo.stdout).toBe('');
  });

  it('un patrón inválido se rechaza al leer la opción: no se escanea nada y no hay salida', () => {
    for (const [option, glob, why] of [
      ['--repo-exclude', '!x', /no puede empezar por «!»/],
      ['--repo-include', '#x', /no puede empezar por «#»/],
      ['--repo-include', '../fuera', /no puede llevar «\.\.»/],
      ['--repo-exclude', '', /está vacío/],
      ['--repo-exclude', 'a\nb', /saltos de línea o caracteres de control/],
      ['--repo-include', ' x', /espacios al principio o al final/],
      ['--repo-exclude', '/', /no indica ningún archivo ni carpeta/],
    ] as const) {
      for (const command of ['prompt', 'generate']) {
        const r = run([command, 'x', '--from-repo', repo, option, glob]);
        expect(r.status, `${command} ${option} ${JSON.stringify(glob)}`).not.toBe(0);
        expect(r.stderr).toContain(`El patrón de ${option} no vale`);
        expect(r.stderr).toMatch(why);
        expect(r.stdout).toBe('');
        expect(r.stderr).not.toMatch(/Repositorio «/); // no llegó a escanear
      }
    }
  });

  it('un patrón hostil responde en un instante (sin retroceso exponencial)', () => {
    const started = Date.now();
    const r = run(['prompt', 'x', '--from-repo', repo, '--repo-exclude', `${'*a'.repeat(300)}b`, '--repo-include', `${'**/'.repeat(100)}README.md`]);
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(keyPaths(r.stdout)).toEqual(['README.md']);
  });

  it('solo valen junto con --from-repo', () => {
    for (const [command, option] of [['prompt', '--repo-include'], ['prompt', '--repo-exclude'], ['generate', '--repo-include'], ['generate', '--repo-exclude']]) {
      const r = run([command, 'x', option, '*.md']);
      expect(r.status, `${command} ${option}`).toBe(2);
      expect(r.stderr).toContain(`${option} solo se usa junto con --from-repo <carpeta|url>`);
      expect(r.stdout).toBe('');
    }
  });

  it('sin filtros, el resumen es el de siempre (ni el prompt ni el informe los mencionan)', () => {
    const r = run(['generate', 'x', '--from-repo', repo, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Filtros del usuario');
    expect(r.stderr).not.toContain('--repo-include');
    expect(r.stderr).not.toContain('--repo-exclude');
  });
});

describe('--help documenta la función y su privacidad', () => {
  it('generate --help', () => {
    const out = run(['generate', '--help']).stdout;
    expect(out).toContain('--from-repo <carpeta|url>');
    expect(out).toContain('--repo-ref <rama|etiqueta>');
    expect(out).toContain('--repo-budget <kb>');
    expect(out).toContain('--dry-run');
    expect(out).toContain('Privacidad:');
    expect(out).toMatch(/No lee \.env\*/);
    expect(out).toContain('[REDACTADO]');
    expect(out).toMatch(/como datos, no como instrucciones/);
    expect(out).toMatch(/Con una carpeta no ejecuta git ni nada del repositorio/);
    // Las URL de git: qué se acepta, cómo se clona y de quién son las credenciales.
    expect(out).toContain('URL de git (--from-repo <url> [--repo-ref <rama|etiqueta>]):');
    expect(out).toMatch(/https:\/\/host\/grupo\/repo\.git, ssh:\/\/git@host\/grupo\/repo\.git y la forma git@host:grupo\/repo\.git/);
    expect(out).toMatch(/Se rechazan http:\/\/\s+\(sin cifrar\), git:\/\/, file:\/\/, ext:: y cualquier otro transporte/);
    expect(out).toMatch(/Se ejecuta SOLO `git clone` \(sin shell\), en superficial/);
    expect(out).toMatch(/directorio\s+temporal que se borra siempre/);
    expect(out).toMatch(/credenciales que ya tengas en git .* y en ssh/);
    expect(out).toMatch(/git no pregunta contraseñas/);
    expect(out).toMatch(/--dry-run también clona \(necesita el contenido\) pero no llama a ningún modelo/);
    expect(out).toMatch(/va al modelo que elijas con --provider y --model/);
    expect(out).toMatch(/\(con una URL sí clona el repositorio, que\s+necesita su contenido\)/);
    // Los filtros: qué hacen, cómo se escriben y que nunca saltan la lista de secretos.
    expect(out).toContain('--repo-include <glob>');
    expect(out).toContain('--repo-exclude <glob>');
    expect(out).toContain('Filtros (--repo-include <glob>, --repo-exclude <glob>; se pueden repetir):');
    expect(out).toMatch(/como en un \.gitignore \(sin «!»\)/);
    expect(out).toMatch(/--repo-exclude quita lo que cuadre de TODO el resumen/);
    expect(out).toMatch(/excluido por --repo-exclude/);
    expect(out).toMatch(/--repo-include limita el contenido a los archivos clave que cuadren/);
    expect(out).toMatch(/el árbol de carpetas y la lista de componentes siguen\s+enteros/);
    expect(out).toMatch(/gana --repo-exclude/);
    expect(out).toMatch(/Nunca hacen legible lo que la lista de secretos prohíbe/);
    expect(out).toMatch(/--repo-include y --repo-exclude solo pueden reducir lo que se envía: nunca saltan la lista de secretos ni la\s+redacción/);
  });

  it('prompt --help', () => {
    const out = run(['prompt', '--help']).stdout;
    expect(out).toContain('--from-repo <carpeta|url>');
    expect(out).toContain('--repo-ref <rama|etiqueta>');
    expect(out).toContain('--repo-budget <kb>');
    expect(out).toContain('URL de git (--from-repo <url> [--repo-ref <rama|etiqueta>]):');
    expect(out).toMatch(/Se ejecuta SOLO `git clone`/);
    expect(out).toMatch(/`iark prompt` clona la URL \(necesita el contenido\) pero no llama a ningún modelo/);
    expect(out).toMatch(/credenciales que ya tengas en git/);
    expect(out).toContain('--repo-include <glob>');
    expect(out).toContain('--repo-exclude <glob>');
    expect(out).toContain('Filtros (--repo-include <glob>, --repo-exclude <glob>; se pueden repetir):');
    expect(out).toMatch(/Nunca hacen legible lo que la lista de secretos prohíbe/);
  });
});

describe('--from-repo no se expone por el servidor HTTP', () => {
  it('serve no importa el escáner ni lee carpetas del disco por petición', () => {
    const serve = readFileSync('src/cli/serve.ts', 'utf8');
    expect(serve).not.toMatch(/from-repo|fromRepo|scanRepo|\.\/repo/);
  });

  it('el escáner nunca ejecuta programas (ni git ni nada del repositorio) ni usa la red', () => {
    const forbidden = /child_process|node:http|node:https|node:net|(?<![.\w])fetch\(|(?<![.\w])exec(?:Sync|File)?\(|(?<![.\w])spawn(?:Sync)?\(/;
    for (const file of readdirSync('src/cli/repo').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'clone.ts')) {
      expect(readFileSync(join('src/cli/repo', file), 'utf8'), file).not.toMatch(forbidden);
    }
  });

  it('en --from-repo, clone.ts es el ÚNICO sitio que lanza un programa: un solo `spawn`, sin shell, sin red propia y sin leer ajustes del entorno que aflojen la seguridad', () => {
    const source = readFileSync('src/cli/repo/clone.ts', 'utf8');
    expect(source.match(/(?<![.\w])spawn\(/g)).toHaveLength(1);
    expect(source).toMatch(/import \{ spawn, type ChildProcess \} from 'node:child_process'/);
    expect(source).not.toMatch(/(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawnSync|fork)\(/);
    expect(source).not.toMatch(/\bshell\s*:/);
    expect(source).not.toMatch(/node:http|node:https|node:net|node:dns|(?<![.\w])fetch\(/);
    // Los puntos de inyección de las pruebas existen solo como parámetros de la función interna: nada los lee de process.env.
    expect(source).not.toMatch(/process\.env\.(?:IARK|GIT)_/);
    // Y el CLI (command.ts y main.ts) nunca los pasa.
    for (const file of ['src/cli/repo/command.ts', 'src/cli/main.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/gitPath|protocols|tmpRoot|CloneTestHooks|allowedProtocols/);
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
