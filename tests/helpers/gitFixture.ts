import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Ayudas de las pruebas de `--from-repo <url>`: repositorios git bare REALES, locales y creados en la propia prueba (ninguna
 * prueba usa la red), y un entorno de git aislado (sin la configuración del usuario ni del sistema).
 */

export const GIT_AVAILABLE: boolean = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

/** Un entorno de git aislado: ni la configuración global ni la del sistema, y una identidad fija para los commits. */
export function isolatedGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Prueba',
    GIT_AUTHOR_EMAIL: 'prueba@example.test',
    GIT_COMMITTER_NAME: 'Prueba',
    GIT_COMMITTER_EMAIL: 'prueba@example.test',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = isolatedGitEnv()): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falló (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export interface BareRepo {
  /** Carpeta del repositorio bare. */
  dir: string;
  /** `file://…` (con una ruta local git ignora --depth: hace falta la forma file://). */
  url: string;
  dispose: () => void;
}

export interface BareRepoOptions {
  /** Una confirmación por elemento: lo que se añade o cambia en cada una (la última es la punta de `main`). */
  history: Array<Record<string, string | Buffer>>;
  /** Etiqueta `v1` sobre la PRIMERA confirmación (para comprobar `--branch <etiqueta>`). */
  tagFirst?: string;
  /** Una rama `dev` con un archivo más, que no es la de por defecto. */
  extraBranch?: { name: string; files: Record<string, string | Buffer> };
  /** Enlaces simbólicos a crear en la última confirmación: `ruta → destino`. */
  symlinks?: Record<string, string>;
}

/** Crea un repositorio de trabajo temporal, hace las confirmaciones y devuelve su clon `--bare`. */
export function makeBareRepo(options: BareRepoOptions): BareRepo {
  const root = mkdtempSync(join(tmpdir(), 'iark-bare-'));
  const work = join(root, 'trabajo');
  const bare = join(root, 'origen.git');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  options.history.forEach((files, i) => {
    writeFiles(work, files);
    if (i === options.history.length - 1 && options.symlinks) {
      for (const [rel, target] of Object.entries(options.symlinks)) {
        mkdirSync(dirname(join(work, rel)), { recursive: true });
        symlinkSync(target, join(work, rel));
      }
    }
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `confirmación ${i + 1}`]);
    if (i === 0 && options.tagFirst) git(work, ['tag', options.tagFirst]);
  });
  if (options.extraBranch) {
    git(work, ['checkout', '-q', '-b', options.extraBranch.name]);
    writeFiles(work, options.extraBranch.files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'rama extra']);
    git(work, ['checkout', '-q', 'main']);
  }
  git(root, ['clone', '-q', '--bare', work, bare]);
  return { dir: bare, url: `file://${bare}`, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** Cuántas confirmaciones tiene el historial visible desde HEAD de un clon (1 si es superficial). */
export function commitCount(clone: string): number {
  return Number(git(clone, ['rev-list', '--count', 'HEAD']));
}

/** Los directorios `iark-clone-*` que hay en una carpeta (los clones temporales que no se hayan borrado). */
export function leftoverClones(parent: string): string[] {
  try {
    return readdirSync(parent).filter((n) => n.startsWith('iark-clone-'));
  } catch {
    return [];
  }
}

/**
 * Un `git` falso (un script de Node) para ponerlo el primero en el PATH. Registra cada llamada como una línea JSON en `log`
 * y se comporta según la variable `FAKE_GIT_MODE`:
 *  - `copy`: copia `FAKE_GIT_FIXTURE` a la carpeta de destino (el último argumento), como haría un clon.
 *  - `real`: hace un clon REAL de `FAKE_GIT_BARE` (cambia la URL por la del repositorio bare local y permite `file`), con
 *    todos los demás argumentos y opciones tal cual, y anota cuántas confirmaciones trajo.
 *  - `fail`: escribe `FAKE_GIT_STDERR` por stderr y sale con 128.
 *  - `sleep`: avisa de su carpeta de destino, crea un archivo allí y duerme (para probar señales).
 */
export function installFakeGit(dir: string): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'git');
  const log = join(dir, 'llamadas.jsonl');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const argv = process.argv.slice(2);
const dest = argv[argv.length - 1];
const env = process.env;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env: { GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT, GIT_ALLOW_PROTOCOL: env.GIT_ALLOW_PROTOCOL, GIT_LFS_SKIP_SMUDGE: env.GIT_LFS_SKIP_SMUDGE, LC_ALL: env.LC_ALL, GIT_DIR: env.GIT_DIR }, hasTty: (() => { try { fs.openSync('/dev/tty', 'r'); return true; } catch { return false; } })() }) + '\\n');
const mode = env.FAKE_GIT_MODE || 'copy';
if (mode === 'fail') { process.stderr.write((env.FAKE_GIT_STDERR || 'fatal: error\\n').split('%DEST%').join(dest)); process.exit(128); }
if (mode === 'copy') {
  fs.cpSync(env.FAKE_GIT_FIXTURE, dest, { recursive: true });
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.git', 'config'), env.FAKE_GIT_DOTGIT_CONFIG || '[remote "origin"]\\n\\turl = ' + argv[argv.length - 2] + '\\n');
  process.exit(0);
}
if (mode === 'real') {
  const at = argv.indexOf('clone');
  const args = argv.slice();
  args[args.length - 2] = 'file://' + env.FAKE_GIT_BARE;
  args.splice(at, 0, '-c', 'protocol.allow=always', '-c', 'protocol.file.allow=always');
  const childEnv = { ...env };
  delete childEnv.GIT_ALLOW_PROTOCOL;
  const r = cp.spawnSync(env.FAKE_GIT_REAL, args, { env: childEnv, encoding: 'utf8' });
  if (r.status === 0) {
    const n = cp.spawnSync(env.FAKE_GIT_REAL, ['rev-list', '--count', 'HEAD'], { cwd: dest, env: childEnv, encoding: 'utf8' }).stdout.trim();
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ clonedCommits: Number(n), hooksDir: fs.existsSync(path.join(dest, '.git', 'hooks')) }) + '\\n');
  } else process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}
if (mode === 'sleep') {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'README.md'), '# a medias\\n');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ sleepingIn: dest, pid: process.pid, ppid: process.ppid }) + '\\n');
  setTimeout(() => {}, 60000);
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin: dir, log };
}
