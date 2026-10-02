/**
 * Analizador de HCL (el lenguaje de Terraform) pequeño y tolerante. Lee la ESTRUCTURA de un archivo `.tf` (bloques con
 * etiquetas, atributos y bloques anidados) y conserva lo que sirve para reconstruir una arquitectura: los valores literales
 * (cadenas, números, booleanos, listas, mapas, heredocs) y las REFERENCIAS entre bloques (`aws_vpc.main.id`,
 * `module.vpc.private_subnets`, `var.environment`). Las expresiones que no se evalúan (interpolaciones `"${var.x}-api"`,
 * llamadas a funciones, condicionales, `for`) quedan como `HclExpr`: su texto y las referencias que contienen.
 *
 * No pretende cubrir el lenguaje: ante lo que no entiende avisa (`warnings`) y sigue. Solo lanza `HclSyntaxError` cuando la
 * estructura se rompe de verdad (cadena, heredoc o llave sin cerrar), con el número de línea.
 */

export class HclSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'HclSyntaxError';
  }
}

/** Expresión sin evaluar: su texto y las referencias normalizadas que contiene. */
export class HclExpr {
  constructor(
    /** Texto de la expresión tal como está escrito. */
    readonly text: string,
    /** Referencias que contiene: `aws_vpc.main`, `data.aws_ami.x`, `module.vpc.vpc_id`, `var.x`, `local.y`, `terraform.workspace`. */
    readonly refs: string[],
    /** Si es una cadena con interpolaciones: su contenido con las `${…}` sin evaluar. */
    readonly template?: string,
    /** Si es la llamada a una función: su nombre y sus argumentos. */
    readonly call?: { fn: string; args: HclValue[] },
  ) {}
}

export type HclValue = string | number | boolean | null | HclExpr | HclValue[] | { [key: string]: HclValue };

export interface HclBlock {
  type: string;
  labels: string[];
  /** Línea (1-based) donde empieza el bloque. */
  line: number;
  attrs: Record<string, HclValue>;
  blocks: HclBlock[];
}

export interface HclFile {
  /** Bloques de primer nivel (`resource`, `data`, `variable`, `locals`, `module`, `provider`, `terraform`, `output`…). */
  blocks: HclBlock[];
  /** Atributos sueltos de primer nivel (no son HCL de Terraform válido, pero se conservan). */
  attrs: Record<string, HclValue>;
  warnings: string[];
}

export const isExpr = (v: unknown): v is HclExpr => v instanceof HclExpr;

const RESOURCE_TYPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const NOT_REFERENCES = new Set(['each', 'count', 'self', 'path', 'true', 'false', 'null']);

/**
 * Referencia normalizada de una travesía (`['aws_vpc', 'main', 'id']` → `aws_vpc.main`; `['module', 'vpc', 'vpc_id']` →
 * `module.vpc.vpc_id`; `['var', 'x']` → `var.x`), o `undefined` si no apunta a un bloque (`each.value`, `path.module`…).
 */
export function refFromTraversal(segments: string[]): string | undefined {
  const [root, first, second] = segments;
  if (!root || !first || NOT_REFERENCES.has(root)) return undefined;
  if (root === 'var' || root === 'local') return `${root}.${first}`;
  if (root === 'module') return second ? `module.${first}.${second}` : `module.${first}`;
  if (root === 'data') return second ? `data.${first}.${second}` : undefined;
  if (root === 'terraform') return first === 'workspace' ? 'terraform.workspace' : undefined;
  return RESOURCE_TYPE.test(root) ? `${root}.${first}` : undefined;
}

/** Normaliza el texto de una referencia (`aws_subnet.private[0].id`, `module.vpc.vpc_id`) como las que da `refFromTraversal`. */
export function normalizeRef(text: string): string | undefined {
  const segments = text
    .replace(/\[[^\]]*\]/g, '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  return refFromTraversal(segments);
}

