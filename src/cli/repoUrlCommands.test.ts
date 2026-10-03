import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';
import { GIT_AVAILABLE, installFakeGit, leftoverClones, makeBareRepo, type BareRepo } from '../../tests/helpers/gitFixture';
import { ALL_FAKE_VALUES, copyFixtureRepo, FAKE, plantSecrets, removeRepo } from '../../tests/helpers/repoFixture';

// `iark prompt|generate --from-repo <url>`: el CLI empaquetado con un `git` falso (un script) al principio del PATH que
// copia un repositorio de prueba con secretos plantados (o hace un clon REAL de un repositorio bare local). Ninguna prueba
// usa la red ni llama a un modelo: `prompt` y `--dry-run` no llaman a nada, y `generate` sin credenciales falla antes de enviar.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const URL_OK = 'https://git.example.test/acme/tienda.git';

let bundle: CliBundle;
let cli: string;
let repo: string; // el repositorio de prueba (con secretos plantados) que «clona» el git falso
let home: string;
let work: string; // carpeta de trabajo de la prueba: TMPDIR de los procesos, el git falso y sus registros
let fakeBin: string;
let log: string;
let bare: BareRepo | undefined;
let realGit = '';

beforeAll(async () => {
  bundle = await buildCliBundle('repourl');
  cli = bundle.cli;
  repo = copyFixtureRepo();
  plantSecrets(repo);
  home = copyFixtureRepo();
  work = mkdtempSync(join(tmpdir(), 'iark-url-test-'));
  mkdirSync(join(work, 'tmp'));
  const fake = installFakeGit(join(work, 'bin'));
  fakeBin = fake.bin;
  log = fake.log;
  if (GIT_AVAILABLE) {
    realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    bare = makeBareRepo({ history: [{ 'README.md': '# Antiguo\n' }, { 'README.md': '# Tienda real\nUsa PostgreSQL y RabbitMQ.\n', 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n', 'package.json': '{"name":"tienda"}\n' }] });
  }
});
afterAll(() => {
  bundle?.dispose();
  for (const dir of [repo, home]) if (dir) removeRepo(dir);
  bare?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});

function sinCredenciales(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
    // Los directorios temporales del clon van a una carpeta propia: se puede comprobar que no queda ninguno.
    TMPDIR: join(work, 'tmp'),
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_GIT_MODE: 'copy',
    FAKE_GIT_FIXTURE: repo,
    ...extra,
  };
}

interface Call {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  hasTty: boolean;
}
function resetLog(): void {
  rmSync(log, { force: true });
}
function calls(): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => Array.isArray(c.argv));
}
const extraLog = (): Array<Record<string, unknown>> => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !Array.isArray(c.argv)) : []);

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  resetLog();
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: sinCredenciales(extra) });
}
/** ¿Sigue vivo el proceso? Un zombi (muerto, sin que su padre lo recoja) no cuenta como vivo. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}
const sinClonesPendientes = (): void => expect(leftoverClones(join(work, 'tmp')), 'quedó un directorio temporal del clon').toEqual([]);
function noLeaks(...outputs: string[]): void {
  for (const out of outputs) for (const value of ALL_FAKE_VALUES) expect(out, `se coló: ${value.slice(0, 14)}…`).not.toContain(value);
}
const sinRutasTemporales = (...outputs: string[]): void => {
  for (const out of outputs) {
    expect(out).not.toContain('iark-clone-');
    expect(out).not.toContain(join(work, 'tmp'));
  }
};

describe('iark prompt --from-repo <url>', () => {
  it('clona (con git) y devuelve el mismo prompt que con la carpeta, sin llamar a ningún modelo ni mostrar secretos', () => {
    const r = run(['prompt', 'Dibuja la arquitectura', '--from-repo', URL_OK]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`Clonando ${URL_OK} (rama por defecto, historial superficial)…`);
    expect(r.stderr).toMatch(/Repositorio «tienda»: el resumen lleva el árbol de carpetas y \d+ archivo\(s\) clave/);
    expect(r.stdout).toMatch(/^<<<INICIO-DEL-REPOSITORIO-[0-9a-f]{12}>>>$/m);
    expect(r.stdout).toContain('Repositorio: tienda');
    expect(r.stdout).toContain('resumen del repositorio «tienda»'); // no «local»
    expect(r.stdout).toContain('===== docker-compose.yml [contenedores] =====');
    expect(r.stdout).toContain('services/pedidos/package.json');
    expect(r.stdout).toContain('[REDACTADO]');
    // Los secretos plantados no salen; y el nombre es el del repositorio, jamás la ruta del directorio temporal.
    noLeaks(r.stdout, r.stderr);
    sinRutasTemporales(r.stdout, r.stderr);
    expect(r.stdout).not.toContain(repo);
    sinClonesPendientes();

    // Contra la carpeta: los mismos archivos clave (lo único que cambia es el nombre y que un clon trae su .git).
    const folder = run(['prompt', 'Dibuja la arquitectura', '--from-repo', repo]);
    const keyFiles = (out: string): string => out.split('## Archivos clave')[1].split(/^<<<FIN-DEL-REPOSITORIO-/m)[0];
    expect(keyFiles(r.stdout)).toBe(keyFiles(folder.stdout));
  });

  it('lo que se le pide a git: la lista exacta de argumentos y el entorno, en una sola llamada', () => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK]);
    expect(r.status, r.stderr).toBe(0);
    const [call, ...rest] = calls();
    expect(rest).toEqual([]); // se ejecuta SOLO ese git clone: ninguna otra llamada
    const dest = call.argv[call.argv.length - 1];
    expect(dest).toMatch(/\/iark-clone-[A-Za-z0-9]+\/repo$/);
    expect(dest.startsWith(join(work, 'tmp'))).toBe(true); // en un directorio nuevo bajo os.tmpdir()
    expect(call.argv).toEqual([
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      '-c', 'advice.detachedHead=false',
      'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules', '--template=',
      '--', URL_OK, dest,
    ]);
    expect(call.cwd.startsWith(join(work, 'tmp'))).toBe(true); // git no corre en la carpeta del usuario
    expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C' });
    expect(call.hasTty).toBe(false); // sin terminal de control: ni ssh puede quedarse preguntando
  });

  it('--repo-ref: clona esa rama o etiqueta y lo dice', () => {
    const r = run(['prompt', 'x', '--from-repo', 'git@git.example.test:acme/tienda.git', '--repo-ref', 'release/1.0']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Clonando git@git.example.test:acme/tienda.git (rama release/1.0, historial superficial)…');
    const { argv } = calls()[0];
    expect(argv).toContain('--branch=release/1.0');
    expect(argv.slice(-3, -1)).toEqual(['--', 'git@git.example.test:acme/tienda.git']);
    expect(r.stdout).toContain('Repositorio: tienda');
  });

  it('el contenido del clon es datos: ni .git ni lo que haya dentro sale (aunque lleve secretos o nombres con sentido)', () => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK], { FAKE_GIT_DOTGIT_CONFIG: `[credential]\n\thelper = store\n[user]\n\ttoken = ${FAKE.github}\n[url "https://u:${FAKE.dbPassword}@x/"]\n\tinsteadOf = y\n` });
    expect(r.status, r.stderr).toBe(0);
    noLeaks(r.stdout, r.stderr);
    expect(r.stdout).not.toContain('[credential]');
    expect(r.stdout).not.toContain('insteadOf');
  });

  it('se combina con --module, --from y --repo-budget', () => {
    const r = run(['prompt', 'Completa', '--from-repo', URL_OK, '--module', 'platform', '--from', 'examples/banca.json', '--repo-budget', '10']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('arquitecto de plataforma');
    expect(r.stderr).toMatch(/de 10,0 KB\)/);
  });
});

describe('iark generate --from-repo <url>', () => {
  it('--dry-run SÍ clona (necesita el contenido) y NO llama a ningún modelo: imprime el mismo prompt que `prompt`', () => {
    const dry = run(['generate', 'Dibuja la arquitectura', '--from-repo', URL_OK, '--dry-run']);
    expect(calls()).toHaveLength(1); // el --dry-run clonó (una sola llamada a git)
    const prompt = run(['prompt', 'Dibuja la arquitectura', '--from-repo', URL_OK]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toBe(prompt.stdout);
    expect(dry.stderr).toContain(`Clonando ${URL_OK}`);
    expect(dry.stderr).toContain('Incluidos con contenido');
    expect(dry.stderr).toMatch(/secreto \(nunca se lee\)/);
    expect(dry.stderr).not.toMatch(/Error generando el modelo/);
    noLeaks(dry.stdout, dry.stderr);
    sinRutasTemporales(dry.stdout, dry.stderr);
    sinClonesPendientes();
  });

  it('sin --dry-run y sin credenciales: clona, avisa de lo que enviaría, falla claro (4) y no deja el directorio temporal', () => {
    const r = run(['generate', 'Dibuja la arquitectura', '--from-repo', URL_OK, '--provider', 'anthropic']);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(`Clonando ${URL_OK} (rama por defecto, historial superficial)…`);
    expect(r.stderr).toMatch(/Repositorio «tienda»: el resumen lleva/);
    expect(r.stderr).toContain('Se enviará este resumen al modelo junto con tu instrucción');
    expect(r.stderr).toMatch(/Error generando el modelo/);
    expect(r.stdout).toBe('');
    noLeaks(r.stdout, r.stderr);
    sinRutasTemporales(r.stderr);
    sinClonesPendientes();
  });
});

describe('--from-repo <url> con --repo-include y --repo-exclude', () => {
  const keyPaths = (out: string): string[] => [...out.split('## Archivos clave')[1].split(/^<<<FIN-DEL-REPOSITORIO-/m)[0].matchAll(/^===== (\S+) \[/gm)].map((m) => m[1]);

  it('se aplican al clon (igual que a una carpeta): exclude quita, include limita, y los secretos del clon siguen sin leerse', () => {
    const r = run(['generate', 'x', '--from-repo', URL_OK, '--repo-exclude', 'docker-compose.yml', '--repo-include', 'README.md', '--repo-include', '*.yaml', '--repo-include', '.env*', '--repo-include', '**/*.pem', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toHaveLength(1); // un solo git clone
    const files = keyPaths(r.stdout);
    expect(files).toEqual(expect.arrayContaining(['README.md', 'k8s/deployment.yaml']));
    expect(files).not.toContain('docker-compose.yml');
    expect(files).not.toContain('.env');
    expect(files.some((f) => f.endsWith('.pem'))).toBe(false);
    expect(r.stderr).toMatch(/excluido por --repo-exclude \(1\): docker-compose\.yml/);
    expect(r.stderr).toMatch(/secreto \(nunca se lee\)/);
    expect(r.stdout).toContain('Repositorio: tienda');
    noLeaks(r.stdout, r.stderr);
    sinRutasTemporales(r.stdout, r.stderr);
    sinClonesPendientes();
  });

  it('un patrón inválido se rechaza antes de clonar: git no llega a lanzarse', () => {
    for (const [option, glob] of [['--repo-exclude', '!x'], ['--repo-include', '../x'], ['--repo-include', 'a\nb']]) {
      const r = run(['prompt', 'x', '--from-repo', URL_OK, option, glob]);
      expect(r.status, `${option} ${JSON.stringify(glob)}`).not.toBe(0);
      expect(r.stderr).toContain(`El patrón de ${option} no vale`);
      expect(r.stderr).not.toContain('Clonando');
      expect(r.stdout).toBe('');
      expect(calls()).toHaveLength(0);
    }
    sinClonesPendientes();
  });

  it('si el include no deja ningún archivo clave, error de uso (2) y el directorio temporal desaparece', () => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK, '--repo-include', '.env']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Ningún archivo clave de «tienda» cuadra con --repo-include/);
    expect(r.stdout).toBe('');
    noLeaks(r.stdout, r.stderr);
    sinRutasTemporales(r.stderr);
    sinClonesPendientes();
  });
});

