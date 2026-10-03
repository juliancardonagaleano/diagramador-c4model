import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Un `iark serve --workspace <carpeta temporal>` de verdad para las pruebas e2e de «guardar en la nube»: el CLI real
 * (con `tsx`, que resuelve los alias del repositorio sin compilar nada), en un puerto libre que elige el propio sistema
 * (`-p 0`) y con `--cors <origen de la prueba>`. Cada prueba arranca el suyo y lo para al terminar, así que no queda
 * ningún puerto ocupado ni estado compartido entre pruebas.
 */
export interface CloudServer {
  /** `http://127.0.0.1:<puerto>`. */
  url: string;
  /** La carpeta de trabajo (la fuente de verdad: un directorio por proyecto). */
  workspace: string;
  stop(): Promise<void>;
}

export async function startCloudServer(options: { cors?: string } = {}): Promise<CloudServer> {
  const workspace = mkdtempSync(join(tmpdir(), 'iark-e2e-nube-'));
  const args = ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'serve', '--workspace', workspace, '-p', '0'];
  if (options.cors) args.push('--cors', options.cors);
  const child: ChildProcess = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servidor no arrancó en 30 s:\n${output}`)), 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = /escuchando en (http:\/\/[^\s]+?)(?: \(|\s|$)/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor terminó (código ${code}) antes de escuchar:\n${output}`));
    });
  });
  return {
    url,
    workspace,
    async stop() {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
      }
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
