import type { DiffSpec } from '../module/types';

/**
 * Comparación estructural de dos versiones de un documento de cualquier módulo (`diffDocuments`). No conoce las
 * especialidades: recorre los dos JSON, empareja por `id` (o, si no lo hay, por `name`) las listas de objetos —nodos,
 * relaciones, vistas, activos, amenazas…, a cualquier profundidad— y compara el resto campo a campo. Sin DOM ni Node: sirve
 * igual en el CLI, en el servicio HTTP y en el banco de trabajo del navegador.
 *
 * Qué cuenta como cambio:
 *  - un elemento cuyo `id` ya no está es un quitado y uno cuyo `id` es nuevo, un añadido (renombrar un `id` es quitar +
 *    añadir; cambiar un `name` es una modificación);
 *  - la maquetación y los datos derivados que declara el módulo (`DiffSpec.ignore`: coordenadas, tamaños y rutas guardadas
 *    de las vistas…) NO cuentan: es como si no estuvieran en el documento;
 *  - cambiar solo el ORDEN de una lista no es un cambio: se anota como `moved` (informativo, no suma al total). Las listas
 *    cuyo orden es contenido las declara el módulo (`DiffSpec.ordered`: pasos de un flujo, etapas…): ahí un reordenamiento
 *    sí cuenta (como modificación, con el campo `(posición)`);
 *  - una lista de valores (`tags`, `inputs`…) se compara como conjunto: `added`/`removed` dicen qué entró y qué salió.
 */

export type DiffOptions = DiffSpec;

/** Un campo que cambió dentro de un elemento. Si falta `before` el campo no existía; si falta `after`, desapareció. */
export interface FieldChange {
  /** Ruta del campo dentro del elemento: `name`, `slo.availability`, `tags`, `(posición)`. */
  path: string;
  before?: unknown;
  after?: unknown;
  /** En una lista de valores: los que entraron. */
  added?: unknown[];
  /** En una lista de valores: los que salieron. */
  removed?: unknown[];
}

export interface DiffEntry {
  /**
   * Lista donde vive el elemento: `model.elements`, `nodes`, `assets`… y, si cuelga de otro elemento, `views[ctx].elements`.
   * Los campos sueltos del documento (`version`, `workspace.name`…) se agrupan en `documento`.
   */
  collection: string;
  /** Id del elemento en su lista. En una lista sin ids ni nombres, la posición (`#2`). */
  id: string;
  /** Texto legible: su `name`, `title` o `label`; «origen → destino» en las relaciones; si no, el id. */
  label: string;
  /** Su `kind` o `type`, si lo tiene (`container`, `table`…). */
  kind?: string;
}

export interface ChangedEntry extends DiffEntry {
  fields: FieldChange[];
}

/** Un elemento que cambió de sitio en su lista (sus posiciones empiezan en 1). */
export interface MovedEntry extends DiffEntry {
  from: number;
  to: number;
}

export interface CollectionSummary {
  added: number;
  removed: number;
  changed: number;
  moved: number;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  /** Elementos reordenados sin más cambio: informativo, no entra en `total`. */
  moved: number;
  /** Campos modificados, sumados en todos los elementos modificados. */
  fields: number;
  /** `added + removed + changed`: 0 si los dos documentos tienen el mismo contenido. */
  total: number;
  /** Conteos por lista, en el orden del documento. */
  byCollection: Record<string, CollectionSummary>;
}

export interface DocumentDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: ChangedEntry[];
  moved: MovedEntry[];
  summary: DiffSummary;
}

/** Nombre del grupo de los campos sueltos del documento (la versión, el nombre del workspace…). */
export const ROOT_COLLECTION = 'documento';
const ROOT_ID = 'documento';
const POSITION_FIELD = '(posición)';

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPrimitive = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const definedKeys = (obj: Obj): string[] => Object.keys(obj).filter((k) => obj[k] !== undefined);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = definedKeys(a);
    return keys.length === definedKeys(b).length && keys.every((k) => equal(a[k], b[k]));
  }
  return false;
}

