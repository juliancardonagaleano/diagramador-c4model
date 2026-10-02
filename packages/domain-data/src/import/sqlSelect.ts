import { closeOf, isName, isP, isW, readName, splitTop, type Tok } from './sqlTokens';

/** Tabla leída en un `FROM` o `JOIN`: nombre calificado y alias, si lo tiene. */
export interface TableRef {
  parts: string[];
  alias?: string;
  line: number;
}

export interface SelectInfo {
  refs: TableRef[];
  /** Si el SELECT es un único bloque sin CTE, UNION, subconsultas ni funciones de tabla, se puede seguir el linaje de sus columnas. */
  simple: boolean;
  /** Elementos de la lista del SELECT más externo (el primero, si hay UNION). */
  items: Tok[][];
  /** Por qué no se puede deducir el linaje, si no se puede. */
  problem?: string;
}

/** Palabras que, tras un nombre de tabla, no son su alias. */
const NOT_ALIAS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL',
  'JOIN', 'ON', 'USING', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR', 'TABLESAMPLE', 'SAMPLE', 'PIVOT', 'UNPIVOT', 'WITH', 'OUTER', 'LATERAL', 'STRAIGHT_JOIN',
  'USE', 'IGNORE', 'FORCE', 'PARTITION', 'AT', 'BEFORE', 'SET', 'SELECT', 'CONNECT', 'START', 'OPTION', 'RETURNING', 'INTO', 'MATCH_RECOGNIZE',
]);

/** Funciones cuyos paréntesis llevan un `FROM` que no es de tablas: `EXTRACT(year FROM f)`, `SUBSTRING(x FROM 2)`, `TRIM(BOTH ' ' FROM x)`. */
const FROM_IN_FUNCTION = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION']);
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);

/**
 * Tablas que lee un SELECT (o una consulta con CTE): las de cada `FROM` y `JOIN`, a cualquier nivel, sin contar los CTE.
 * Es un análisis léxico, no una validación de SQL: sirve para el linaje a nivel de tabla.
 */
export function analyzeSelect(toks: Tok[]): SelectInfo {
  const refs: TableRef[] = [];
  const ctes = new Set<string>();
  let selects = 0;
  let setOperators = false;
  let usesFunction = false;
  let firstFrom = -1;
  let firstSelect = -1;
  let broken = false;

  let start = 0;
  while (isP(toks[start], '(')) start += 1;
  if (!isW(toks[start], 'SELECT', 'WITH', 'VALUES')) {
    return { refs, simple: false, items: [], problem: `el cuerpo no empieza por SELECT («${toks[start]?.v ?? ''}»)` };
  }

  // Nombres de los CTE (`WITH a AS (...), b (x, y) AS (...)`): lo que leen se cuenta; ellos, no.
  toks.forEach((t, w) => {
    if (!isW(t, 'WITH')) return;
    let j = w + 1;
    if (isW(toks[j], 'RECURSIVE')) j += 1;
    while (isName(toks[j])) {
      const name = toks[j].v.toLowerCase();
      let k = j + 1;
      if (isP(toks[k], '(')) k = closeOf(toks, k) + 1;
      if (k <= 0 || !isW(toks[k], 'AS')) break;
      ctes.add(name);
      k += 1;
      if (isW(toks[k], 'NOT')) k += 1;
      if (isW(toks[k], 'MATERIALIZED')) k += 1;
      if (!isP(toks[k], '(')) break;
      const end = closeOf(toks, k);
      if (end < 0 || !isP(toks[end + 1], ',')) break;
      j = end + 2;
    }
  });

  const readRefs = (from: number, list: boolean): number => {
    let j = from;
    for (;;) {
      while (isW(toks[j], 'LATERAL', 'ONLY')) j += 1;
      if (isP(toks[j], '(')) {
        // Subconsulta (se analiza al seguir el recorrido) o JOIN entre paréntesis: `FROM (a JOIN b ON ...)`.
        const inner = toks[j + 1];
        if (inner && (inner.k === 'qid' || isP(inner, '(') || (inner.k === 'word' && !['SELECT', 'WITH', 'VALUES'].includes(inner.u)))) readRefs(j + 1, false);
        return j;
      }
      const name = readName(toks, j);
      if (!name) return j;
      j = name.next;
      if (isP(toks[j], '(')) {
        usesFunction = true;
        return j;
      }
      let alias: string | undefined;
      if (isW(toks[j], 'AS')) {
        j += 1;
        if (isName(toks[j])) {
          alias = toks[j].v;
          j += 1;
        }
      } else if (isName(toks[j]) && !(toks[j].k === 'word' && NOT_ALIAS.has(toks[j].u))) {
        alias = toks[j].v;
        j += 1;
      }
      if (alias && isP(toks[j], '(')) j = Math.max(j, closeOf(toks, j)) + 1; // alias(col1, col2)
      if (!(name.parts.length === 1 && ctes.has(name.parts[0].toLowerCase()))) refs.push({ parts: name.parts, alias, line: name.line });
      if (list && isP(toks[j], ',')) {
        j += 1;
        continue;
      }
      return j;
    }
  };

  const stack: boolean[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (isP(t, '(')) {
      stack.push(toks[i - 1]?.k === 'word' && FROM_IN_FUNCTION.has(toks[i - 1].u));
    } else if (isP(t, ')')) {
      if (stack.length === 0) broken = true;
      stack.pop();
    } else if (t.k === 'word') {
      if (t.u === 'SELECT') {
        selects += 1;
        if (firstSelect < 0 && stack.length === start) firstSelect = i;
      } else if (SET_OPERATORS.has(t.u)) setOperators = true;
      else if (t.u === 'FROM' || t.u === 'JOIN') {
        if (stack[stack.length - 1] || (t.u === 'FROM' && isW(toks[i - 1], 'DISTINCT'))) continue;
        if (t.u === 'FROM' && firstFrom < 0 && firstSelect >= 0 && stack.length === start) firstFrom = i;
        i = readRefs(i + 1, t.u === 'FROM') - 1;
      }
    }
  }
  if (stack.length > 0) broken = true;

  if (broken) return { refs, simple: false, items: [], problem: 'los paréntesis del SELECT no cuadran' };
  if (refs.length === 0) return { refs, simple: false, items: [], problem: usesFunction ? 'solo lee funciones de tabla' : 'no lee ninguna tabla' };
  const simple = selects === 1 && !setOperators && ctes.size === 0 && !usesFunction;
  let items: Tok[][] = [];
  if (firstSelect >= 0 && firstFrom > firstSelect) {
    let s = firstSelect + 1;
    while (isW(toks[s], 'DISTINCT', 'ALL')) s += 1;
    if (isW(toks[s], 'TOP')) s += isP(toks[s + 1], '(') ? closeOf(toks, s + 1) - s + 1 : 2;
    items = splitTop(toks.slice(s, firstFrom));
  }
  return { refs, simple, items };
}
