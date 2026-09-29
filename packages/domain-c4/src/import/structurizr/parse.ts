/**
 * Lectura sintáctica del DSL de Structurizr: convierte el texto en un árbol de sentencias (cada sentencia son sus
 * tokens y, si abre `{ … }`, sus sentencias hijas). No interpreta el significado de nada: eso lo hace el importador.
 */

/** Error al leer o interpretar un DSL de Structurizr (mensaje pensado para mostrarse tal cual, con la línea). */
export class DslImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslImportError';
  }
}

export interface DslToken {
  text: string;
  /** Entre comillas: una cadena literal (un `"->"` entrecomillado no es una flecha). */
  quoted: boolean;
}

export interface DslStatement {
  tokens: DslToken[];
  line: number;
  /** Ubicación legible para los mensajes ("línea 12" o "modelo.dsl, línea 3"). */
  loc: string;
  block?: DslStatement[];
}

/** Devuelve el contenido de un `!include`; `undefined` si no existe o no se puede leer. */
export type IncludeResolver = (target: string, fromFile: string | undefined) => { file: string; text: string } | undefined;

export interface ParseOptions {
  /** Ruta del archivo que se lee, para que el resolvedor de `!include` pueda resolver rutas relativas. */
  file?: string;
  resolveInclude?: IncludeResolver;
  warn: (message: string) => void;
}

const MAX_BLOCK_DEPTH = 64;
const MAX_INCLUDE_DEPTH = 8;
const MAX_INCLUDES = 200;

type TokKind = 'word' | 'string' | 'lbrace' | 'rbrace' | 'eol';
interface Tok {
  kind: TokKind;
  text: string;
  line: number;
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?=[\s{}"]|$)/y;

const isBreak = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '{' || c === '}' || c === '"';

function tokenize(source: string, loc: (line: number) => string): Tok[] {
  const src = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = true;
  const push = (kind: TokKind, text: string): void => {
    out.push({ kind, text, line });
    lineStart = kind === 'eol';
  };
  const newlines = (from: number, to: number): number => {
    let count = 0;
    for (let k = from; k < to; k += 1) if (src[k] === '\n') count += 1;
    return count;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      push('eol', '\n');
      line += 1;
      i += 1;
    } else if (c === ' ' || c === '\t') {
      i += 1;
    } else if (c === '\\' && /^[ \t]*\n/.test(src.slice(i + 1, i + 40))) {
      // Continuación de línea: la sentencia sigue en la línea siguiente.
      i = src.indexOf('\n', i) + 1;
      line += 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new DslImportError(`${loc(line)}: comentario /* sin cerrar`);
      line += newlines(i, end);
      i = end + 2;
    } else if ((c === '/' && src[i + 1] === '/') || (c === '#' && (lineStart || !isHexColorAt(src, i)))) {
      // Comentario de línea. Un `#` en mitad de una línea solo lo es si no es un color (`background #08427b`).
      while (i < n && src[i] !== '\n') i += 1;
    } else if (c === '{') {
      push('lbrace', c);
      i += 1;
    } else if (c === '}') {
      push('rbrace', c);
      i += 1;
    } else if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new DslImportError(`${loc(line)}: bloque de texto """ sin cerrar`);
        push('string', src.slice(i + 3, end).trim());
        line += newlines(i, end);
        i = end + 3;
      } else {
        let j = i + 1;
        let text = '';
        for (;;) {
          if (j >= n || src[j] === '\n') throw new DslImportError(`${loc(line)}: cadena sin cerrar (falta la comilla de cierre)`);
          if (src[j] === '\\' && (src[j + 1] === '"' || src[j + 1] === '\\')) {
            text += src[j + 1];
            j += 2;
          } else if (src[j] === '"') {
            break;
          } else {
            text += src[j];
            j += 1;
          }
        }
        push('string', text);
        i = j + 1;
      }
    } else {
      let j = i;
      while (j < n && !isBreak(src[j])) j += 1;
      push('word', src.slice(i, j));
      i = j;
    }
  }
  return out;
}

