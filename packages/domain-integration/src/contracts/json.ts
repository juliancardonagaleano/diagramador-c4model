export interface TextPosition {
  line: number;
  column: number;
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string; line: number; column: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Línea y columna (desde 1) de un desplazamiento del texto. */
export function positionAt(text: string, offset: number): TextPosition {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Claves de `order` primero (las que existan) y el resto después, en su orden original. */
export function orderKeys(value: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const head = order.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]] as const);
  const rest = Object.entries(value).filter(([key]) => !order.includes(key));
  return Object.fromEntries([...head, ...rest]);
}

export function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function parseJson(text: string): JsonParseResult {
  const source = stripBom(text);
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (error) {
    const found = locateJsonError(source);
    if (found) return { ok: false, message: found.message, ...positionAt(source, found.offset) };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `JSON no válido: ${reason}`, line: 1, column: 1 };
  }
}

export function describeJsonError(result: { message: string; line: number; column: number }): string {
  return `${result.message} (línea ${result.line}, columna ${result.column})`;
}

interface JsonFault {
  offset: number;
  message: string;
}

class JsonFailure extends Error {
  constructor(readonly fault: JsonFault) {
    super(fault.message);
  }
}

const JSON_LITERALS = new Set(['true', 'false', 'null']);
const MAX_JSON_DEPTH = 500;

/**
 * Validador estricto que solo se ejecuta cuando `JSON.parse` falla: los mensajes de V8 cambian entre versiones y no siempre
 * traen posición, así que la posición y el motivo (en español) salen de aquí.
 */
function locateJsonError(text: string): JsonFault | undefined {
  let pos = 0;
  const fail = (offset: number, message: string): never => {
    throw new JsonFailure({ offset, message: `JSON no válido: ${message}` });
  };
  const skipSpace = (): void => {
    while (pos < text.length && ' \t\n\r'.includes(text[pos]!)) pos++;
  };
  const describe = (char: string | undefined): string => (char === undefined ? 'el final del texto' : `«${char}»`);
  const endOfContent = (): number => text.trimEnd().length;

  const parseString = (): void => {
    const start = pos;
    pos++;
    while (pos < text.length) {
      const char = text[pos]!;
      if (char === '"') {
        pos++;
        return;
      }
      if (char === '\n' || char === '\r') fail(start, 'cadena sin cerrar (las cadenas no pueden contener saltos de línea)');
      if (char < ' ') fail(pos, 'carácter de control sin escapar dentro de una cadena');
      if (char === '\\') {
        const next = text[pos + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) fail(pos, 'secuencia \\u incompleta o no hexadecimal');
          pos += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) fail(pos, `secuencia de escape no válida «\\${next ?? ''}»`);
        pos += 2;
        continue;
      }
      pos++;
    }
    fail(start, 'cadena sin cerrar');
  };

  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) fail(pos, 'anidamiento excesivo');
    skipSpace();
    if (pos >= text.length) fail(endOfContent(), 'el texto termina de forma inesperada');
    const char = text[pos]!;
    if (char === '{') {
      pos++;
      skipSpace();
      if (text[pos] === '}') {
        pos++;
        return;
      }
      for (;;) {
        skipSpace();
        if (text[pos] !== '"') fail(pos >= text.length ? endOfContent() : pos, `se esperaba un nombre de propiedad entre comillas dobles y se encontró ${describe(text[pos])}`);
        parseString();
        skipSpace();
        if (text[pos] !== ':') fail(pos >= text.length ? endOfContent() : pos, `se esperaba «:» tras el nombre de la propiedad y se encontró ${describe(text[pos])}`);
        pos++;
        parseValue(depth + 1);
        skipSpace();
        if (text[pos] === ',') {
          const comma = pos;
          pos++;
          skipSpace();
          if (text[pos] === '}') fail(comma, 'sobra una coma antes de «}»');
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return;
        }
        fail(pos >= text.length ? endOfContent() : pos, `se esperaba «,» o «}» y se encontró ${describe(text[pos])}`);
      }
    }
    if (char === '[') {
      pos++;
      skipSpace();
      if (text[pos] === ']') {
        pos++;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipSpace();
        if (text[pos] === ',') {
          const comma = pos;
          pos++;
          skipSpace();
          if (text[pos] === ']') fail(comma, 'sobra una coma antes de «]»');
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return;
        }
        fail(pos >= text.length ? endOfContent() : pos, `se esperaba «,» o «]» y se encontró ${describe(text[pos])}`);
      }
    }
    if (char === '"') return parseString();
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
      match.lastIndex = pos;
      const found = match.exec(text);
      if (!found || /[0-9.eE]/.test(text[pos + found[0].length] ?? '')) fail(pos, 'número no válido');
      pos += found![0].length;
      return;
    }
    const word = /[A-Za-z]+/y;
    word.lastIndex = pos;
    const literal = word.exec(text);
    if (literal) {
      if (!JSON_LITERALS.has(literal[0])) fail(pos, `valor no válido «${literal[0]}» (solo se admiten true, false y null)`);
      pos += literal[0].length;
      return;
    }
    fail(pos, `se esperaba un valor y se encontró ${describe(char)}`);
  };

  try {
    parseValue(0);
    skipSpace();
    if (pos < text.length) fail(pos, `contenido inesperado ${describe(text[pos])} tras el final del JSON`);
  } catch (error) {
    if (error instanceof JsonFailure) return error.fault;
    if (error instanceof RangeError) return { offset: 0, message: 'JSON no válido: anidamiento excesivo' };
    throw error;
  }
  return undefined;
}
