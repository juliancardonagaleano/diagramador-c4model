import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from '../core/model/schema';
import type { C4Document } from '../core/model/types';

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

/** Acepta JSON puro o JSON envuelto en un bloque ```json ... ``` (salida típica de una IA). */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first > 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function writeOutput(file: string | undefined, content: string): void {
  if (!file || file === '-') {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
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