/** Forma canónica (claves ordenadas) para emparejar por igualdad exacta sin comparar todos con todos. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (isObject(value)) {
    return `{${definedKeys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const isEmptyContainer = (value: unknown): boolean => (Array.isArray(value) && value.length === 0) || (isObject(value) && definedKeys(value).length === 0);

/** El documento sin lo ignorado: así la igualdad, el emparejado y los conteos no ven nunca la maquetación. */
function strip(value: unknown, path: string, ignore: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, path, ignore));
  if (!isObject(value)) return value;
  const out: Obj = {};
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    const here = path ? `${path}.${key}` : key;
    if (ignore.some((i) => here === i || here.startsWith(`${i}.`))) continue;
    out[key] = strip(value[key], here, ignore);
  }
  return out;
}

// ───────────── etiquetas ─────────────

/** Texto corto de un valor, para etiquetar elementos sin nombre (`a · x → b · y`). */
function brief(value: unknown): string {
  if (isObject(value)) return labelOf(value, '…');
  if (Array.isArray(value)) return `[${value.map(brief).join(', ')}]`;
  return String(value);
}

/** Etiqueta legible de un elemento: `name`/`title`/`label`, «origen → destino», su id o, a falta de todo, sus primeros valores. */
export function labelOf(item: Obj, fallback: string): string {
  for (const key of ['name', 'title', 'label']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (typeof item.sourceId === 'string' && typeof item.targetId === 'string') return `${item.sourceId} → ${item.targetId}`;
  if (item.from !== undefined && item.to !== undefined) return `${brief(item.from)} → ${brief(item.to)}`;
  if (typeof item.id === 'string' || typeof item.id === 'number') return String(item.id);
  const scalars = Object.values(item)
    .filter((v) => isPrimitive(v) && v !== null)
    .slice(0, 2)
    .map(String);
  return scalars.length > 0 ? scalars.join(' · ') : fallback;
}

const kindOf = (item: Obj): string | undefined => (typeof item.kind === 'string' ? item.kind : typeof item.type === 'string' ? item.type : undefined);

// ───────────── subsecuencia creciente más larga (reordenamientos) ─────────────

/** Índices de `seq` que forman una subsecuencia creciente más larga: lo que NO está en ella es lo que se movió. */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(seq.length).fill(-1);
  seq.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) keep.add(i);
  return keep;
}

// ───────────── la comparación ─────────────

interface Scope {
  collection: string;
  id: string;
  /** El documento mismo: sus listas se nombran por su ruta, sin `documento[…]` delante. */
  root?: boolean;
  fields: FieldChange[];
}

/** Clave con la que se emparejan los elementos de dos listas: `id` o, a falta de él, `name` (las columnas de una tabla). */
function matchKey(before: Obj[], after: Obj[]): string | undefined {
  const usable = (list: Obj[], key: string): boolean => {
    const seen = new Set<string>();
    return list.every((item) => {
      const value = item[key];
      if ((typeof value !== 'string' || !value) && typeof value !== 'number') return false;
      if (seen.has(String(value))) return false;
      seen.add(String(value));
      return true;
    });
  };
  return ['id', 'name'].find((key) => usable(before, key) && usable(after, key));
}

/** Cuántos campos tienen igual valor en los dos objetos, y cuántos distintos hay entre los dos. */
function similarity(a: Obj, b: Obj): { same: number; total: number } {
  const keys = new Set([...definedKeys(a), ...definedKeys(b)]);
  let same = 0;
  for (const key of keys) if (equal(a[key], b[key])) same += 1;
  return { same, total: keys.size };
}

/** Los valores de `to` que no tienen pareja en `from` (con repeticiones: cada valor empareja una sola vez). */
function unmatched(from: unknown[], to: unknown[]): unknown[] {
  const available = new Map<string, number>();
  for (const value of from) available.set(JSON.stringify(value), (available.get(JSON.stringify(value)) ?? 0) + 1);
  return to.filter((value) => {
    const key = JSON.stringify(value);
    const left = available.get(key) ?? 0;
    if (left > 0) available.set(key, left - 1);
    return left === 0;
  });
}

