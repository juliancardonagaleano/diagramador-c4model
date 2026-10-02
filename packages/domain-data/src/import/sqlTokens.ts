import { DataImportError } from './fromMermaid';

/**
 * Analizador léxico de SQL, pequeño y tolerante, compartido por el importador de DDL. No valida el lenguaje: reparte el
 * texto en tokens (palabras, identificadores entrecomillados, cadenas, números y signos) sin comentarios, y en sentencias.
 * Reconoce las comillas de los cinco dialectos ("x", `x`, [x]), las cadenas con dólares de PostgreSQL ($$...$$), los
 * separadores `GO` (SQL Server) y `/` (Oracle) en línea propia, `DELIMITER` (MySQL) y los datos de `COPY ... FROM stdin`.
 */

export type TokKind = 'word' | 'qid' | 'str' | 'num' | 'p';

export interface Tok {
  k: TokKind;
  /** Texto sin comillas (para `word` es el escrito; para `str`, el contenido). */
  v: string;
  /** Mayúsculas, solo en las palabras (para comparar palabras clave). */
  u: string;
  line: number;
}

const WORD = /[\p{L}_#@][\p{L}\p{N}_$#@]*/uy;
const NUMBER = /\d+(?:\.\d+)?/y;
const DOLLAR = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
/** Líneas que no son SQL (clientes de línea de órdenes): se descartan enteras. */
const CLIENT_LINE = /^(?:\\|(?:prompt|spool|whenever)\b)/i;

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\u00a0' || c === '\ufeff';

function unterminated(what: string, line: number): never {
  throw new DataImportError(`línea ${line}: ${what} sin cerrar (el resto del archivo no se puede analizar).`);
}

export function tokenize(text: string): Tok[] {
  if (text.includes('\u0000') || /\ufffd{2,}/.test(text)) {
    throw new DataImportError('El archivo no es texto SQL en UTF-8 (parece UTF-16 o binario): guárdalo como UTF-8 y vuelve a importarlo.');
  }
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = true;
  let delimiter: string | undefined;
  // `/*!50001 ... */` de MySQL (y `/*M! ... */` de MariaDB) es código que solo ejecutan versiones recientes: mysqldump deja ahí las vistas.
  let conditional = 0;
  const push = (k: TokKind, v: string, atLine = line): void => void toks.push({ k, v, u: k === 'word' ? v.toUpperCase() : '', line: atLine });
  const eolFrom = (from: number): number => {
    const e = text.indexOf('\n', from);
    return e < 0 ? n : e;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      lineStart = true;
      continue;
    }
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      const rest = text.slice(i, eolFrom(i));
      const trimmed = rest.trim();
      if (/^(?:go|\/)(?:\s+\d+)?$/i.test(trimmed)) {
        push('p', ';');
        i += rest.length;
        continue;
      }
      const set = /^delimiter\s+([^\w\s,]+)$/i.exec(trimmed);
      if (set) {
        delimiter = set[1] === ';' ? undefined : set[1];
        i += rest.length;
        continue;
      }
      if (CLIENT_LINE.test(trimmed)) {
        i += rest.length;
        continue;
      }
      if (/^copy\b.*\bfrom\s+stdin\b/i.test(trimmed)) {
        // Volcado de datos de PostgreSQL: hasta la línea `\.` no hay SQL.
        push('word', 'COPY');
        push('p', ';');
        let end = eolFrom(i);
        while (end < n) {
          const next = eolFrom(end + 1);
          const body = text.slice(end + 1, next).trim();
          end = next;
          line += 1;
          if (body === '\\.') break;
        }
        i = end;
        continue;
      }
    }
    if (delimiter && text.startsWith(delimiter, i)) {
      push('p', ';');
      i += delimiter.length;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      i = eolFrom(i);
      continue;
    }
    if (conditional > 0 && c === '*' && text[i + 1] === '/') {
      conditional -= 1;
      i += 2;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const open = /^\/\*M?!\d*/.exec(text.slice(i, i + 12));
      if (open) {
        conditional += 1;
        i += open[0].length;
        continue;
      }
      const end = text.indexOf('*/', i + 2);
      if (end < 0) unterminated('un comentario /* */', line);
      for (let j = i; j < end; j += 1) if (text[j] === '\n') line += 1;
      i = end + 2;
      continue;
    }
    if (c === "'") {
      const start = line;
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= n) unterminated('una cadena', start);
        const d = text[j];
        if (d === '\\' && j + 1 < n) {
          value += text[j + 1];
          if (text[j + 1] === '\n') line += 1;
          j += 2;
        } else if (d === "'") {
          if (text[j + 1] === "'") {
            value += "'";
            j += 2;
          } else break;
        } else {
          if (d === '\n') line += 1;
          value += d;
          j += 1;
        }
      }
      push('str', value, start);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '`') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= n || text[j] === '\n') unterminated('un identificador entre comillas', line);
        if (text[j] === c) {
          if (text[j + 1] === c) {
            value += c;
            j += 2;
          } else break;
        } else {
          value += text[j];
          j += 1;
        }
      }
      push('qid', value);
      i = j + 1;
      continue;
    }
    if (c === '[') {
      // [x] de SQL Server solo es un identificador si no es un índice o una dimensión de array (`int[]`, `a[1]`).
      const prev = toks[toks.length - 1];
      const adjacent = i > 0 && !isSpace(text[i - 1]) && text[i - 1] !== '\n';
      const glued = prev !== undefined && adjacent && (prev.k === 'word' || prev.k === 'qid' || (prev.k === 'p' && (prev.v === ')' || prev.v === ']')));
      let j = i + 1;
      let value = '';
      let closed = false;
      while (!glued && j < n && text[j] !== '\n') {
        if (text[j] === ']') {
          if (text[j + 1] === ']') {
            value += ']';
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        value += text[j];
        j += 1;
      }
      if (closed && value.trim() !== '' && !/^[\d\s,]+$/.test(value)) {
        push('qid', value);
        i = j + 1;
        continue;
      }
      push('p', '[');
      i += 1;
      continue;
    }
    if (c === '$') {
      DOLLAR.lastIndex = i;
      const tag = DOLLAR.exec(text);
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        if (end < 0) unterminated('una cadena $$', line);
        const start = line;
        const body = text.slice(i + tag[0].length, end);
        for (const ch of body) if (ch === '\n') line += 1;
        push('str', body, start);
        i = end + tag[0].length;
        continue;
      }
    }
    NUMBER.lastIndex = i;
    const num = /\d/.test(c) ? NUMBER.exec(text) : null;
    if (num) {
      push('num', num[0]);
      i += num[0].length;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    if (word) {
      push('word', word[0]);
      i += word[0].length;
      continue;
    }
    push('p', c);
    i += 1;
  }
  return toks;
}

