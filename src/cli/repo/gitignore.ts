/**
 * Un intérprete mínimo de `.gitignore` (sin dependencias y sin lanzar `git`: el escáner no ejecuta nunca nada del
 * repositorio que lee). Cubre lo que usan los proyectos reales: comentarios, `!` de negación, `/` inicial o intermedio que
 * ancla el patrón, `/` final que limita a carpetas, `*`, `?`, `[…]` y `**`. La última regla que coincide manda, y las de las
 * carpetas más profundas se añaden después, así que pueden anular a las de arriba (como hace git).
 *
 * SIN EXPRESIONES REGULARES para casar: un `.gitignore` es texto de quien escribió el repositorio (y, con `--from-repo <url>`,
 * de un tercero), y traducir `*a*a*a…b` a una regex hace que el motor retroceda de forma exponencial y cuelgue el comando.
 * Aquí cada patrón se parte en tramos (los separados por `/`); un tramo se casa con el algoritmo clásico de comodines de dos
 * punteros (un solo punto de retroceso: O(n·m), nunca exponencial) y la lista de tramos con el mismo algoritmo, tomando
 * `**` como el comodín de tramos. Un patrón de miles de `*a` contra miles de `a` responde en milisegundos.
 *
 * Diferencias deliberadas con la traducción a regex que había antes (a favor de lo que hace git): una clase `[…]` nunca casa
 * con `/` (`[!b]` tampoco), `\` dentro de una clase escapa el carácter siguiente, un `]` justo tras `[` o `[!` es un
 * miembro más y los rangos invertidos (`[z-a]`) no casan nada en vez de descartar la regla entera.
 */

/** Una línea más larga que esto no es un patrón de verdad: se descarta (acota el coste de un `.gitignore` hostil). */
const MAX_PATTERN_CHARS = 1024;
/** Reglas que se leen como mucho entre todos los `.gitignore` de un recorrido. */
const MAX_RULES = 5000;

type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'set'; negate: boolean; singles: string[]; ranges: Array<[number, number]> };

/** Un tramo del patrón (entre barras) o un comodín de tramos. */
type Segment =
  /** `**` entre barras o al principio: cero o más carpetas. */
  | { kind: 'globstar' }
  /** `**` al final: todo lo de dentro (al menos un tramo). */
  | { kind: 'tail' }
  /** Un tramo normal; `literal` es su texto si no tiene comodines. */
  | { kind: 'segment'; tokens: Token[]; literal?: string };

interface Rule {
  /** Carpeta del `.gitignore` respecto a la raíz (cada tramo literal), `[]` en la raíz. */
  base: string[];
  segments: Segment[];
  negate: boolean;
  dirOnly: boolean;
}

/** Interpreta una clase `[…]` que empieza en `chars[start]`; `undefined` si no está cerrada (entonces `[` es un literal). */
function parseClass(chars: string[], start: number): { token: Token; end: number } | undefined {
  let j = start + 1;
  let negate = false;
  if (chars[j] === '!' || chars[j] === '^') {
    negate = true;
    j += 1;
  }
  const singles: string[] = [];
  const ranges: Array<[number, number]> = [];
  let first = true;
  while (j < chars.length) {
    let ch = chars[j];
    if (ch === ']' && !first) return { token: { kind: 'set', negate, singles, ranges }, end: j };
    first = false;
    if (ch === '\\' && j + 1 < chars.length) {
      ch = chars[j + 1];
      j += 2;
    } else j += 1;
    if (chars[j] === '-' && j + 1 < chars.length && chars[j + 1] !== ']') {
      let hi = chars[j + 1];
      j += 2;
      if (hi === '\\' && j < chars.length) {
        hi = chars[j];
        j += 1;
      }
      ranges.push([ch.codePointAt(0)!, hi.codePointAt(0)!]);
    } else singles.push(ch);
  }
  return undefined;
}

/** Los tokens de un tramo (sin `/`). Varios `*` seguidos valen uno. */
function tokenize(text: string): Token[] {
  const chars = Array.from(text);
  const tokens: Token[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\\' && i + 1 < chars.length) {
      i += 1;
      tokens.push({ kind: 'lit', ch: chars[i] });
    } else if (ch === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (ch === '?') tokens.push({ kind: 'any' });
    else if (ch === '[') {
      const parsed = parseClass(chars, i);
      if (parsed) {
        tokens.push(parsed.token);
        i = parsed.end;
      } else tokens.push({ kind: 'lit', ch });
    } else tokens.push({ kind: 'lit', ch });
  }
  return tokens;
}