export function diffDocuments(before: unknown, after: unknown, options: DiffOptions = {}): DocumentDiff {
  const ignore = (options.ignore ?? []).map((p) => p.trim()).filter(Boolean);
  const ordered = new Set(options.ordered ?? []);
  const from = ignore.length > 0 ? strip(before, '', ignore) : before;
  const to = ignore.length > 0 ? strip(after, '', ignore) : after;

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: ChangedEntry[] = [];
  const moved: MovedEntry[] = [];
  const byCollection: Record<string, CollectionSummary> = {};
  const count = (collection: string, what: keyof CollectionSummary): void => {
    byCollection[collection] ??= { added: 0, removed: 0, changed: 0, moved: 0 };
    byCollection[collection][what] += 1;
  };
  const touch = (collection: string): void => void (byCollection[collection] ??= { added: 0, removed: 0, changed: 0, moved: 0 });

  const entry = (collection: string, id: string, item: Obj): DiffEntry => {
    const kind = kindOf(item);
    return { collection, id, label: labelOf(item, id), ...(kind ? { kind } : {}) };
  };
  const add = (collection: string, id: string, item: Obj): void => (added.push(entry(collection, id, item)), count(collection, 'added'));
  const remove = (collection: string, id: string, item: Obj): void => (removed.push(entry(collection, id, item)), count(collection, 'removed'));

  /** Un campo suelto: se anota en el elemento que lo contiene. */
  const leaf = (scope: Scope, path: string, a: unknown, b: unknown, extra: Partial<FieldChange> = {}): void => {
    scope.fields.push({ path: path || '(raíz)', ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}), ...extra });
  };

  function diffFields(scope: Scope, schemaPath: string, fieldPath: string, a: Obj, b: Obj): void {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !(k in a))];
    for (const key of keys) diffValue(scope, schemaPath ? `${schemaPath}.${key}` : key, fieldPath ? `${fieldPath}.${key}` : key, a[key], b[key]);
  }

  function diffValue(scope: Scope, schemaPath: string, fieldPath: string, a: unknown, b: unknown): void {
    if (equal(a, b)) return;
    // Sin lista (o sin objeto) o vacío es lo mismo.
    if ((a === undefined && isEmptyContainer(b)) || (b === undefined && isEmptyContainer(a))) return;
    if ((a === undefined || isObject(a)) && (b === undefined || isObject(b))) return diffFields(scope, schemaPath, fieldPath, (a ?? {}) as Obj, (b ?? {}) as Obj);
    if ((a === undefined || Array.isArray(a)) && (b === undefined || Array.isArray(b))) {
      const listA = (a ?? []) as unknown[];
      const listB = (b ?? []) as unknown[];
      if (listA.every(isObject) && listB.every(isObject)) return diffCollection(scope, schemaPath, fieldPath, listA as Obj[], listB as Obj[]);
      if (!ordered.has(schemaPath) && listA.every(isPrimitive) && listB.every(isPrimitive)) {
        // Lista de valores: un conjunto. Solo cambia si entra o sale algo (el orden no cuenta).
        const entered = unmatched(listA, listB);
        const left = unmatched(listB, listA);
        if (entered.length > 0 || left.length > 0) leaf(scope, fieldPath, a, b, { added: entered, removed: left });
        return;
      }
    }
    leaf(scope, fieldPath, a, b);
  }

  /** Un elemento presente en las dos versiones: los campos que cambiaron y, dentro, las listas que cuelgan de él. */
  function diffPair(collection: string, schemaPath: string, id: string, a: Obj, b: Obj, extra?: FieldChange): void {
    const scope: Scope = { collection, id, fields: [] };
    const at = changed.length; // las listas anidadas se anotan al recorrer: el elemento va delante de ellas
    diffFields(scope, schemaPath, '', a, b);
    if (extra) scope.fields.push(extra);
    if (scope.fields.length === 0) return;
    changed.splice(at, 0, { ...entry(collection, id, b), fields: scope.fields });
    count(collection, 'changed');
  }

  function diffCollection(parent: Scope, schemaPath: string, fieldPath: string, a: Obj[], b: Obj[]): void {
    const collection = (parent.root ? '' : `${parent.collection}[${parent.id}].`) + fieldPath;
    touch(collection);
    const key = matchKey(a, b);

    if (!key) {
      // Sin identidad (los pasos de un flujo, las correspondencias de un pipeline): si el orden es contenido, la lista es un
      // valor; si no, se empareja por igualdad exacta y, lo que sobra, por parecido (los mismos campos con otro valor).
      if (ordered.has(schemaPath)) return leaf(parent, fieldPath, a, b);
      const exact = new Map<string, number[]>();
      b.forEach((item, j) => {
        const form = canon(item);
        exact.set(form, [...(exact.get(form) ?? []), j]);
      });
      const matchedB = new Set<number>();
      const restA: number[] = [];
      a.forEach((item, i) => {
        const j = exact.get(canon(item))?.shift();
        if (j === undefined) restA.push(i);
        else matchedB.add(j);
      });
      const restB = b.map((_, j) => j).filter((j) => !matchedB.has(j));
      const pairs: Array<[number, number]> = [];
      for (const i of restA) {
        let best = -1;
        let bestSame = 0;
        for (const j of restB) {
          if (pairs.some(([, taken]) => taken === j)) continue;
          const { same, total } = similarity(a[i], b[j]);
          if (same * 2 >= total && same > bestSame) [best, bestSame] = [j, same];
        }
        if (best >= 0) pairs.push([i, best]);
      }
      for (const i of restA) if (!pairs.some(([p]) => p === i)) remove(collection, `#${i + 1}`, a[i]);
      for (const [i, j] of [...pairs].sort((x, y) => x[1] - y[1])) diffPair(collection, schemaPath, `#${j + 1}`, a[i], b[j]);
      for (const j of restB) if (!pairs.some(([, p]) => p === j)) add(collection, `#${j + 1}`, b[j]);
      return;
    }

    const indexA = new Map(a.map((item, i) => [String(item[key]), i]));
    const indexB = new Map(b.map((item, j) => [String(item[key]), j]));
    // Reordenados: de los elementos que están en las dos listas, los que no caben en la subsecuencia que conserva su orden.
    const common = a.map((item) => String(item[key])).filter((k) => indexB.has(k));
    const keep = longestIncreasing(common.map((k) => indexB.get(k)!));
    const shifted = new Map<string, MovedEntry>();
    common.forEach((k, n) => {
      if (!keep.has(n)) shifted.set(k, { ...entry(collection, k, b[indexB.get(k)!]), from: indexA.get(k)! + 1, to: indexB.get(k)! + 1 });
    });
    const isOrdered = ordered.has(schemaPath);

    for (const item of a) if (!indexB.has(String(item[key]))) remove(collection, String(item[key]), item);
    b.forEach((item) => {
      const k = String(item[key]);
      const i = indexA.get(k);
      if (i === undefined) return add(collection, k, item);
      const move = shifted.get(k);
      diffPair(collection, schemaPath, k, a[i], item, move && isOrdered ? { path: POSITION_FIELD, before: move.from, after: move.to } : undefined);
      if (move && !isOrdered) (moved.push(move), count(collection, 'moved'));
    });
  }

  const root: Scope = { collection: ROOT_COLLECTION, id: ROOT_ID, root: true, fields: [] };
  touch(ROOT_COLLECTION);
  diffValue(root, '', '', from, to);
  if (root.fields.length > 0) {
    const workspace = isObject(to) && isObject(to.workspace) ? to.workspace.name : undefined;
    changed.unshift({ collection: ROOT_COLLECTION, id: ROOT_ID, label: typeof workspace === 'string' && workspace ? workspace : ROOT_ID, fields: root.fields });
    count(ROOT_COLLECTION, 'changed');
  }

  // Solo las listas con algo que contar.
  const collections: Record<string, CollectionSummary> = {};
  for (const [name, c] of Object.entries(byCollection)) if (c.added + c.removed + c.changed + c.moved > 0) collections[name] = c;

  return {
    added,
    removed,
    changed,
    moved,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      moved: moved.length,
      fields: changed.reduce((n, c) => n + c.fields.length, 0),
      total: added.length + removed.length + changed.length,
      byCollection: collections,
    },
  };
}

/** `true` si los dos documentos difieren en contenido (lo ignorado y los reordenamientos que no cuentan no entran). */
export function hasChanges(diff: DocumentDiff): boolean {
  return diff.summary.total > 0;
}