function isHexColorAt(src: string, index: number): boolean {
  HEX_COLOR.lastIndex = index;
  return HEX_COLOR.test(src);
}

const shortName = (file: string): string => file.split(/[\\/]/).pop() || file;

interface ParseContext extends ParseOptions {
  entry?: string;
  includes: { count: number };
}

function parseText(text: string, ctx: ParseContext, depth: number, chain: string[]): DslStatement[] {
  const file = ctx.file;
  const loc = (line: number): string => (file && file !== ctx.entry ? `${shortName(file)}, línea ${line}` : `línea ${line}`);
  const toks = tokenize(text, loc);

  const root: DslStatement[] = [];
  const stack: Array<{ list: DslStatement[]; opener?: DslStatement }> = [{ list: root }];
  let current: DslToken[] = [];
  let currentLine = 0;
  const list = (): DslStatement[] => stack[stack.length - 1].list;

  const include = (st: DslStatement): void => {
    const target = st.tokens[1].text;
    if (!ctx.resolveInclude) {
      ctx.warn(`${st.loc}: !include «${target}» no se puede resolver aquí (el archivo se lee sin acceso a otros archivos); se omite.`);
      return;
    }
    if (depth >= MAX_INCLUDE_DEPTH || ctx.includes.count >= MAX_INCLUDES) {
      ctx.warn(`${st.loc}: demasiados !include anidados; se omite «${target}».`);
      return;
    }
    const resolved = ctx.resolveInclude(target, file);
    if (!resolved) {
      ctx.warn(`${st.loc}: no se pudo leer el !include «${target}» (no existe o está fuera del directorio del archivo); se omite.`);
      return;
    }
    if (chain.includes(resolved.file)) {
      ctx.warn(`${st.loc}: el !include «${target}» se incluye a sí mismo (ciclo); se omite.`);
      return;
    }
    ctx.includes.count += 1;
    list().push(...parseText(resolved.text, { ...ctx, file: resolved.file }, depth + 1, [...chain, resolved.file]));
  };

  const flush = (): void => {
    if (current.length === 0) return;
    const st: DslStatement = { tokens: current, line: currentLine, loc: loc(currentLine) };
    current = [];
    const first = st.tokens[0];
    if (!first.quoted && first.text.toLowerCase() === '!include' && st.tokens.length >= 2) include(st);
    else list().push(st);
  };

  for (const t of toks) {
    if (t.kind === 'eol') {
      flush();
    } else if (t.kind === 'word' || t.kind === 'string') {
      if (current.length === 0) currentLine = t.line;
      current.push({ text: t.text, quoted: t.kind === 'string' });
    } else if (t.kind === 'lbrace') {
      let opener: DslStatement;
      if (current.length > 0) {
        opener = { tokens: current, line: currentLine, loc: loc(currentLine) };
        current = [];
        list().push(opener);
      } else {
        // `{` en su propia línea: abre el bloque de la sentencia anterior.
        const previous = list()[list().length - 1];
        if (previous && !previous.block) {
          opener = previous;
        } else {
          opener = { tokens: [], line: t.line, loc: loc(t.line) };
          list().push(opener);
        }
      }
      opener.block = [];
      stack.push({ list: opener.block, opener });
      if (stack.length > MAX_BLOCK_DEPTH) throw new DslImportError(`${loc(t.line)}: bloques demasiado anidados (más de ${MAX_BLOCK_DEPTH} niveles)`);
    } else {
      flush();
      if (stack.length === 1) throw new DslImportError(`${loc(t.line)}: hay un "}" sin bloque abierto`);
      stack.pop();
    }
  }
  flush();
  if (stack.length > 1) {
    const opener = stack[stack.length - 1].opener!;
    throw new DslImportError(`${opener.loc}: falta cerrar el bloque "{" abierto aquí`);
  }
  return root;
}

/** Lee el texto de un DSL y devuelve sus sentencias de nivel superior, con los `!include` ya sustituidos. */
export function parseDsl(text: string, options: ParseOptions): DslStatement[] {
  return parseText(text, { ...options, entry: options.file, includes: { count: 0 } }, 0, options.file ? [options.file] : []);
}