describe('--from-repo <url>: lo que se rechaza (git no llega a lanzarse)', () => {
  const token = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
  it.each([
    ['http://git.example.test/acme/tienda.git', /http:\/\/ van sin cifrar/],
    ['git://git.example.test/acme/tienda.git', /git:\/\/ no cifra ni autentica/],
    ['file:///etc', /file:\/\/ no se admite/],
    ['ftp://git.example.test/x.git', /transporte «ftp:\/\/» no se admite/],
    ['ext::sh -c touch% /tmp/pwned', /ayudantes de transporte/],
    ['--upload-pack=touch /tmp/pwned', /no puede empezar por «-»/],
    [`https://usuario:${token}@git.example.test/acme/tienda.git`, /lleva credenciales .* dentro/],
    ['https://git.example.test/acme/tienda.git\nhttps://otra.example/x.git', /espacios, saltos de línea/],
    ['https://git.example.test/acme/ti enda.git', /espacios, saltos de línea/],
    ['https://git.example.test/acme/$(id).git', /caracteres no admitidos/],
  ])('%s', (value, message) => {
    for (const command of ['generate', 'prompt']) {
      const args = command === 'generate' ? ['generate', 'x', `--from-repo=${value}`, '--dry-run'] : ['prompt', 'x', `--from-repo=${value}`];
      const r = run(args);
      expect(r.status, `${command}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toContain(token); // NUNCA se imprime una URL con credenciales
      expect(r.stderr).not.toContain('usuario:');
      expect(r.stderr).not.toContain('Clonando');
      expect(calls()).toHaveLength(0);
    }
    sinClonesPendientes();
  });

  it('el valor con credenciales no sale ni por stdout ni por stderr, ni en forma scp', () => {
    for (const value of [`https://${token}@git.example.test/acme/x.git`, `ssh://git:${token}@git.example.test/acme/x.git`, `usuario:${token}@git.example.test:acme/x`]) {
      const r = run(['prompt', 'x', `--from-repo=${value}`]);
      expect(r.status).toBe(2);
      expect(r.stdout + r.stderr).not.toContain(token);
    }
  });

  it('una carpeta que existe sigue siendo una carpeta (y no clona nada)', () => {
    const r = run(['prompt', 'x', '--from-repo', repo]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('Clonando');
    expect(calls()).toHaveLength(0);
  });

  it('--repo-ref con una carpeta, sin --from-repo o con un valor no válido: error de uso', () => {
    const carpeta = run(['prompt', 'x', '--from-repo', repo, '--repo-ref', 'main']);
    expect(carpeta.status).toBe(2);
    expect(carpeta.stderr).toMatch(/--repo-ref solo vale con una URL de git en --from-repo; una carpeta local se lee tal como está/);
    const suelto = run(['prompt', 'x', '--repo-ref', 'main']);
    expect(suelto.status).toBe(2);
    expect(suelto.stderr).toMatch(/--repo-ref solo se usa junto con --from-repo <url>/);
    for (const ref of ['--upload-pack=touch /tmp/pwned', 'a b', 'a..b', '$(id)', 'x;y', '/x', 'x.lock']) {
      const r = run(['prompt', 'x', '--from-repo', URL_OK, `--repo-ref=${ref}`]);
      expect(r.status, ref).not.toBe(0);
      expect(r.stderr, ref).toMatch(/La rama o etiqueta de --repo-ref solo puede llevar letras, dígitos/);
      expect(calls(), ref).toHaveLength(0);
    }
  });
});

describe('--from-repo <url>: fallos de git, en español, con código 2 y sin dejar nada', () => {
  const secret = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
  it.each([
    ["fatal: could not read Username for 'https://git.example.test': terminal prompts disabled\n", /No se pudo autenticar en «https:\/\/git.example.test\/acme\/tienda.git».*nunca pregunta contraseñas/s],
    ['git@git.example.test: Permission denied (publickey).\nfatal: Could not read from remote repository.\n', /No se pudo autenticar/],
    ['Host key verification failed.\nfatal: Could not read from remote repository.\n', /known_hosts/],
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.\n', /no existe o no tienes acceso/],
    ["warning: Could not find remote branch x to clone.\nfatal: Remote branch x not found in upstream origin\n", /La rama o etiqueta «x» no existe/],
    ["fatal: unable to access 'https://git.example.test/acme/tienda.git/': Could not resolve host: git.example.test\n", /sin red, host inexistente o servidor inaccesible/],
    ['fatal: algo raro\n', /\ngit no pudo clonar «https:\/\/git.example.test\/acme\/tienda.git» \(código 128\):\nfatal: algo raro/],
  ])('%s', (stderr, message) => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK, '--repo-ref', 'x'], { FAKE_GIT_MODE: 'fail', FAKE_GIT_STDERR: stderr });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
    sinClonesPendientes();
  });

  it('lo que diga git se limpia: ni credenciales en URL, ni secretos, ni la ruta del directorio temporal', () => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK], {
      FAKE_GIT_MODE: 'fail',
      FAKE_GIT_STDERR: `fatal: raro en https://usuario:${secret}@git.example.test/acme/x.git y %DEST% \u001b[31mcolor\u001b[0m\n`,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('fatal: raro en https://git.example.test/acme/x.git');
    expect(r.stderr).not.toContain(secret);
    expect(r.stderr).not.toContain('usuario');
    expect(r.stderr).toContain('[directorio temporal]/repo');
    expect(r.stderr).not.toContain(join(work, 'tmp'));
    expect(r.stderr).not.toContain('iark-clone-');
    expect(r.stderr).not.toContain('\u001b');
  });

  it('git no instalado: mensaje claro', () => {
    const vacio = join(work, 'sin-git');
    mkdirSync(vacio, { recursive: true });
    const r = run(['prompt', 'x', '--from-repo', URL_OK], { PATH: vacio });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No se encontró git en este equipo/);
    sinClonesPendientes();
  });

  it('un repositorio sin nada reconocible: el error habla del repositorio, no del directorio temporal, y se borra todo', () => {
    const vacio = mkdtempSync(join(tmpdir(), 'iark-vacio-'));
    try {
      writeFileSync(join(vacio, 'notas.txt'), 'comprar leche\n');
      const r = run(['prompt', 'x', '--from-repo', URL_OK], { FAKE_GIT_FIXTURE: vacio });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/No se reconoce nada en el repositorio «tienda»/);
      sinRutasTemporales(r.stderr);
      sinClonesPendientes();
    } finally {
      removeRepo(vacio);
    }
  });
});

