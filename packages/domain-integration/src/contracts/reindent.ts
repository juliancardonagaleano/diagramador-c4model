import { stripBom } from './json';

export interface SourceSyntax {
  lineComment: string;
  blockComment?: readonly [string, string];
  blockString?: string;
  quotes: string;
}

export const PROTO_SYNTAX: SourceSyntax = { lineComment: '//', blockComment: ['/*', '*/'], quotes: '"\'' };
export const GRAPHQL_SYNTAX: SourceSyntax = { lineComment: '#', blockString: '"""', quotes: '"' };

export interface SourceProblem {
  message: string;
  line: number;
  column: number;
}

interface Bracket {
  char: string;
  column: number;
}

interface LineScan {
  /** Cierre pendiente de un comentario o cadena de bloque que sigue abierto al terminar la línea. */
  closer: string | null;
  brackets: Bracket[];
  /** Columna (desde 1) donde empieza el bloque que queda abierto, si empezó en esta línea. */
  blockStart?: number;
  unterminatedString?: number;
}

const OPENERS = '{([';
const CLOSERS = '})]';
const PAIRS: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

function scanLine(line: string, startCloser: string | null, syntax: SourceSyntax): LineScan {
  const brackets: Bracket[] = [];
  let closer = startCloser;
  let blockStart: number | undefined;
  let i = 0;
  while (i < line.length) {
    if (closer !== null) {
      const end = line.indexOf(closer, i);
      if (end === -1) return { closer, brackets, blockStart };
      i = end + closer.length;
      closer = null;
      blockStart = undefined;
      continue;
    }
    if (line.startsWith(syntax.lineComment, i)) break;
    if (syntax.blockComment && line.startsWith(syntax.blockComment[0], i)) {
      closer = syntax.blockComment[1];
      blockStart = i + 1;
      i += syntax.blockComment[0].length;
      continue;
    }
    if (syntax.blockString && line.startsWith(syntax.blockString, i)) {
      closer = syntax.blockString;
      blockStart = i + 1;
      i += syntax.blockString.length;
      continue;
    }
    const char = line[i];
    if (syntax.quotes.includes(char)) {
      let j = i + 1;
      while (j < line.length && line[j] !== char) j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) return { closer, brackets, unterminatedString: i + 1 };
      i = j + 1;
      continue;
    }
    if (OPENERS.includes(char) || CLOSERS.includes(char)) brackets.push({ char, column: i + 1 });
    i++;
  }
  return { closer, brackets, blockStart };
}

function normalizeLines(text: string): string[] {
  return stripBom(text).replace(/\r\n?/g, '\n').split('\n');
}

/** Llaves, paréntesis y corchetes sin pareja, y cadenas o comentarios sin cerrar; ignora lo que va dentro de cadenas y comentarios. */
export function checkBrackets(text: string, syntax: SourceSyntax): SourceProblem[] {
  const problems: SourceProblem[] = [];
  const stack: Array<Bracket & { line: number }> = [];
  let closer: string | null = null;
  let blockOpen: { line: number; column: number } | undefined;

  const lines = normalizeLines(text);
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const scan = scanLine(lines[index], closer, syntax);
    if (scan.blockStart !== undefined) blockOpen = { line, column: scan.blockStart };
    closer = scan.closer;
    if (scan.unterminatedString !== undefined) problems.push({ message: 'Cadena sin cerrar: falta la comilla de cierre.', line, column: scan.unterminatedString });
    for (const bracket of scan.brackets) {
      if (OPENERS.includes(bracket.char)) {
        stack.push({ ...bracket, line });
        continue;
      }
      const top = stack.pop();
      if (!top) problems.push({ message: `Cierre «${bracket.char}» sin su apertura.`, line, column: bracket.column });
      else if (top.char !== PAIRS[bracket.char]) {
        const expected = CLOSERS[OPENERS.indexOf(top.char)];
        problems.push({ message: `Se esperaba «${expected}» para cerrar la «${top.char}» de la línea ${top.line} y se encontró «${bracket.char}».`, line, column: bracket.column });
      }
    }
  }

  if (closer !== null && blockOpen) problems.push({ message: 'Comentario o cadena de bloque sin cerrar.', ...blockOpen });
  for (const open of stack) problems.push({ message: `La «${open.char}» abierta aquí no se cierra.`, line: open.line, column: open.column });
  return problems.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Sangra por profundidad de llaves, paréntesis y corchetes (2 espacios), quita los espacios finales, deja como mucho una
 * línea en blanco seguida y termina con un salto de línea. El interior de los comentarios y cadenas de bloque no se toca.
 */
export function reindent(text: string, syntax: SourceSyntax): string {
  const out: string[] = [];
  let depth = 0;
  let closer: string | null = null;
  let lastBlank = true;

  for (const raw of normalizeLines(text)) {
    const trimmed = raw.trim();
    if (closer !== null) {
      const insideComment = closer === syntax.blockComment?.[1];
      const scan = scanLine(raw, closer, syntax);
      out.push(trimmed === '' ? '' : insideComment && trimmed.startsWith('*') ? `${' '.repeat(depth * 2 + 1)}${trimmed}` : raw.trimEnd());
      lastBlank = trimmed === '';
      closer = scan.closer;
      depth = nextDepth(depth, scan.brackets);
      continue;
    }
    if (trimmed === '') {
      if (!lastBlank) out.push('');
      lastBlank = true;
      continue;
    }
    const scan = scanLine(trimmed, null, syntax);
    let leading = 0;
    while (leading < trimmed.length && CLOSERS.includes(trimmed[leading])) leading++;
    out.push(`${' '.repeat(Math.max(0, depth - leading) * 2)}${trimmed}`);
    lastBlank = false;
    closer = scan.closer;
    depth = nextDepth(depth, scan.brackets);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

function nextDepth(depth: number, brackets: Bracket[]): number {
  let next = depth;
  for (const bracket of brackets) next = Math.max(0, next + (OPENERS.includes(bracket.char) ? 1 : -1));
  return next;
}
