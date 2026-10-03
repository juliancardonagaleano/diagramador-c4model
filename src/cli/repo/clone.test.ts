import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitCount, GIT_AVAILABLE, git, isolatedGitEnv, leftoverClones, makeBareRepo, type BareRepo } from '../../../tests/helpers/gitFixture';
import { CliError } from '../io';
import { buildCloneArgs, buildCloneEnv, CLONE_PROTOCOLS, describeCloneFailure, sanitizeGitOutput, withClonedRepo } from './clone';
import { scanRepo } from './scan';

const failure = (stderr: string, extra: Partial<Parameters<typeof describeCloneFailure>[0]> = {}) => ({ code: 128, signal: null, stderr, timedOut: false, ...extra });
const REQUEST = { url: 'https://github.com/acme/tienda.git', display: 'https://github.com/acme/tienda.git' };

describe('buildCloneArgs: argumentos de git (sin shell, con -- y con las opciones de seguridad)', () => {
  it('la lista exacta, en orden', () => {
    expect(buildCloneArgs({ url: 'https://github.com/acme/tienda.git' }, '/tmp/x/repo')).toEqual([
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      '-c', 'advice.detachedHead=false',
      'clone',
      '--quiet',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '--no-recurse-submodules',
      '--template=',
      '--',
      'https://github.com/acme/tienda.git',
      '/tmp/x/repo',
    ]);
  });

  it('con --repo-ref añade --branch=<ref> antes de `--` (y la URL siempre va detrás de `--`)', () => {
    const args = buildCloneArgs({ url: 'git@github.com:acme/tienda.git', ref: 'release/1.0' }, '/tmp/x/repo');
    expect(args).toContain('--branch=release/1.0');
    const dashes = args.indexOf('--');
    expect(args.indexOf('--branch=release/1.0')).toBeLessThan(dashes);
    expect(args.slice(dashes)).toEqual(['--', 'git@github.com:acme/tienda.git', '/tmp/x/repo']);
  });

  it('solo https y ssh están permitidos; todo lo demás, prohibido', () => {
    expect(CLONE_PROTOCOLS).toEqual(['https', 'ssh']);
    const args = buildCloneArgs({ url: 'https://example.com/x.git' }, '/tmp/x');
    const allows = args.filter((a) => a.startsWith('protocol.'));
    expect(allows).toEqual(['protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always']);
  });

  it('el protocolo permitido solo cambia con el parámetro interno (las pruebas), no por otra vía', () => {
    const args = buildCloneArgs({ url: 'file:///x.git' }, '/tmp/x', ['file']);
    expect(args.filter((a) => a.startsWith('protocol.'))).toEqual(['protocol.allow=never', 'protocol.file.allow=always']);
  });

  it('desactiva hooks, plantillas, fsmonitor, submódulos, etiquetas e historial', () => {
    const args = buildCloneArgs({ url: 'https://example.com/x.git' }, '/tmp/x');
    for (const flag of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', '--template=', '--no-recurse-submodules', '--no-tags', '--single-branch']) expect(args).toContain(flag);
    expect(args.slice(args.indexOf('--depth'), args.indexOf('--depth') + 2)).toEqual(['--depth', '1']);
  });

  it.each([
    ['la URL empieza por «-»', { url: '--upload-pack=touch /tmp/pwned' }],
    ['la URL empieza por «-» (opción corta)', { url: '-oProxyCommand=x' }],
    ['la URL lleva un espacio', { url: 'https://example.com/a b.git' }],
    ['la URL lleva un salto de línea', { url: 'https://example.com/a.git\n--upload-pack=x' }],
    ['la URL está vacía', { url: '' }],
    ['la rama empieza por «-»', { url: 'https://example.com/x.git', ref: '--upload-pack=x' }],
    ['la rama lleva un espacio', { url: 'https://example.com/x.git', ref: 'a b' }],
    ['la rama lleva «..»', { url: 'https://example.com/x.git', ref: 'a..b' }],
  ])('última barrera: %s', (_caso, request) => {
    expect(() => buildCloneArgs(request, '/tmp/x')).toThrow(CliError);
  });
});

describe('buildCloneEnv: entorno del clonado', () => {
  it('git no pregunta contraseñas, solo https y ssh, sin LFS, sin subir a otros repositorios y con mensajes en inglés', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', HOME: '/home/yo' }, CLONE_PROTOCOLS, '/tmp');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1');
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/tmp');
    expect(env.LC_ALL).toBe('C');
  });

  it('conserva el entorno del usuario (PATH, HOME, proxy, ssh-agent, askpass) para que los repositorios privados funcionen', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/yo', SSH_AUTH_SOCK: '/run/agent.sock', GIT_ASKPASS: '/usr/bin/pregunta', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/otra', HTTPS_PROXY: 'http://proxy:3128', GIT_CONFIG_GLOBAL: '/home/yo/.gitconfig' };
    const env = buildCloneEnv(base);
    for (const [key, value] of Object.entries(base)) expect(env[key], key).toBe(value);
  });

  it('quita lo que redirigiría el clon a otro repositorio o árbol (GIT_DIR, GIT_WORK_TREE…), sea cual sea la capitalización', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', GIT_DIR: '/otro/.git', GIT_WORK_TREE: '/otro', GIT_INDEX_FILE: '/x', GIT_OBJECT_DIRECTORY: '/y', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/z', GIT_NAMESPACE: 'n', GIT_TEMPLATE_DIR: '/plantilla' });
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_TEMPLATE_DIR']) expect(env, key).not.toHaveProperty(key);
  });

  it('no modifica el entorno de partida y el del usuario no puede aflojar GIT_TERMINAL_PROMPT ni GIT_ALLOW_PROTOCOL', () => {
    const base = { GIT_TERMINAL_PROMPT: '1', GIT_ALLOW_PROTOCOL: 'file:ext:git:http', LC_ALL: 'es_ES.UTF-8' };
    const env = buildCloneEnv(base);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(base.GIT_TERMINAL_PROMPT).toBe('1');
  });
});