function buildSegment(text: string, last: boolean): Segment {
  // `**` solo es un comodín de tramos si ocupa el tramo entero; pegado a otra cosa vale como un `*`.
  if (text === '**') return last ? { kind: 'tail' } : { kind: 'globstar' };
  const tokens = tokenize(text);
  const literal = tokens.every((t) => t.kind === 'lit') ? tokens.map((t) => (t as { ch: string }).ch).join('') : undefined;
  return { kind: 'segment', tokens, ...(literal !== undefined ? { literal } : {}) };
}

function tokenMatches(token: Token, ch: string): boolean {
  switch (token.kind) {
    case 'lit':
      return token.ch === ch;
    case 'any':
      return true;
    case 'set': {
      const code = ch.codePointAt(0)!;
      const inside = token.singles.includes(ch) || token.ranges.some(([lo, hi]) => code >= lo && code <= hi);
      return inside !== token.negate;
    }
    default:
      return false;
  }
}

/** Casa el nombre de UN tramo del camino con los tokens de un tramo del patrón (comodines de dos punteros). */
function matchSegment(segment: Extract<Segment, { kind: 'segment' }>, name: string): boolean {
  if (segment.literal !== undefined) return segment.literal === name;
  const text = Array.from(name);
  const { tokens } = segment;
  let t = 0;
  let n = 0;
  let starAt = -1;
  let starText = 0;
  while (n < text.length) {
    const token = tokens[t];
    if (token?.kind === 'star') {
      starAt = t;
      t += 1;
      starText = n;
    } else if (token && tokenMatches(token, text[n])) {
      t += 1;
      n += 1;
    } else if (starAt >= 0) {
      // Retrocede: el último `*` se come un carácter más.
      t = starAt + 1;
      starText += 1;
      n = starText;
    } else return false;
  }
  while (tokens[t]?.kind === 'star') t += 1;
  return t === tokens.length;
}

/** Casa los tramos del camino (desde `from`) con los del patrón; `**` es el comodín de tramos. */
function matchSegments(segments: Segment[], parts: string[], from: number): boolean {
  let s = 0;
  let p = from;
  let globAt = -1;
  let globPart = from;
  while (p < parts.length) {
    const seg = segments[s];
    if (seg?.kind === 'globstar') {
      globAt = s;
      s += 1;
      globPart = p;
    } else if (seg?.kind === 'tail') {
      return true; // `**` final: lo que quede (al menos un tramo, que es lo que hay en este punto)
    } else if (seg?.kind === 'segment' && matchSegment(seg, parts[p])) {
      s += 1;
      p += 1;
    } else if (globAt >= 0) {
      s = globAt + 1;
      globPart += 1;
      p = globPart;
    } else return false;
  }
  while (segments[s]?.kind === 'globstar') s += 1;
  return s === segments.length;
}

function matchRule(rule: Rule, parts: string[]): boolean {
  const { base } = rule;
  // Las reglas de una carpeta solo valen para lo que hay dentro de ella (y no para la carpeta misma).
  if (parts.length <= base.length) return false;
  for (let i = 0; i < base.length; i += 1) if (parts[i] !== base[i]) return false;
  return matchSegments(rule.segments, parts, base.length);
}

/** Quita los espacios del final salvo los escapados con `\` (`nombre\ ` conserva su espacio). */
function trimTrailingSpace(line: string): string {
  let end = line.length;
  while (end > 0 && /\s/.test(line[end - 1]) && !(end >= 2 && line[end - 2] === '\\')) end -= 1;
  return line.slice(0, end);
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  /**
   * Añade las reglas de un `.gitignore` (o de `.git/info/exclude`). `base` es la carpeta del archivo respecto a la raíz
   * del repositorio, con `/` y sin barra final (`''` para la raíz).
   */
  add(content: string, base: string): void {
    const baseParts = base ? base.split('/') : [];
    for (const raw of content.split(/\r?\n/)) {
      if (this.rules.length >= MAX_RULES) return;
      if (raw.length > MAX_PATTERN_CHARS) continue;
      let line = trimTrailingSpace(raw);
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
      let dirOnly = false;
      let end = line.length;
      while (end > 0 && line[end - 1] === '/') end -= 1;
      if (end < line.length) {
        dirOnly = true;
        line = line.slice(0, end);
      }
      if (!line) continue;
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      const texts = line.split('/');
      const segments: Segment[] = texts.map((text, i) => buildSegment(text, i === texts.length - 1));
      // Sin barra en medio el patrón vale en cualquier profundidad: es como tener delante un `**/`.
      if (!anchored) segments.unshift({ kind: 'globstar' });
      this.rules.push({ base: baseParts, segments, negate, dirOnly });
    }
  }

  /** ¿Está ignorada esta ruta (relativa a la raíz del repositorio, con `/`)? */
  ignores(path: string, isDir: boolean): boolean {
    const parts = path.split('/');
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (matchRule(rule, parts)) ignored = !rule.negate;
    }
    return ignored;
  }
}
