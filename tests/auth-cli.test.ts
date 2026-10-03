import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cli/tokens';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// `iark auth` lanza el CLI empaquetado como proceso, igual que `tests/project-cli.test.ts`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

describe('iark auth (CLI empaquetado)', () => {
  let bundle: CliBundle;
  const dirs: string[] = [];
  beforeAll(async () => {
    bundle = await buildCliBundle('auth');
  });
  afterAll(() => {
    bundle?.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-auth-cli-'));
    dirs.push(dir);
    return dir;
  };
  /** `iark …` sin ninguna variable de entorno de la suite (los tests pasan `IARK_TOKENS` solo cuando la prueban). */
  const iark = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', env: { ...process.env, IARK_TOKENS: '', IARK_WORKSPACE: '', ...env } });

  it('recorre el flujo: create (el token sale una vez por stdout) → list → revoke', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const created = iark(['auth', 'create', 'Ana García', '--role', 'editor', '--tokens', file]);
    expect(created.status, created.stderr).toBe(0);
    // stdout es solo el token (sirve para `TOKEN=$(iark auth create …)`); lo demás va a stderr
    const token = created.stdout.trimEnd();
    expect(created.stdout).toBe(`${token}\n`);
    expect(token).toMatch(/^iark_[A-Za-z0-9_-]{43}$/);
    expect(created.stderr).toContain('«Ana García» (editor)');
    expect(created.stderr).toContain('no se vuelve a mostrar');
    expect(created.stderr).not.toContain(token);
    // en disco: solo el hash, con modo 0600
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.parse(text).tokens).toEqual([{ name: 'Ana García', role: 'editor', hash: hashToken(token), createdAt: expect.any(String) }]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = iark(['auth', 'create', 'Luis', '--role', 'viewer', '-t', file]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trimEnd()).not.toBe(token);

    const list = iark(['auth', 'list', '--tokens', file]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/^Ana García\s+editor\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/m);
    expect(list.stdout).toMatch(/^Luis\s+viewer\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/m);
    for (const secret of [token, second.stdout.trim(), hashToken(token), hashToken(token).slice(0, 8)]) expect(list.stdout).not.toContain(secret);

    const asJson = iark(['auth', 'list', '--json', '--tokens', file]);
    expect(JSON.parse(asJson.stdout)).toEqual([
      { name: 'Ana García', role: 'editor', createdAt: expect.any(String) },
      { name: 'Luis', role: 'viewer', createdAt: expect.any(String) },
    ]);
    expect(asJson.stdout).not.toContain('hash');

    const revoked = iark(['auth', 'revoke', 'ana garcía', '--tokens', file]);
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(revoked.stdout).toContain('«Ana García» (editor) revocado');
    expect(JSON.parse(iark(['auth', 'list', '--json', '-t', file]).stdout).map((t: { name: string }) => t.name)).toEqual(['Luis']);
    expect(readFileSync(file, 'utf8')).not.toContain(hashToken(token));
  });

  it('el archivo sale de IARK_TOKENS si no se indica --tokens (y --tokens manda)', () => {
    const dir = tmp();
    const fromEnv = join(dir, 'del-entorno.json');
    const explicit = join(dir, 'explicito.json');
    expect(iark(['auth', 'create', 'Ana', '--role', 'admin'], { IARK_TOKENS: fromEnv }).status).toBe(0);
    expect(JSON.parse(readFileSync(fromEnv, 'utf8')).tokens).toHaveLength(1);
    expect(iark(['auth', 'create', 'Luis', '--role', 'admin', '--tokens', explicit], { IARK_TOKENS: fromEnv }).status).toBe(0);
    expect(JSON.parse(readFileSync(explicit, 'utf8')).tokens.map((t: { name: string }) => t.name)).toEqual(['Luis']);
    expect(JSON.parse(readFileSync(fromEnv, 'utf8')).tokens.map((t: { name: string }) => t.name)).toEqual(['Ana']);
    expect(iark(['auth', 'list'], { IARK_TOKENS: fromEnv }).stdout).toContain('Ana');
    expect(iark(['auth', 'revoke', 'Ana'], { IARK_TOKENS: fromEnv }).status).toBe(0);
  });

  it('los errores de uso salen con código 2 y un mensaje claro (sin crear ni tocar nada)', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const fails = (args: string[], message: RegExp, env?: Record<string, string>) => {
      const result = iark(args, env);
      expect(result.status, `iark ${args.join(' ')}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(message);
      expect(result.stdout).toBe(''); // y nunca un token
    };
    fails(['auth', 'create', 'Ana', '--tokens', file], /Falta --role: viewer, editor, admin/);
    fails(['auth', 'create', 'Ana', '--role', 'root', '--tokens', file], /Rol inválido «root»: use viewer, editor o admin/);
    fails(['auth', 'create', '   ', '--role', 'viewer', '--tokens', file], /no puede estar vacío/);
    fails(['auth', 'create', 'Ana', '--role', 'viewer'], /--tokens <archivo> o con la variable IARK_TOKENS/);
    fails(['auth', 'list'], /IARK_TOKENS/);
    fails(['auth', 'revoke', 'Ana'], /IARK_TOKENS/);
    fails(['auth', 'list', '--tokens', file], /No existe el archivo de tokens/);
    fails(['auth', 'revoke', 'Ana', '--tokens', file], /No existe el archivo de tokens/);
    expect(() => readFileSync(file)).toThrow(); // ninguno de los anteriores creó el archivo

    expect(iark(['auth', 'create', 'Ana', '--role', 'viewer', '--tokens', file]).status).toBe(0);
    fails(['auth', 'create', 'ANA', '--role', 'admin', '--tokens', file], /Ya existe un token llamado «ANA»/);
    fails(['auth', 'revoke', 'Nadie', '--tokens', file], /No existe ningún token llamado «Nadie»/);
  });

  it('un archivo dañado es un error de uso (2) y nunca se sobrescribe; uno que no se puede usar (disco, permisos), un error del sistema (1)', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{ "version": 1, "tokens": "roto" }');
    for (const args of [['auth', 'create', 'Ana', '--role', 'viewer'], ['auth', 'list'], ['auth', 'revoke', 'Ana']]) {
      const result = iark([...args, '--tokens', file]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/El archivo de tokens no es válido/);
      expect(result.stdout).toBe('');
    }
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, "tokens": "roto" }');

    writeFileSync(join(dir, 'archivo'), 'x');
    const unwritable = iark(['auth', 'create', 'Ana', '--role', 'viewer', '--tokens', join(dir, 'archivo', 'tokens.json')]);
    expect(unwritable.status).toBe(1);
    expect(unwritable.stderr).toMatch(/No se pudo leer el archivo de tokens/);
    expect(unwritable.stdout).toBe('');
  });

  it('list sin tokens lo dice y enseña cómo crear el primero', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    iark(['auth', 'create', 'Ana', '--role', 'admin', '--tokens', file]);
    iark(['auth', 'revoke', 'Ana', '--tokens', file]);
    const list = iark(['auth', 'list', '--tokens', file]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/No hay tokens en .*iark auth create <nombre> --role admin/);
    expect(JSON.parse(iark(['auth', 'list', '--json', '--tokens', file]).stdout)).toEqual([]);
  });

  it('la ayuda explica los roles', () => {
    const help = iark(['auth', '--help']).stdout;
    for (const text of ['viewer', 'editor', 'admin', 'create', 'list', 'revoke']) expect(help).toContain(text);
    expect(iark(['auth', 'create', '--help']).stdout).toContain('UNA vez');
  });
});