describe('sanitizeGitOutput: lo que dice git no deja ver credenciales, rutas ni controles', () => {
  const token = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');

  it('quita el usuario y la contraseña de las URL', () => {
    const out = sanitizeGitOutput(`fatal: unable to access 'https://usuario:${token}@github.com/acme/tienda.git/': The requested URL returned error: 403\nremote: ssh://git:clave@host/x`);
    expect(out).toContain("https://github.com/acme/tienda.git/");
    expect(out).toContain('ssh://host/x');
    expect(out).not.toContain(token);
    expect(out).not.toContain('usuario');
    expect(out).not.toContain('clave');
  });

  it('redacta secretos sueltos y quita las rutas del directorio temporal', () => {
    const out = sanitizeGitOutput(`fatal: destination path '/tmp/iark-clone-abc123/repo' already exists\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nclave ${token}`, ['/tmp/iark-clone-abc123']);
    expect(out).not.toContain('iark-clone-abc123');
    expect(out).toContain('[directorio temporal]/repo');
    expect(out).not.toContain(token);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('quita secuencias de escape de terminal y caracteres de control', () => {
    const out = sanitizeGitOutput('fatal: \u001b[2J\u001b[31mmalo\u001b[0m\u0007\u0000 fin\rmás');
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('malo');
  });

  it('se queda con las últimas líneas y las acota', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i + 1}`).join('\n');
    const out = sanitizeGitOutput(lines);
    expect(out.split('\n')).toHaveLength(6);
    expect(out).toContain('línea 30');
    expect(out).not.toContain('línea 1\n');
    expect(sanitizeGitOutput('x'.repeat(5000)).length).toBeLessThanOrEqual(601);
  });
});

describe('describeCloneFailure: cada fallo, un mensaje en español', () => {
  it('git no instalado', () => {
    const message = describeCloneFailure({ code: null, signal: null, stderr: '', timedOut: false, spawnError: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }, REQUEST, 120000);
    expect(message).toMatch(/No se encontró git en este equipo/);
    expect(message).toMatch(/clona el repositorio tú y pasa su carpeta/);
  });

  it('tiempo agotado', () => {
    const message = describeCloneFailure(failure('', { timedOut: true, code: null, signal: 'SIGTERM' }), REQUEST, 120000);
    expect(message).toMatch(/superó el tiempo máximo \(120 s\)/);
    expect(message).toContain('https://github.com/acme/tienda.git');
  });

  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", /No se pudo autenticar/],
    ["fatal: Authentication failed for 'https://github.com/acme/x.git/'", /No se pudo autenticar/],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', /No se pudo autenticar/],
    ["fatal: unable to access 'https://x/': The requested URL returned error: 403", /No se pudo autenticar/],
    ['fatal: unable to access: The requested URL returned error: 401', /No se pudo autenticar/],
  ])('autenticación fallida: %s', (log, message) => {
    const text = describeCloneFailure(failure(log), REQUEST, 1000);
    expect(text).toMatch(message);
    expect(text).toMatch(/nunca pregunta contraseñas/);
    expect(text).toMatch(/credenciales que ya tengas en git .* o en ssh/);
  });

  it('clave del servidor ssh desconocida', () => {
    const text = describeCloneFailure(failure('Host key verification failed.\nfatal: Could not read from remote repository.'), { url: 'git@host:x.git' }, 1000);
    expect(text).toMatch(/clave del servidor ssh .* known_hosts/);
  });

  it.each([
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.'],
    ["fatal: repository 'https://github.com/acme/x.git/' not found"],
    ["fatal: unable to access 'https://x/': The requested URL returned error: 404"],
    ["fatal: 'x' does not appear to be a git repository"],
  ])('repositorio inexistente: %s', (log) => {
    expect(describeCloneFailure(failure(log), REQUEST, 1000)).toMatch(/no existe o no tienes acceso/);
  });

  it('rama o etiqueta inexistente', () => {
    const log = 'warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin';
    expect(describeCloneFailure(failure(log), { ...REQUEST, ref: 'nope' }, 1000)).toBe('La rama o etiqueta «nope» no existe en «https://github.com/acme/tienda.git».');
    expect(describeCloneFailure(failure("fatal: couldn't find remote ref refs/heads/x"), { ...REQUEST, ref: 'x' }, 1000)).toMatch(/La rama o etiqueta «x» no existe/);
    expect(describeCloneFailure(failure('warning: Could not find remote branch main to clone.'), REQUEST, 1000)).toMatch(/No se encontró la rama por defecto/);
  });

  it.each([
    ["fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com"],
    ['ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Could not read from remote repository.'],
    ["fatal: unable to access 'https://x/': Failed to connect to x port 443 after 130 ms: Connection refused"],
    ["fatal: unable to access 'https://x/': Connection timed out after 300000 milliseconds"],
    ['ssh: connect to host x port 22: Network is unreachable'],
  ])('sin red: %s', (log) => {
    expect(describeCloneFailure(failure(log), REQUEST, 1000)).toMatch(/No se pudo conectar con .*: sin red, host inexistente o servidor inaccesible/);
  });

  it('sin cliente ssh instalado', () => {
    const text = describeCloneFailure(failure('error: cannot run ssh: No such file or directory\nfatal: unable to fork'), { url: 'git@host:x.git' }, 1000);
    expect(text).toMatch(/git no encuentra el cliente ssh \(OpenSSH\) para clonar «git@host:x.git»: instálalo, o usa una URL https:\/\//);
  });

  it('certificado TLS', () => {
    expect(describeCloneFailure(failure("fatal: unable to access 'https://x/': SSL certificate problem: self-signed certificate"), REQUEST, 1000)).toMatch(/certificado TLS/);
  });

  it('cualquier otro fallo: mensaje genérico con las últimas líneas de git, ya limpias', () => {
    const token = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
    const text = describeCloneFailure(failure(`fatal: algo raro con https://u:${token}@host/x.git en /tmp/iark-clone-zzz/repo`), REQUEST, 1000, ['/tmp/iark-clone-zzz']);
    expect(text).toMatch(/^git no pudo clonar «https:\/\/github.com\/acme\/tienda.git» \(código 128\):\nfatal: algo raro/);
    expect(text).not.toContain(token);
    expect(text).not.toContain('iark-clone-zzz');
  });
});