export const isP = (t: Tok | undefined, v: string): boolean => t !== undefined && t.k === 'p' && t.v === v;
export const isW = (t: Tok | undefined, ...words: string[]): boolean => t !== undefined && t.k === 'word' && words.includes(t.u);
export const isName = (t: Tok | undefined): boolean => t !== undefined && (t.k === 'word' || t.k === 'qid');

/** Índice del `)` que cierra el `(` de `open`, o -1 si no se cierra. */
export function closeOf(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i += 1) {
    if (isP(toks[i], '(')) depth += 1;
    else if (isP(toks[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parte por las comas de primer nivel (fuera de paréntesis). */
export function splitTop(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (isP(t, '(')) depth += 1;
    else if (isP(t, ')')) depth -= 1;
    if (depth === 0 && isP(t, ',')) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length > 0 || out.length > 0) out.push(cur);
  return out;
}

/** Nombre calificado (`db.esquema.tabla`) desde `from`; `next` es el índice tras el nombre. */
export function readName(toks: Tok[], from: number): { parts: string[]; next: number; line: number } | undefined {
  if (!isName(toks[from])) return undefined;
  const parts = [toks[from].v];
  let i = from + 1;
  while (isP(toks[i], '.')) {
    if (isName(toks[i + 1])) {
      parts.push(toks[i + 1].v);
      i += 2;
    } else if (isP(toks[i + 1], '.') && isName(toks[i + 2])) {
      // `base..tabla` de SQL Server: el esquema se omite.
      parts.push(toks[i + 2].v);
      i += 3;
    } else break;
  }
  return { parts, next: i, line: toks[from].line };
}

const BLOCK_NOT_STARTED = new Set(['TRAN', 'TRANSACTION', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'ISOLATION', 'READ']);

/**
 * Reparte los tokens en sentencias por los `;`. Dentro del cuerpo de procedimientos, funciones y disparadores
 * (`BEGIN ... END`) los `;` no cortan, para que sus instrucciones no se tomen por sentencias sueltas.
 */
export function splitStatements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let routine = false;
  let depth = 0;
  let declaring = false;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (isP(t, ';') && depth <= 0 && !declaring) {
      if (cur.length > 0) out.push(cur);
      cur = [];
      routine = false;
      depth = 0;
      continue;
    }
    // `SET x ON` o `USE base` sin terminador (SQL*Plus, SSMS): la sentencia siguiente empieza en una línea nueva.
    if (cur.length > 0 && isW(cur[0], 'SET', 'USE') && t.k === 'word' && t.line > cur[cur.length - 1].line && ['CREATE', 'ALTER', 'DROP', 'COMMENT', 'INSERT'].includes(t.u)) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
    if (cur.length === 1) {
      routine = (isW(t, 'BEGIN') && !isP(toks[i + 1], ';') && !(toks[i + 1]?.k === 'word' && BLOCK_NOT_STARTED.has(toks[i + 1].u))) || isW(t, 'DECLARE');
      declaring = isW(t, 'DECLARE');
      if (isW(t, 'BEGIN') && routine) depth = 1;
      continue;
    }
    if (!routine && cur.length <= 14 && isW(cur[0], 'CREATE', 'ALTER') && isW(t, 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'EVENT')) routine = true;
    if (!routine || t.k !== 'word') continue;
    if (t.u === 'IS' && depth === 0 && cur.length <= 40) declaring = true;
    else if (t.u === 'BEGIN' && !(toks[i + 1]?.k === 'word' && BLOCK_NOT_STARTED.has(toks[i + 1].u))) {
      depth += 1;
      declaring = false;
    } else if (t.u === 'CASE') depth += 1;
    else if (t.u === 'END') {
      const next = toks[i + 1];
      if (isW(next, 'IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR')) {
        cur.push(next);
        i += 1;
      } else {
        if (isW(next, 'CASE')) {
          cur.push(next);
          i += 1;
        }
        depth -= 1;
      }
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
