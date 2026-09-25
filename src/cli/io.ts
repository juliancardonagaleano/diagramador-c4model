import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from '../core/model/schema';
import { extractJson } from '../core/util/extractJson';
import type { C4Document } from '../core/model/types';

export { extractJson };

export function readInput(file: string | undefined, useStdin: boolean): string {
  if (useStdin || file === '-' || !file) {
    if (process.stdin.isTTY && !useStdin && !file) {
      throw new CliError('Indique un archivo de entrada o use --stdin.');
    }
    return readFileSync(0, 'utf8');
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
