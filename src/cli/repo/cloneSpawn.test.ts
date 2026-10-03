import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cómo se lanza git, comprobado con un `child_process` falso: el ejecutable, los argumentos como arreglo (cada uno, un
 * argumento: nada pasa por un shell), las opciones de `spawn` y el entorno. Ningún proceso se lanza de verdad.
 */

interface Call {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}
const calls: Call[] = [];
let behaviour: (call: Call) => { code: number; stderr?: string } | 'error-enoent' = () => ({ code: 0 });

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    const call = { command, args, options };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(), stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }) });
    setImmediate(() => {
      const outcome = behaviour(call);
      if (outcome === 'error-enoent') {
        child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
        return;
      }
      if (outcome.code === 0) mkdirSync(args[args.length - 1], { recursive: true }); // git crea la carpeta de destino
      if (outcome.stderr) child.stderr.emit('data', outcome.stderr);
      child.emit('close', outcome.code, null);
    });
    return child;
  },
}));

const { withClonedRepo } = await import('./clone');

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'iark-spawn-test-'));
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
beforeEach(() => {
  calls.length = 0;
  behaviour = () => ({ code: 0 });
});

describe('withClonedRepo: cómo lanza git', () => {
  it('git con un arreglo de argumentos, sin shell, sin entrada, en su propia sesión y desde el directorio temporal', async () => {
    let folder = '';
    await withClonedRepo({ url: 'https://github.com/acme/tienda.git', ref: 'v1.2', display: 'https://github.com/acme/tienda.git' }, (dir) => {
      folder = dir;
    }, { tmpRoot, env: { PATH: '/usr/bin', HOME: '/home/yo' } });

    expect(calls).toHaveLength(1); // un solo programa, una sola vez
    const [call] = calls;
    expect(call.command).toBe('git');
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.args.every((a) => typeof a === 'string')).toBe(true);
    expect(call.options.shell).toBeUndefined();
    expect(call.options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(call.options.detached).toBe(process.platform !== 'win32');
    expect(call.options.windowsHide).toBe(true);
    expect(String(call.options.cwd).startsWith(join(tmpRoot, 'iark-clone-'))).toBe(true);
    expect(folder).toBe(join(String(call.options.cwd), 'repo'));

    // Los argumentos: opciones de seguridad, `clone`, las opciones del clon, `--`, la URL y el destino.
    const args = call.args;
    expect(args.slice(0, 12)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'advice.detachedHead=false']);
    expect(args.slice(12)).toEqual(['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules', '--template=', '--branch=v1.2', '--', 'https://github.com/acme/tienda.git', folder]);

    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/yo');
  });

  it('lo que llega a git es siempre UN argumento: nada se interpreta aunque la URL lleve metacaracteres de shell', async () => {
    const url = 'https://example.test/$(touch${IFS}pwned);`id`|x&&y>z.git';
    await withClonedRepo({ url, display: url }, () => undefined, { tmpRoot, env: {} });
    const args = calls[0].args;
    expect(args[args.length - 2]).toBe(url);
    expect(args.filter((a) => a.includes('touch'))).toEqual([url]);
    expect(calls[0].options.shell).toBeUndefined();
  });

  it('el directorio temporal se borra tras el éxito', async () => {
    let folder = '';
    await withClonedRepo({ url: 'https://example.test/a/b.git' }, (dir) => {
      folder = dir;
      expect(existsSync(dir)).toBe(true);
    }, { tmpRoot, env: {} });
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(folder, '..'))).toBe(false);
  });

  it('git sale con error: se traduce, se limpia (sin credenciales ni ruta temporal) y se borra el directorio', async () => {
    const token = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
    behaviour = (call) => ({ code: 128, stderr: `fatal: algo con https://u:${token}@host/x.git en ${call.args[call.args.length - 1]}\n` });
    const error = (await withClonedRepo({ url: 'https://example.test/a/b.git', display: 'https://example.test/a/b.git' }, () => undefined, { tmpRoot, env: {} }).catch((e) => e as Error))!;
    expect(error.name).toBe('CliError');
    expect(error.message).toMatch(/^git no pudo clonar «https:\/\/example.test\/a\/b.git» \(código 128\)/);
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('iark-clone-');
    expect(error.message).toContain('[directorio temporal]/repo');
    expect(calls).toHaveLength(1);
    expect(existsSync(String(calls[0].options.cwd))).toBe(false);
  });

  it('git no está instalado (ENOENT): mensaje claro y nada en disco', async () => {
    behaviour = () => 'error-enoent';
    const error = (await withClonedRepo({ url: 'https://example.test/a/b.git' }, () => undefined, { tmpRoot, env: {} }).catch((e) => e as Error))!;
    expect(error.message).toMatch(/No se encontró git/);
    expect(existsSync(String(calls[0].options.cwd))).toBe(false);
  });

  it('no se escuchan señales de más: al terminar se quitan los manejadores de SIGINT, SIGTERM y SIGHUP y el de exit', async () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((s) => process.listenerCount(s));
    await withClonedRepo({ url: 'https://example.test/a/b.git' }, () => undefined, { tmpRoot, env: {} });
    await withClonedRepo({ url: 'https://example.test/a/b.git' }, () => {
      throw new Error('falla');
    }, { tmpRoot, env: {} }).catch(() => undefined);
    expect(['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('mientras clona sí hay manejadores de señales (para borrar el directorio si te interrumpen)', async () => {
    const before = process.listenerCount('SIGTERM');
    let during = 0;
    await withClonedRepo({ url: 'https://example.test/a/b.git' }, () => {
      during = process.listenerCount('SIGTERM');
    }, { tmpRoot, env: {} });
    expect(during).toBe(before + 1);
  });

  it('una URL o una rama no válidas ni siquiera lanzan git', async () => {
    for (const request of [{ url: '--upload-pack=x' }, { url: 'https://example.test/a.git', ref: '-x' }, { url: 'https://example.test/a b.git' }]) {
      await expect(withClonedRepo(request, () => undefined, { tmpRoot, env: {} })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
});