describe('--from-repo <url>: interrumpir el clonado borra el directorio temporal', () => {
  it.skipIf(process.platform === 'win32').each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('%s mientras git sigue clonando: sale con %i, mata a git y no queda nada', async (signal, code) => {
    resetLog();
    const child = spawn(process.execPath, [cli, 'prompt', 'x', '--from-repo', URL_OK], { env: sinCredenciales({ FAKE_GIT_MODE: 'sleep' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (c, s) => resolve({ code: c, signal: s })));
    // Espera a que el git falso esté «clonando» (ha creado su carpeta de destino).
    let sleeping: { sleepingIn?: string; pid?: number } | undefined;
    for (let i = 0; i < 400 && !sleeping; i += 1) {
      sleeping = extraLog().find((e) => e.sleepingIn) as typeof sleeping;
      if (!sleeping) await new Promise((r) => setTimeout(r, 50));
    }
    expect(sleeping, `el git falso no llegó a dormirse: ${stderr}`).toBeTruthy();
    expect(existsSync(sleeping!.sleepingIn!)).toBe(true);
    expect(leftoverClones(join(work, 'tmp'))).toHaveLength(1);

    child.kill(signal);
    const result = await exited;
    expect(result.signal, 'debe salir por su cuenta, no matado por la señal').toBeNull();
    expect(result.code).toBe(code);
    expect(existsSync(sleeping!.sleepingIn!)).toBe(false);
    sinClonesPendientes();
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(sleeping!.pid!), 'el git falso sigue vivo').toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('--from-repo <url>: clon REAL de un repositorio bare local (git de verdad detrás de un envoltorio que solo cambia la URL)', () => {
  // Solo lo necesario: el PATH (con el git falso delante) no se toca, y la configuración de git del usuario no influye.
  const real = (): NodeJS.ProcessEnv => ({ FAKE_GIT_MODE: 'real', FAKE_GIT_REAL: realGit, FAKE_GIT_BARE: bare!.dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

  it('prompt y generate --dry-run: leen lo que hay en el repositorio (no el antiguo), en superficial y sin hooks', () => {
    for (const args of [
      ['prompt', 'Dibuja la arquitectura', '--from-repo', URL_OK],
      ['generate', 'Dibuja la arquitectura', '--from-repo', URL_OK, '--dry-run'],
    ]) {
      const r = run(args, real());
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('# Tienda real');
      expect(r.stdout).toContain('Usa PostgreSQL y RabbitMQ.');
      expect(r.stdout).not.toContain('# Antiguo');
      expect(r.stdout).toContain('===== docker-compose.yml [contenedores] =====');
      expect(r.stdout).toContain('Repositorio: tienda');
      sinRutasTemporales(r.stdout, r.stderr);
      const result = extraLog().find((e) => 'clonedCommits' in e)!;
      expect(result.clonedCommits).toBe(1); // dos confirmaciones en el origen, una en el clon
      expect(result.hooksDir).toBe(false);
      sinClonesPendientes();
    }
  });

  it('--repo-ref con una etiqueta del origen', () => {
    const r = run(['prompt', 'x', '--from-repo', URL_OK, '--repo-ref', 'no-existe'], real());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('La rama o etiqueta «no-existe» no existe en «https://git.example.test/acme/tienda.git».');
    sinClonesPendientes();
  });
});

describe('--help de la función', () => {
  it('generate --help y prompt --help hablan de las URL (se prueban en detalle en repoCommands.test.ts)', () => {
    for (const command of ['generate', 'prompt']) {
      const out = run([command, '--help']).stdout;
      expect(out).toContain('--from-repo <carpeta|url>');
      expect(out).toContain('--repo-ref <rama|etiqueta>');
      expect(out).toContain('URL de git');
    }
  });
});

it('la carpeta del clon nunca es la de trabajo ni la del usuario: el directorio de la prueba no tiene nada nuevo', () => {
  expect(readdirSync(join(work, 'tmp'))).toEqual([]);
});
