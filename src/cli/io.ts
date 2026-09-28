import { readFileSync, readSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from '../core/model/schema';
import { extractJson } from '../core/util/extractJson';
import type { C4Document } from '../core/model/types';

export { extractJson };

/**
 * Lee la entrada estándar completa. `readFileSync(0)` lanza `EAGAIN` cuando stdin es un pipe no bloqueante cuyo
 * productor aún no ha escrito (p. ej. `c4diagram import x.drawio | c4diagram layout --stdin`, donde el primer
 * comando tarda en arrancar), así que se lee por bloques y, si no hay datos todavía, se espera y se reintenta.
 */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let bytes: number;
    try {
      bytes = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 25);
        continue;
      }
      if (code === 'EOF') break; // Windows: fin de la entrada
      throw error;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function readInput(file: string | undefined, useStdin: boolean): string {
  if (useStdin || file === '-' || !file) {
    if (process.stdin.isTTY && !useStdin && !file) {
      throw new CliError('Indique un archivo de entrada o use --stdin.');
    }
    return readStdin();
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new CliError(`No se pudo leer "${file}": ${(error as Error).message}`);
  }
}

export function readDocument(file: string | undefined, useStdin: boolean): C4Document {
  const raw = readInput(file, useStdin);
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (error) {
    throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
  return parseDocument(json);
}

export function writeOutput(file: string | undefined, content: string): void {
  if (!file || file === '-') {
    process.stdout.write(content);
    return;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  } catch (error) {
    throw new CliError(`No se pudo escribir "${file}": ${(error as Error).message}`);
  }
}

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}