describe.skipIf(!GIT_AVAILABLE)('withClonedRepo: clon real de un repositorio bare local (protocolo `file` solo para la prueba)', () => {
  let bare: BareRepo;
  let hostile: BareRepo;
  let tmpRoot: string;
  let env: NodeJS.ProcessEnv;
  const hookCanary = () => join(tmpRoot, 'hook-canary');
  const FILES: Array<Record<string, string>> = [
    { 'README.md': '# Tienda\nUsa PostgreSQL.\n', 'docker-compose.yml': 'services:\n  api:\n    build: .\n', 'package.json': '{"name":"tienda"}\n' },
    { 'services/api/package.json': '{"name":"api"}\n', 'NOTAS.md': 'segunda\n' },
  ];
  const protocols = ['file'];

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'iark-clonetest-'));
    // La configuración «del usuario» de la prueba intenta ejecutar un hook y copiar plantillas: no debe lograrlo.
    const hooks = join(tmpRoot, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${hookCanary()}"\n`);
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    const template = join(tmpRoot, 'plantilla');
    mkdirSync(join(template, 'hooks'), { recursive: true });
    writeFileSync(join(template, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${hookCanary()}"\n`);
    chmodSync(join(template, 'hooks', 'post-checkout'), 0o755);
    const config = join(tmpRoot, 'gitconfig');
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${template}\n`);
    env = isolatedGitEnv({ GIT_CONFIG_GLOBAL: config });
    bare = makeBareRepo({ history: FILES, tagFirst: 'v1', extraBranch: { name: 'dev', files: { 'dev.md': 'solo en dev\n' } } });
    hostile = makeBareRepo({
      history: [
        {
          'README.md': '# Hostil\n',
          '.gitmodules': `[submodule "otro"]\n\tpath = otro\n\turl = file://${tmpRoot}/no-existe.git\n`,
          '.gitattributes': '* filter=evil\n*.md diff=evil\n',
          '.gitignore': `${'*a'.repeat(30)}b\n**/**/**/**/**/x\n`,
          [`a\u001b[2Jb.md`]: 'nombre con escape de terminal\n',
          'src/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ts': 'export {}\n',
        },
      ],
      symlinks: { 'enlace-a-passwd': '/etc/passwd', 'dir-enlace': '../../..' },
    });
  });
  afterAll(() => {
    bare?.dispose();
    hostile?.dispose();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const clone = <T>(url: string, use: (dir: string) => T | Promise<T>, extra: { ref?: string; timeoutMs?: number; gitPath?: string } = {}) =>
    withClonedRepo({ url, ref: extra.ref, display: url }, use, { protocols, tmpRoot, env, timeoutMs: extra.timeoutMs, gitPath: extra.gitPath });

  it('clona en superficial: una sola confirmación aunque el origen tenga más, sin hooks ni etiquetas', async () => {
    const seen = await clone(bare.url, (dir) => ({
      files: readdirSync(dir).sort(),
      commits: commitCount(dir),
      hooks: existsSync(join(dir, '.git', 'hooks')),
      tags: git(dir, ['tag', '-l'], env),
      branches: git(dir, ['branch', '-a'], env),
    }));
    expect(seen.files).toEqual(['.git', 'NOTAS.md', 'README.md', 'docker-compose.yml', 'package.json', 'services']);
    expect(seen.commits).toBe(1);
    expect(seen.hooks).toBe(false); // --template= vacía: ni la carpeta de hooks
    expect(seen.tags).toBe('');
    expect(seen.branches).not.toMatch(/dev/); // una sola rama
  });

  it('la configuración del usuario (core.hooksPath, init.templateDir) no consigue ejecutar un hook; sin las opciones de seguridad, sí', async () => {
    await clone(bare.url, () => undefined);
    expect(existsSync(hookCanary()), 'un hook se ejecutó durante el clonado').toBe(false);
    // Control: el mismo clon con git a pelo y la misma configuración SÍ ejecuta el hook de la plantilla (la prueba es significativa).
    const naked = join(tmpRoot, 'a-pelo');
    git(tmpRoot, ['-c', 'protocol.file.allow=always', 'clone', '--quiet', bare.url, naked], env);
    expect(existsSync(hookCanary()), 'el control no ejecutó el hook: la prueba no demuestra nada').toBe(true);
    rmSync(hookCanary());
    rmSync(naked, { recursive: true, force: true });
  });

  it('--repo-ref con una etiqueta o una rama', async () => {
    const tag = await clone(bare.url, (dir) => ({ files: readdirSync(dir).sort(), commits: commitCount(dir) }), { ref: 'v1' });
    expect(tag.files).toEqual(['.git', 'README.md', 'docker-compose.yml', 'package.json']); // la primera confirmación: sin NOTAS.md
    expect(tag.commits).toBe(1);
    const branch = await clone(bare.url, (dir) => readdirSync(dir).sort(), { ref: 'dev' });
    expect(branch).toContain('dev.md');
  });

  it('la carpeta del clon se lee con el escáner, que usa el nombre del repositorio y no la ruta temporal', async () => {
    const digest = await clone(bare.url, (dir) => scanRepo(dir, { remote: { name: 'tienda' } }));
    expect(digest.name).toBe('tienda');
    expect(digest.remote).toBe(true);
    expect(digest.text).toContain('Repositorio: tienda');
    expect(digest.text).toContain('===== README.md [documentación] =====');
    expect(digest.text).not.toContain('iark-clone-');
    expect(digest.text).not.toContain(tmpRoot);
    expect(digest.included.map((f) => f.path)).not.toContain('.git/config');
    expect(JSON.stringify(digest.omitted)).not.toContain('iark-clone-');
  });

  it('el directorio temporal se borra al terminar, y es uno nuevo cada vez', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await clone(bare.url, (dir) => {
        seen.push(dir);
        expect(existsSync(dir)).toBe(true);
        expect(dir.startsWith(join(tmpRoot, 'iark-clone-'))).toBe(true);
      });
    }
    expect(new Set(seen).size).toBe(2);
    for (const dir of seen) expect(existsSync(dir)).toBe(false);
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('el directorio temporal se borra aunque `use` (el escaneo) falle', async () => {
    let dir = '';
    await expect(
      clone(bare.url, (d) => {
        dir = d;
        throw new Error('el escaneo falló');
      }),
    ).rejects.toThrow('el escaneo falló');
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('el directorio temporal se borra aunque `use` falle de forma asíncrona', async () => {
    await expect(clone(bare.url, async () => Promise.reject(new CliError('nada que leer', 2)))).rejects.toThrow('nada que leer');
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('repositorio inexistente: error claro (código 2) y nada se queda en el disco', async () => {
    const error = (await clone(`file://${tmpRoot}/no-existe.git`, () => undefined).catch((e) => e as CliError))!;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(2);
    expect(error.message).toMatch(/no existe o no tienes acceso|git no pudo clonar/);
    expect(error.message).not.toContain('iark-clone-');
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('rama inexistente: error claro y nada se queda en el disco', async () => {
    const error = (await clone(bare.url, () => undefined, { ref: 'no-existe' }).catch((e) => e as CliError))!;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(`La rama o etiqueta «no-existe» no existe en «${bare.url}».`);
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('un protocolo no permitido se rechaza (el parámetro de pruebas es lo único que abre `file`)', async () => {
    const error = (await withClonedRepo({ url: bare.url, display: bare.url }, () => undefined, { tmpRoot, env }).catch((e) => e as CliError))!;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toMatch(/^git no pudo clonar/);
    expect(error.message).toMatch(/transport 'file' not allowed/);
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('git no instalado: mensaje claro y nada se queda en el disco', async () => {
    const error = (await clone(bare.url, () => undefined, { gitPath: join(tmpRoot, 'no-hay-git') }).catch((e) => e as CliError))!;
    expect(error.message).toMatch(/No se encontró git/);
    expect(leftoverClones(tmpRoot)).toEqual([]);
  });

  it('tiempo agotado: se cancela, se mata git (y lo que lance) y no queda nada', async () => {
    const slow = join(tmpRoot, 'git-lento');
    writeFileSync(slow, `#!/bin/sh\nsleep 30 &\necho $$ > "${tmpRoot}/lento.pid"\nsleep 30\n`);
    chmodSync(slow, 0o755);
    const started = Date.now();
    const error = (await clone(bare.url, () => undefined, { gitPath: slow, timeoutMs: 400 }).catch((e) => e as CliError))!;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(2);
    expect(error.message).toMatch(/superó el tiempo máximo \(0 s\)|superó el tiempo máximo/);
    expect(leftoverClones(tmpRoot)).toEqual([]);
    const pid = Number(readFileSync(join(tmpRoot, 'lento.pid'), 'utf8').trim());
    // El proceso ya no existe (se mató todo el grupo).
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('un repositorio hostil: no se siguen submódulos ni enlaces, los nombres con controles no salen y el .gitignore no se interpreta', async () => {
    const started = Date.now();
    const result = await clone(hostile.url, (dir) => {
      const digest = scanRepo(dir, { remote: { name: 'hostil' } });
      return { digest, link: lstatSync(join(dir, 'enlace-a-passwd')).isSymbolicLink(), submodule: existsSync(join(dir, 'otro')) };
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.link).toBe(true); // git sí creó el enlace…
    expect(result.submodule).toBe(false); // …pero no el submódulo
    const { digest } = result;
    expect(digest.omitted.find((o) => o.path === 'enlace-a-passwd')?.reason).toBe('enlace');
    expect(digest.text).not.toContain('root:'); // nada de /etc/passwd
    expect(digest.text).not.toMatch(/\u001b/);
    expect(JSON.stringify(digest.omitted)).not.toMatch(/\u001b/);
    expect(digest.omitted.some((o) => o.detail === 'nombre con caracteres de control')).toBe(true);
    expect(digest.omittedCounts.ilegible).toBe(1);
  });
});