/** Todas las referencias de un valor (sin repetir y en orden de aparición). */
export function refsOf(value: HclValue | undefined): string[] {
  const found = new Set<string>();
  const walk = (v: HclValue | undefined): void => {
    if (v === undefined || v === null || typeof v !== 'object') return;
    if (isExpr(v)) {
      for (const r of v.refs) found.add(r);
    } else if (Array.isArray(v)) v.forEach(walk);
    else Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

const isIdentStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_-]/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

type Mode = 'body' | 'object' | 'list' | 'arg';

interface ScanStop {
  newline: boolean;
  comma: boolean;
}

const HEREDOC_START = /<<(-?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/y;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  pos = 0;
  readonly warnings: string[] = [];
  private readonly lineStarts: number[] = [0];

  constructor(private readonly src: string) {
    for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') this.lineStarts.push(i + 1);
  }

  lineAt(pos: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  fail(message: string, pos = this.pos): never {
    throw new HclSyntaxError(message, this.lineAt(pos));
  }

  warn(message: string, pos = this.pos): void {
    this.warnings.push(`línea ${this.lineAt(pos)}: ${message}`);
  }

  // ───────────── texto sin significado ─────────────

  /** Espacios, tabuladores y comentarios, sin pasar de línea. */
  skipSpaces(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') this.pos += 1;
      else if (c === '#' || (c === '/' && this.src[this.pos + 1] === '/')) this.skipToEol();
      else if (c === '/' && this.src[this.pos + 1] === '*') this.skipBlockComment();
      else return;
    }
  }

  /** Como `skipSpaces`, pero también saltos de línea. */
  skipTrivia(): void {
    for (;;) {
      this.skipSpaces();
      if (this.src[this.pos] === '\n') this.pos += 1;
      else return;
    }
  }

  private skipToEol(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
  }

  private skipBlockComment(): void {
    const start = this.pos;
    const end = this.src.indexOf('*/', this.pos + 2);
    if (end < 0) this.fail('comentario /* … */ sin cerrar', start);
    this.pos = end + 2;
  }

  private skipLine(): void {
    this.skipToEol();
  }

  private readIdent(): string {
    const start = this.pos;
    while (isIdentChar(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  // ───────────── cuerpos y bloques ─────────────

  parseBody(closer: boolean, openLine: number): { attrs: Record<string, HclValue>; blocks: HclBlock[] } {
    const attrs: Record<string, HclValue> = {};
    const blocks: HclBlock[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.src.length) {
        if (closer) this.fail(`falta la llave de cierre del bloque abierto en la línea ${openLine}`, this.lineStarts[openLine - 1]);
        return { attrs, blocks };
      }
      const c = this.src[this.pos];
      if (c === '}') {
        this.pos += 1;
        if (closer) return { attrs, blocks };
        this.warn('llave de cierre sin bloque abierto; se omite', this.pos - 1);
        continue;
      }
      if (c === ',') {
        this.pos += 1;
        continue;
      }
      const start = this.pos;
      if (!isIdentStart(c)) {
        this.warn(`no se entiende «${this.snippet(start)}»; se omite la línea`);
        this.skipLine();
        continue;
      }
      const name = this.readIdent();
      this.skipSpaces();
      const next = this.src[this.pos];
      if (next === '=' && this.src[this.pos + 1] !== '=') {
        this.pos += 1;
        attrs[name] = this.parseValue('body');
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        this.skipSpaces();
        const ch = this.src[this.pos];
        if (ch === '"') {
          const label = this.parseQuoted();
          labels.push(typeof label === 'string' ? label : (label.template ?? label.text));
        } else if (isIdentStart(ch)) labels.push(this.readIdent());
        else break;
      }
      if (this.src[this.pos] !== '{') {
        this.warn(`no se entiende «${this.snippet(start)}»; se omite la línea`, start);
        this.skipLine();
        continue;
      }
      const line = this.lineAt(start);
      this.pos += 1;
      const body = this.parseBody(true, line);
      blocks.push({ type: name, labels, line, ...body });
    }
  }

  private snippet(start: number): string {
    const end = this.src.indexOf('\n', start);
    const text = this.src.slice(start, end < 0 ? this.src.length : end).trim();
    return text.length > 50 ? `${text.slice(0, 47)}…` : text;
  }

  // ───────────── valores ─────────────

  parseValue(mode: Mode): HclValue {
    this.skipSpaces();
    const start = this.pos;
    const c = this.src[this.pos];
    let value: HclValue | undefined;
    if (c === '"') value = this.parseQuoted();
    else if (c === '[' && !this.startsFor(this.pos + 1)) value = this.parseList();
    else if (c === '{' && !this.startsFor(this.pos + 1)) value = this.parseObject();
    else if (c === '<' && this.heredocAt(this.pos)) value = this.parseHeredoc();
    else if (c === '-' || isDigit(c)) value = this.tryNumber();
    else if (isIdentStart(c)) value = this.tryKeywordOrCall();
    if (value !== undefined && this.atEnd(mode)) return value;
    this.pos = start;
    return this.parseRaw(mode);
  }

  private startsFor(pos: number): boolean {
    let p = pos;
    while (' \t\r\n'.includes(this.src[p] ?? 'x')) p += 1;
    return this.src.startsWith('for', p) && !isIdentChar(this.src[p + 3]);
  }

  private atEnd(mode: Mode): boolean {
    const multiline = mode === 'list' || mode === 'arg';
    if (multiline) this.skipTrivia();
    else this.skipSpaces();
    const ch = this.src[this.pos];
    return ch === undefined || ch === ',' || ch === '}' || ch === ']' || ch === ')' || (!multiline && ch === '\n');
  }

  private tryNumber(): number | undefined {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.src);
    if (!m || isIdentChar(this.src[this.pos + m[0].length]) || this.src[this.pos + m[0].length] === '.') return undefined;
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private tryKeywordOrCall(): HclValue | undefined {
    const start = this.pos;
    const word = this.readIdent();
    if (this.src[this.pos] === '(') return this.tryCall(word, start);
    if (word === 'true' || word === 'false') return this.src[this.pos] === '.' ? this.giveUp(start) : word === 'true';
    if (word === 'null') return this.src[this.pos] === '.' ? this.giveUp(start) : null;
    return this.giveUp(start);
  }

  private giveUp(start: number): undefined {
    this.pos = start;
    return undefined;
  }

  private tryCall(fn: string, start: number): HclExpr | undefined {
    this.pos += 1; // (
    const args: HclValue[] = [];
    for (;;) {
      this.skipTrivia();
      const ch = this.src[this.pos];
      if (ch === undefined) return this.giveUp(start);
      if (ch === ')') {
        this.pos += 1;
        break;
      }
      args.push(this.parseValue('arg'));
      this.skipTrivia();
      const n = this.src[this.pos];
      if (n === ',') this.pos += 1;
      else if (n !== ')') return this.giveUp(start);
    }
    return new HclExpr(this.src.slice(start, this.pos), refsOf(args), undefined, { fn, args });
  }

  private parseList(): HclValue[] | undefined {
    const start = this.pos;
    this.pos += 1;
    const items: HclValue[] = [];
    for (;;) {
      this.skipTrivia();
      const ch = this.src[this.pos];
      if (ch === undefined) return this.giveUp(start);
      if (ch === ']') {
        this.pos += 1;
        return items;
      }
      items.push(this.parseValue('list'));
      this.skipTrivia();
      const n = this.src[this.pos];
      if (n === ',') this.pos += 1;
      else if (n !== ']') return this.giveUp(start);
    }
  }

  private parseObject(): { [key: string]: HclValue } | undefined {
    const start = this.pos;
    this.pos += 1;
    const entries: { [key: string]: HclValue } = {};
    for (;;) {
      this.skipTrivia();
      while (this.src[this.pos] === ',') {
        this.pos += 1;
        this.skipTrivia();
      }
      const ch = this.src[this.pos];
      if (ch === undefined) return this.giveUp(start);
      if (ch === '}') {
        this.pos += 1;
        return entries;
      }
      let key: string;
      if (ch === '"') {
        const k = this.parseQuoted();
        key = typeof k === 'string' ? k : (k.template ?? k.text);
      } else if (isIdentStart(ch) || isDigit(ch)) key = this.readIdent() || this.readNumberKey();
      else return this.giveUp(start);
      this.skipSpaces();
      const sep = this.src[this.pos];
      if ((sep === '=' && this.src[this.pos + 1] !== '=') || sep === ':') this.pos += 1;
      else return this.giveUp(start);
      entries[key] = this.parseValue('object');
    }
  }

  private readNumberKey(): string {
    const from = this.pos;
    while (isDigit(this.src[this.pos])) this.pos += 1;
    return this.src.slice(from, this.pos);
  }

  // ───────────── cadenas y heredocs ─────────────

  /** `"…"` con sus interpolaciones: una cadena si es literal; si no, una expresión con la plantilla y sus referencias. */
  parseQuoted(): string | HclExpr {
    const start = this.pos;
    this.pos += 1;
    const refs: string[] = [];
    const { text, interpolated } = this.readTemplate('"', true, refs, start);
    this.pos += 1; // comilla de cierre
    return interpolated ? new HclExpr(this.src.slice(start, this.pos), refs, text) : text;
  }

  /** Lee texto con plantillas hasta `until` (sin consumirlo) o hasta el final; recoge las referencias de las `${…}` y `%{…}`. */
  readTemplate(until: '"' | undefined, escapes: boolean, refs: string[], openedAt: number): { text: string; interpolated: boolean } {
    let text = '';
    let interpolated = false;
    for (;;) {
      if (this.pos >= this.src.length) {
        if (until) this.fail('cadena sin cerrar', openedAt);
        return { text, interpolated };
      }
      const c = this.src[this.pos];
      if (until && c === until) return { text, interpolated };
      if (until && c === '\n') this.fail('cadena sin cerrar', openedAt);
      if (escapes && c === '\\') {
        text += this.readEscape();
        continue;
      }
      if ((c === '$' || c === '%') && this.src[this.pos + 1] === c && this.src[this.pos + 2] === '{') {
        text += `${c}{`;
        this.pos += 3;
        continue;
      }
      if ((c === '$' || c === '%') && this.src[this.pos + 1] === '{') {
        interpolated = true;
        const from = this.pos;
        this.pos += 2;
        this.scan(refs, { newline: false, comma: false });
        if (this.src[this.pos] !== '}') this.fail('interpolación ${…} sin cerrar', from);
        this.pos += 1;
        text += this.src.slice(from, this.pos);
        continue;
      }
      text += c;
      this.pos += 1;
    }
  }

  private readEscape(): string {
    const next = this.src[this.pos + 1];
    this.pos += 2;
    switch (next) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
      case 'U': {
        const len = next === 'u' ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + len);
        if (new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) {
          this.pos += len;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        return next;
      }
      default:
        return next ?? '';
    }
  }

  private heredocAt(pos: number): boolean {
    HEREDOC_START.lastIndex = pos;
    return HEREDOC_START.test(this.src);
  }

  /** Cuerpo de un heredoc (`<<EOT … EOT`, `<<-EOT` quita la sangría común); deja la posición al final de la línea del delimitador. */
  private parseHeredoc(): string | HclExpr {
    const { raw, text, refs, interpolated } = this.readHeredoc();
    return interpolated ? new HclExpr(raw, refs, text) : text;
  }

  private readHeredoc(): { raw: string; text: string; refs: string[]; interpolated: boolean } {
    const start = this.pos;
    HEREDOC_START.lastIndex = start;
    const m = HEREDOC_START.exec(this.src)!;
    const [header, dash, delimiter] = m;
    const bodyStart = start + header.length;
    let lineStart = bodyStart;
    let bodyEnd = -1;
    let end = -1;
    while (lineStart <= this.src.length) {
      const nl = this.src.indexOf('\n', lineStart);
      const lineEnd = nl < 0 ? this.src.length : nl;
      if (this.src.slice(lineStart, lineEnd).trim() === delimiter) {
        bodyEnd = lineStart;
        end = lineEnd;
        break;
      }
      if (nl < 0) break;
      lineStart = nl + 1;
    }
    if (end < 0) this.fail(`heredoc <<${delimiter} sin cerrar`, start);
    let body = this.src.slice(bodyStart, bodyEnd);
    if (dash) {
      const lines = body.split('\n');
      const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length);
      const strip = indents.length > 0 ? Math.min(...indents) : 0;
      body = lines.map((l) => l.slice(Math.min(strip, /^[ \t]*/.exec(l)![0].length))).join('\n');
    }
    const sub = new Parser(body);
    const refs: string[] = [];
    const { text, interpolated } = sub.readTemplate(undefined, false, refs, 0);
    this.pos = end;
    return { raw: this.src.slice(start, end), text, refs, interpolated };
  }

  // ───────────── expresiones sin estructura ─────────────

  /** Expresión que no se descompone (operadores, condicionales, `for`, travesías…): su texto y sus referencias. */
  parseRaw(mode: Mode): HclExpr {
    const start = this.pos;
    const refs: string[] = [];
    this.scan(refs, { newline: mode === 'body' || mode === 'object', comma: true });
    return new HclExpr(this.src.slice(start, this.pos).trim(), refs);
  }

  /**
   * Avanza por una expresión hasta un terminador de primer nivel (cierre de llave, corchete o paréntesis sin abrir; coma o
   * salto de línea si se pide) sin consumirlo, recogiendo las referencias. Las cadenas, los heredocs y los comentarios se
   * saltan enteros.
   */
  private scan(refs: string[], stop: ScanStop): void {
    let depth = 0;
    const brackets: Array<{ ch: string; at: number }> = [];
    for (;;) {
      if (this.pos >= this.src.length) {
        if (depth > 0) this.fail(`falta cerrar «${brackets[brackets.length - 1].ch}» abierto en la línea ${this.lineAt(brackets[brackets.length - 1].at)}`, brackets[brackets.length - 1].at);
        return;
      }
      const c = this.src[this.pos];
      if (c === '"') {
        const from = this.pos;
        this.pos += 1;
        this.readTemplate('"', true, refs, from);
        this.pos += 1;
      } else if (c === '<' && this.src[this.pos + 1] === '<' && this.heredocAt(this.pos)) {
        const heredoc = this.readHeredoc();
        for (const r of heredoc.refs) if (!refs.includes(r)) refs.push(r);
      } else if (c === '#' || (c === '/' && this.src[this.pos + 1] === '/')) this.skipToEol();
      else if (c === '/' && this.src[this.pos + 1] === '*') this.skipBlockComment();
      else if (c === '(' || c === '[' || c === '{') {
        brackets.push({ ch: c, at: this.pos });
        depth += 1;
        this.pos += 1;
      } else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return;
        depth -= 1;
        brackets.pop();
        this.pos += 1;
      } else if (c === '\n') {
        if (depth === 0 && stop.newline) return;
        this.pos += 1;
      } else if (c === ',' && depth === 0 && stop.comma) return;
      else if (isIdentStart(c) && !isIdentChar(this.src[this.pos - 1]) && this.src[this.pos - 1] !== '.') this.scanTraversal(refs);
      else if (isIdentStart(c)) this.skipWord();
      else this.pos += 1;
    }
  }

  private skipWord(): void {
    while (isIdentChar(this.src[this.pos])) this.pos += 1;
  }

  /** Lee `a.b.c` desde un identificador y apunta la referencia si es de un bloque (no consume los `[…]`: el bucle los recorre). */
  private scanTraversal(refs: string[]): void {
    const segments = [this.readIdent()];
    while (this.src[this.pos] === '.' && (isIdentStart(this.src[this.pos + 1]) || isDigit(this.src[this.pos + 1]))) {
      this.pos += 1;
      const seg = isDigit(this.src[this.pos]) ? this.readNumberKey() : this.readIdent();
      segments.push(seg);
    }
    const ref = refFromTraversal(segments);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
}

/** Analiza un archivo HCL. Lanza `HclSyntaxError` si la estructura está rota (llave, cadena o heredoc sin cerrar). */
export function parseHcl(source: string): HclFile {
  const parser = new Parser(source.replace(/^﻿/, ''));
  const { attrs, blocks } = parser.parseBody(false, 1);
  return { blocks, attrs, warnings: parser.warnings };
}

/**
 * Cadena de un JSON de Terraform (`.tf.json`): los valores son plantillas, así que una `${aws_vpc.main.id}` es una referencia.
 * Devuelve la cadena tal cual si no interpola.
 */
export function parseTemplateString(value: string): string | HclExpr {
  if (!value.includes('${') && !value.includes('%{')) return value;
  try {
    const parser = new Parser(value);
    const refs: string[] = [];
    const { text, interpolated } = parser.readTemplate(undefined, false, refs, 0);
    return interpolated ? new HclExpr(value, refs, text) : text;
  } catch {
    return value;
  }
}
