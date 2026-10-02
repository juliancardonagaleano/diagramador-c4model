import { pickId, Warnings } from '@iark/kernel';
import { formatDataIssues, validateDataDocument } from '../schema';
import { DATA_DOCUMENT_VERSION, type Cardinality, type Column, type ColumnKey, type ColumnMapping, type DataAsset, type Pipeline, type Relation } from '../types';
import { personalHint, slugify } from './common';
import { DataImportError, type DataImportOptions, type DataImportResult } from './fromMermaid';
import { analyzeSelect, type SelectInfo, type TableRef } from './sqlSelect';
import { closeOf, isName, isP, isW, readName, splitStatements, splitTop, tokenize, type Tok } from './sqlTokens';

/**
 * Importa un DDL de SQL (`.sql`, `.ddl`) como documento de datos. El analizador es propio y tolerante: cubre lo básico de
 * PostgreSQL, MySQL/MariaDB, SQL Server, Oracle y Snowflake, y lo que no entiende lo cuenta en los avisos y sigue.
 *
 * Qué entrada pasa a qué elemento:
 * - `CREATE TABLE` (y `CREATE TABLE ... AS SELECT`) → activo `table` con sus columnas: tipo con parámetros (`numeric(12,2)`),
 *   `PRIMARY KEY` → `pk`, `UNIQUE` de una sola columna → `uk`, `REFERENCES`/`FOREIGN KEY` → `fk`, y `nullable: true` en las que
 *   admiten nulos (las que no llevan `NOT NULL` ni son clave primaria). Los comentarios (`COMMENT 'x'`, `COMMENT ON TABLE/COLUMN`,
 *   `COMMENT = 'x'`) son la descripción. Las restricciones de tabla y las de `ALTER TABLE ... ADD CONSTRAINT` se aplican igual.
 * - Esquema (`ventas.pedidos`) → contenedor `database` con el nombre del esquema, del que cuelgan sus tablas y vistas (es la
 *   agrupación que admite el modelo; un esquema no se toma por dominio porque un dominio es del negocio y lleva responsable).
 *   Las tablas sin esquema quedan sin contenedor; el catálogo de un nombre de tres partes (`bd.esquema.tabla`) se descarta.
 * - Clave foránea → relación entre las dos tablas, con el padre (la tabla referenciada) como origen. Cardinalidad conservadora:
 *   `1:1` si las columnas de la clave foránea son únicas (clave primaria o `UNIQUE` de solo ellas) y `1:N` en otro caso. El modelo
 *   no guarda la opcionalidad, así que va en la descripción de la relación: `cliente_id · 1..1 → 0..N` (cada pedido tiene un
 *   cliente si la columna es `NOT NULL`, `0..1` si admite nulos; cada cliente tiene `0..N` pedidos, `0..1` si la clave es única).
 *   Una clave foránea de una tabla a sí misma no se puede dibujar (el esquema rechaza las relaciones recursivas): se marca la
 *   columna como `fk` y se avisa.
 * - `CREATE [MATERIALIZED] VIEW ... AS SELECT` → activo `view` (con la etiqueta `materializada` si lo es) y un pipeline `elt`
 *   desde las tablas de sus `FROM` y `JOIN` (CTE y subconsultas incluidos, sin contar los CTE). Si el SELECT es un único bloque
 *   sencillo, sus columnas son las de la lista del SELECT y el linaje de columnas sale de las referencias directas
 *   (`p.total AS importe` → `copia`) y de las expresiones con alias (`sum(l.cantidad)` → la expresión). Si el SELECT es demasiado
 *   complejo (no lee ninguna tabla, paréntesis que no cuadran…) se avisa y la vista queda sin pipeline.
 * - Una tabla o vista que se lee pero no está definida en el archivo se crea vacía (con su descripción diciéndolo) para no perder
 *   el linaje ni la relación, y se avisa.
 *
 * Qué no se mapea (se cuenta en un aviso): valores por defecto, restricciones `CHECK`, índices, secuencias, funciones,
 * disparadores, permisos, `INSERT`… El modelo de datos no los recoge. Las sentencias de sesión (`SET`, `USE`, `BEGIN`, `DROP`…)
 * se ignoran sin más. No se adivina nada de gobierno: ni clasificación, ni responsable (el `OWNER TO` de PostgreSQL es un rol de la
 * base, no el responsable del dato), ni datos personales; los nombres de columna que recuerdan a un dato personal (`email`,
 * `dni`, `telefono`…) solo se sugieren en un aviso.
 */

const COLUMN_KEY_ORDER: ColumnKey[] = ['pk', 'fk', 'uk'];
const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'sys', 'pg_temp', 'dual']);
/** Objetos de `CREATE` que son infraestructura y no se cuentan entre lo que falta. */
const QUIET_OBJECTS = new Set(['SCHEMA', 'DATABASE', 'EXTENSION', 'ROLE', 'USER', 'TABLESPACE', 'WAREHOUSE', 'STAGE', 'LANGUAGE', 'SERVER', 'SHARE', 'LOGIN', 'CATALOG']);
/** Objetos de `CREATE` que no son tablas ni vistas: se cuentan entre lo que no se importa. */
const OTHER_OBJECTS = new Set([
  'INDEX', 'UNIQUE', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'TYPE', 'DOMAIN', 'SYNONYM', 'PACKAGE', 'EVENT', 'RULE', 'POLICY', 'STREAM', 'TASK', 'PIPE',
  'AGGREGATE', 'OPERATOR', 'COLLATION', 'CLUSTER', 'DIRECTORY', 'CONTEXT', 'LIBRARY', 'ASSEMBLY', 'STATISTICS', 'TAG', 'ALERT', 'PUBLICATION', 'SUBSCRIPTION',
]);
const COUNTED_STATEMENTS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE']);
const TYPE_WORDS = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN', 'BOOL', 'BIT', 'BLOB', 'JSON', 'UUID', 'TIME']);
/** Palabras que cierran el tipo de una columna y abren sus restricciones y opciones. */
const OPTION_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COMMENT', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY',
  'COLLATE', 'CHARSET', 'ON', 'AS', 'ENCODE', 'KEY', 'FOREIGN', 'ENABLE', 'DISABLE', 'VISIBLE', 'INVISIBLE', 'ROWGUIDCOL', 'SPARSE', 'MASKED', 'TAG',
  'STORAGE', 'USING', 'STORED', 'VIRTUAL', 'WITH', 'WITHOUT', 'CHARACTER',
]);
const NOT_REFERENCES = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'AS', 'DISTINCT', 'OVER', 'PARTITION', 'BY', 'ORDER', 'TRUE', 'FALSE', 'INTERVAL', 'ASC', 'DESC', 'FILTER', 'WITHIN', 'GROUP']);

interface ColDef {
  name: string;
  type?: string;
  notNull: boolean;
  pk: boolean;
  uk: boolean;
  fk: boolean;
  description?: string;
}

interface Entity {
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  materialized: boolean;
  temp: boolean;
  placeholder: boolean;
  columns: ColDef[];
  /** Conjuntos de columnas únicos (la clave primaria y los `UNIQUE`), en minúsculas. */
  unique: string[][];
  description?: string;
  line: number;
  /** Consulta de la que sale (vista o `CREATE TABLE AS`). */
  query?: { tokens: Tok[]; ctas: boolean; names?: string[] };
}

interface Fk {
  table: Entity;
  cols: string[];
  ref: string[];
  refCols: string[];
  line: number;
}

interface Alter {
  parts: string[];
  actions: Tok[][];
  line: number;
}

interface CommentOn {
  kind: string;
  parts: string[];
  text: string;
}

const keyOf = (schema: string | undefined, name: string): string => `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
const lower = (s: string): string => s.toLowerCase();

/** ¿El texto parece un DDL de SQL? Basta un `CREATE TABLE` o `CREATE VIEW` fuera de los comentarios. */
export function looksLikeDdl(text: string): boolean {
  if (/^\s*[{[]/.test(text)) return false; // un JSON (el manifest de dbt trae macros con `create table`) no es un DDL
  const head = text.slice(0, 400_000).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return /\bcreate\s+(?:(?:or\s+replace|global|local|temp|temporary|unlogged|transient|materialized|secure|recursive|external|volatile|dynamic|hybrid|iceberg|force|noforce|editionable|noneditionable|algorithm\s*=\s*\w+|definer\s*=\s*\S+|sql\s+security\s+\w+)\s+)*(?:table|view)\b/i.test(head);
}

/** Texto de unos tokens de una expresión, legible y en una línea. */
function renderTokens(toks: Tok[]): string {
  let out = '';
  let prev: Tok | undefined;
  for (const t of toks) {
    const text = t.k === 'str' ? `'${t.v}'` : t.k === 'qid' && !/^\w+$/.test(t.v) ? `"${t.v}"` : t.v;
    const wordish = (x: Tok | undefined): boolean => x !== undefined && (x.k !== 'p' || x.v === ')' || x.v === ']');
    const glue = t.k === 'p' && ['.', ')', ',', ']', ':', '['].includes(t.v);
    const afterGlue = prev !== undefined && prev.k === 'p' && ['.', '(', '[', ':'].includes(prev.v);
    const call = isP(t, '(') && prev !== undefined && prev.k === 'word';
    if (prev && !glue && !afterGlue && !call && (wordish(prev) || wordish(t) || prev.v === ',' || t.k === 'p')) out += ' ';
    out += text;
    prev = t;
  }
  return out;
}

class Ddl {
  readonly warnings = new Warnings();
  readonly entities = new Map<string, Entity>();
  readonly order: Entity[] = [];
  fks: Fk[] = [];
  readonly schemaComments = new Map<string, string>();
  private alters: Alter[] = [];
  private comments: CommentOn[] = [];
  private unmapped = new Map<string, number>();
  private defaults = 0;
  private checks = 0;
  private indexes = 0;
  private compositeUnique: string[] = [];

  count(label: string): void {
    this.unmapped.set(label, (this.unmapped.get(label) ?? 0) + 1);
  }

  // ───────────── sentencias ─────────────

  statement(st: Tok[]): void {
    const first = st[0];
    if (isW(first, 'CREATE')) this.create(st);
    else if (isW(first, 'ALTER')) this.alter(st);
    else if (isW(first, 'COMMENT') && isW(st[1], 'ON')) this.comment(st);
    else if (first?.k === 'word' && COUNTED_STATEMENTS.has(first.u)) this.count(first.u === 'EXECUTE' ? 'EXEC' : first.u);
  }

  private create(st: Tok[]): void {
    let materialized = false;
    let temp = false;
    let i = 1;
    for (; i < Math.min(st.length, 16); i += 1) {
      const t = st[i];
      if (t.k !== 'word') continue;
      if (t.u === 'TABLE' || t.u === 'VIEW') break;
      if (t.u === 'MATERIALIZED') materialized = true;
      if (t.u === 'TEMP' || t.u === 'TEMPORARY' || t.u === 'VOLATILE') temp = true;
      if (t.u === 'SCHEMA') return this.schema(st, i);
      if (OTHER_OBJECTS.has(t.u) || QUIET_OBJECTS.has(t.u)) {
        if (!QUIET_OBJECTS.has(t.u)) this.count(`CREATE ${t.u === 'UNIQUE' ? 'INDEX' : t.u}`);
        return;
      }
    }
    if (i >= Math.min(st.length, 16) || !(st[i].u === 'TABLE' || st[i].u === 'VIEW')) return;
    const isView = st[i].u === 'VIEW';
    let j = i + 1;
    if (isW(st[j], 'IF') && isW(st[j + 1], 'NOT') && isW(st[j + 2], 'EXISTS')) j += 3;
    const name = readName(st, j);
    if (!name) {
      this.warnings.add(`línea ${st[0].line}: CREATE ${isView ? 'VIEW' : 'TABLE'} sin nombre; se omite.`);
      return;
    }
    const entity = this.define(name.parts, isView ? 'view' : 'table', st[0].line, { materialized, temp: temp || name.parts[name.parts.length - 1].startsWith('#') });
    let k = name.next;
    if (isView) return this.createView(st, k, entity);
    if (isW(st[k], 'PARTITION') && isW(st[k + 1], 'OF')) {
      this.forget(entity);
      this.warnings.add(`línea ${st[0].line}: «${name.parts.join('.')}» es una partición (PARTITION OF) y no se importa como activo.`);
      return;
    }
    if (isW(st[k], 'LIKE', 'CLONE')) {
      this.warnings.add(`línea ${st[0].line}: «${name.parts.join('.')}» se crea con ${st[k].u} y no se copian sus columnas.`);
      return;
    }
    let names: string[] | undefined;
    if (isP(st[k], '(')) {
      const close = closeOf(st, k);
      if (close < 0) {
        this.forget(entity);
        this.warnings.add(`línea ${st[0].line}: la tabla «${name.parts.join('.')}» está incompleta (falta el paréntesis que cierra la lista de columnas); se omite.`);
        return;
      }
      const items = splitTop(st.slice(k + 1, close));
      k = close + 1;
      if (isW(st[k], 'AS')) names = items.map((it) => it[0]?.v).filter((v): v is string => !!v);
      else {
        this.tableBody(entity, items);
        this.tableOptions(entity, st.slice(k));
        return;
      }
    }
    const as = st.findIndex((t, idx) => idx >= k && isW(t, 'AS'));
    const body = as >= 0 ? st.slice(as + 1) : [];
    if (body.length > 0 && (isW(body[0], 'SELECT', 'WITH') || isP(body[0], '('))) {
      entity.query = { tokens: body, ctas: true, names };
      this.tableOptions(entity, st.slice(k, as));
    } else this.tableOptions(entity, st.slice(k));
  }

  /** `CREATE SCHEMA x COMMENT = '...'` (Snowflake): el comentario es la descripción del contenedor del esquema. */
  private schema(st: Tok[], at: number): void {
    let j = at + 1;
    if (isW(st[j], 'IF') && isW(st[j + 1], 'NOT') && isW(st[j + 2], 'EXISTS')) j += 3;
    const name = readName(st, j);
    const comment = name ? st.findIndex((t, idx) => idx >= name.next && isW(t, 'COMMENT')) : -1;
    if (!name || comment < 0) return;
    const value = st[isP(st[comment + 1], '=') ? comment + 2 : comment + 1];
    if (value?.k === 'str') this.schemaComments.set(lower(name.parts[name.parts.length - 1]), value.v.trim());
  }

  private createView(st: Tok[], from: number, entity: Entity): void {
    let k = from;
    let names: string[] | undefined;
    if (isP(st[k], '(')) {
      const close = closeOf(st, k);
      if (close > 0) {
        names = splitTop(st.slice(k + 1, close)).map((it) => it[0]?.v).filter((v): v is string => !!v);
        k = close + 1;
      }
    }
    let depth = 0;
    let as = -1;
    for (let idx = k; idx < st.length; idx += 1) {
      if (isP(st[idx], '(')) depth += 1;
      else if (isP(st[idx], ')')) depth -= 1;
      else if (depth === 0 && isW(st[idx], 'AS')) {
        as = idx;
        break;
      }
    }
    if (as < 0) {
      this.forget(entity);
      this.warnings.add(`línea ${st[0].line}: la vista «${entity.name}» no tiene AS ni SELECT; se omite.`);
      return;
    }
    this.tableOptions(entity, st.slice(k, as));
    entity.query = { tokens: st.slice(as + 1), ctas: false, names };
  }

  /** Crea (o reemplaza) la tabla o vista; si ya estaba definida, manda la última definición. */
  private define(parts: string[], kind: Entity['kind'], line: number, extra: { materialized: boolean; temp: boolean }): Entity {
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    const key = keyOf(schema, name);
    const previous = this.entities.get(key);
    const entity: Entity = { schema, name, kind, materialized: extra.materialized, temp: extra.temp, placeholder: false, columns: [], unique: [], line };
    if (previous) {
      this.warnings.add(`línea ${line}: «${parts.join('.')}» ya estaba definida en la línea ${previous.line}; se usa la última definición.`);
      this.order[this.order.indexOf(previous)] = entity;
      this.fks = this.fks.filter((f) => f.table !== previous);
    } else this.order.push(entity);
    this.entities.set(key, entity);
    return entity;
  }

  private forget(entity: Entity): void {
    this.entities.delete(keyOf(entity.schema, entity.name));
    this.order.splice(this.order.indexOf(entity), 1);
  }

  /** Columnas y restricciones del cuerpo de un `CREATE TABLE`: primero las columnas, después las restricciones de tabla. */
  private tableBody(entity: Entity, items: Tok[][]): void {
    const constraints: Tok[][] = [];
    for (const item of items) {
      if (item.length === 0) continue;
      if (this.isConstraint(item)) constraints.push(item);
      else this.column(entity, item);
    }
    for (const item of constraints) this.constraint(entity, item);
  }

  private isConstraint(item: Tok[]): boolean {
    const [a, b] = item;
    if (isW(a, 'CONSTRAINT')) return true;
    if (isW(a, 'PRIMARY', 'FOREIGN')) return isW(b, 'KEY');
    if (isW(a, 'UNIQUE')) return isP(b, '(') || isW(b, 'KEY', 'INDEX', 'CLUSTERED', 'NONCLUSTERED') || (isName(b) && isP(item[2], '('));
    if (isW(a, 'CHECK')) return isP(b, '(');
    if (isW(a, 'EXCLUDE')) return isW(b, 'USING') || isP(b, '(');
    if (isW(a, 'PERIOD')) return isW(b, 'FOR');
    if (isW(a, 'LIKE')) return isName(b) && item.length <= 4;
    if (isW(a, 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL')) return isP(b, '(') || isW(b, 'KEY', 'INDEX') || (isName(b) && isP(item[2], '(') && !(b.k === 'word' && TYPE_WORDS.has(b.u)));
    return false;
  }

  private isOption(item: Tok[], i: number): boolean {
    const t = item[i];
    if (t.k !== 'word' || !OPTION_WORDS.has(t.u)) return false;
    if (t.u === 'CHARACTER') return isW(item[i + 1], 'SET');
    if (t.u === 'WITH' || t.u === 'WITHOUT') return !isW(item[i + 1], 'TIME', 'LOCAL');
    return true;
  }

  /** Columna de un `CREATE TABLE` o de un `ALTER TABLE ... ADD`. */
  private column(entity: Entity, item: Tok[]): void {
    if (!isName(item[0])) return;
    const col: ColDef = { name: item[0].v, notNull: false, pk: false, uk: false, fk: false };
    let type = '';
    let i = 1;
    const word = (w: string): void => void (type += `${type && !type.endsWith('.') ? ' ' : ''}${w}`);
    while (i < item.length) {
      const t = item[i];
      if (this.isOption(item, i)) break;
      if (isName(t)) word(t.k === 'word' ? t.v.toLowerCase() : t.v);
      else if (isP(t, '.')) type += '.';
      else if (isP(t, '(')) {
        const close = closeOf(item, i);
        if (close < 0) break;
        type += `(${params(item.slice(i + 1, close))})`;
        i = close;
      } else if (isP(t, '[')) {
        while (i < item.length && !isP(item[i], ']')) i += 1;
        type += '[]';
      } else break;
      i += 1;
    }
    if (type) col.type = type;
    // Opciones: restricciones en línea, valores por defecto, comentario…
    while (i < item.length) {
      const t = item[i];
      if (isP(t, '(')) {
        const close = closeOf(item, i);
        i = close < 0 ? item.length : close + 1;
        continue;
      }
      if (t.k !== 'word') {
        i += 1;
        continue;
      }
      switch (t.u) {
        case 'CONSTRAINT':
          i += 2;
          break;
        case 'NOT':
          if (isW(item[i + 1], 'NULL')) col.notNull = true;
          i += isW(item[i + 1], 'NULL') ? 2 : 1;
          break;
        case 'PRIMARY':
          if (isW(item[i + 1], 'KEY')) col.pk = true;
          i += 1;
          break;
        case 'UNIQUE':
          col.uk = true;
          i += 1;
          break;
        case 'REFERENCES': {
          const ref = readName(item, i + 1);
          if (!ref) {
            i += 1;
            break;
          }
          let refCols: string[] = [];
          i = ref.next;
          if (isP(item[i], '(')) {
            const close = closeOf(item, i);
            if (close > 0) {
              refCols = idents(item.slice(i + 1, close));
              i = close + 1;
            }
          }
          col.fk = true;
          this.fks.push({ table: entity, cols: [col.name], ref: ref.parts, refCols, line: item[0].line });
          break;
        }
        case 'CHECK':
          this.checks += 1;
          i += 1;
          break;
        case 'DEFAULT': {
          // `GENERATED BY DEFAULT AS IDENTITY` no es un valor por defecto.
          if (!isW(item[i - 1], 'BY')) this.defaults += 1;
          i += 1;
          if (isP(item[i], '(')) i = (closeOf(item, i) < 0 ? item.length : closeOf(item, i)) + 1;
          else i += 1;
          while (i < item.length && !this.isOption(item, i)) i += isP(item[i], '(') ? Math.max(closeOf(item, i) - i, 0) + 1 : 1;
          break;
        }
        case 'COMMENT':
          i += 1;
          if (isP(item[i], '=')) i += 1;
          if (item[i]?.k === 'str') {
            col.description = item[i].v.trim() || undefined;
            i += 1;
          }
          break;
        default:
          i += 1;
      }
    }
    const previous = entity.columns.findIndex((c) => lower(c.name) === lower(col.name));
    if (previous >= 0) entity.columns[previous] = col;
    else entity.columns.push(col);
    if (col.pk) entity.unique.push([lower(col.name)]);
    if (col.uk) entity.unique.push([lower(col.name)]);
  }

  /** Restricción de tabla (`[CONSTRAINT n] PRIMARY KEY (...)`, `UNIQUE (...)`, `FOREIGN KEY (...) REFERENCES ...`, `CHECK`, índices). */
  private constraint(entity: Entity, item: Tok[]): void {
    let i = 0;
    if (isW(item[i], 'CONSTRAINT')) i += isName(item[i + 1]) && !isW(item[i + 1], 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK') ? 2 : 1;
    const kind = item[i];
    const open = item.findIndex((t, idx) => idx >= i && isP(t, '('));
    const cols = (): string[] => {
      const close = open < 0 ? -1 : closeOf(item, open);
      return close < 0 ? [] : idents(item.slice(open + 1, close));
    };
    const mark = (names: string[], key: 'pk' | 'uk' | 'fk'): void => {
      for (const n of names) {
        const col = entity.columns.find((c) => lower(c.name) === lower(n));
        if (!col) this.warnings.add(`línea ${item[0].line}: «${entity.name}» usa la columna «${n}» en una restricción y no la declara.`);
        else col[key] = true;
      }
    };
    if (isW(kind, 'PRIMARY')) {
      const names = cols();
      mark(names, 'pk');
      if (names.length > 0) entity.unique.push(names.map(lower));
    } else if (isW(kind, 'UNIQUE')) {
      const names = cols();
      if (names.length === 1) mark(names, 'uk');
      else if (names.length > 1) this.compositeUnique.push(`${entity.name}(${names.join(', ')})`);
      if (names.length > 0) entity.unique.push(names.map(lower));
    } else if (isW(kind, 'FOREIGN')) {
      const names = cols();
      const refAt = item.findIndex((t, idx) => idx > i && isW(t, 'REFERENCES'));
      const ref = refAt < 0 ? undefined : readName(item, refAt + 1);
      if (!ref || names.length === 0) {
        this.warnings.add(`línea ${item[0].line}: no se entiende la clave foránea de «${entity.name}»; se omite.`);
        return;
      }
      let refCols: string[] = [];
      if (isP(item[ref.next], '(')) {
        const close = closeOf(item, ref.next);
        if (close > 0) refCols = idents(item.slice(ref.next + 1, close));
      }
      mark(names, 'fk');
      this.fks.push({ table: entity, cols: names, ref: ref.parts, refCols, line: item[0].line });
    } else if (isW(kind, 'CHECK')) this.checks += 1;
    else if (isW(kind, 'LIKE')) this.warnings.add(`línea ${item[0].line}: «${entity.name}» copia las columnas de otra tabla con LIKE y no se importan.`);
    else this.indexes += 1;
  }

  /** Lo que sigue al paréntesis de columnas: el comentario de la tabla (`COMMENT = '...'`) y el resto, que no se recoge. */
  private tableOptions(entity: Entity, tail: Tok[]): void {
    for (let i = 0; i < tail.length; i += 1) {
      if (isW(tail[i], 'COMMENT')) {
        const at = isP(tail[i + 1], '=') ? i + 2 : i + 1;
        if (tail[at]?.k === 'str') entity.description = tail[at].v.trim() || undefined;
      } else if (isP(tail[i], '(')) {
        const close = closeOf(tail, i);
        if (close > i) i = close;
      }
    }
  }

  private alter(st: Tok[]): void {
    if (!isW(st[1], 'TABLE')) {
      if (st[1]?.k === 'word' && !QUIET_OBJECTS.has(st[1].u)) this.count(`ALTER ${st[1].u}`);
      return;
    }
    let i = 2;
    if (isW(st[i], 'IF') && isW(st[i + 1], 'EXISTS')) i += 2;
    if (isW(st[i], 'ONLY')) i += 1;
    const name = readName(st, i);
    if (!name) return;
    i = name.next;
    if (isW(st[i], 'WITH') && isW(st[i + 1], 'CHECK', 'NOCHECK')) i += 2;
    this.alters.push({ parts: name.parts, actions: splitTop(st.slice(i)), line: st[0].line });
  }

  private comment(st: Tok[]): void {
    let kind = st[2]?.u ?? '';
    let at = 3;
    if (kind === 'MATERIALIZED' && isW(st[3], 'VIEW')) {
      kind = 'VIEW';
      at = 4;
    }
    const name = readName(st, at);
    const text = name && isW(st[name.next], 'IS') && st[name.next + 1]?.k === 'str' ? st[name.next + 1].v.trim() : undefined;
    if (!name || text === undefined) {
      if (kind && !QUIET_OBJECTS.has(kind) && !['TABLE', 'VIEW', 'COLUMN'].includes(kind)) this.count(`COMMENT ON ${kind}`);
      return;
    }
    this.comments.push({ kind, parts: name.parts, text });
  }

  // ───────────── resolución ─────────────

  /** Tabla o vista a la que se refiere un nombre: exacto, o sin esquema si solo hay una con ese nombre. */
  find(parts: string[]): Entity | undefined | 'ambiguous' {
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    const exact = this.entities.get(keyOf(schema, name));
    if (exact) return exact;
    if (schema) return this.entities.get(keyOf(undefined, name));
    const same = this.order.filter((e) => lower(e.name) === lower(name));
    return same.length === 1 ? same[0] : same.length > 1 ? 'ambiguous' : undefined;
  }

  /** La tabla o vista de un nombre; si no está definida en el archivo, se crea vacía (y se avisa una vez al final). */
  resolve(parts: string[], line: number, missing: Set<string>): Entity | undefined {
    const found = this.find(parts);
    if (found === 'ambiguous') {
      this.warnings.add(`línea ${line}: «${parts.join('.')}» existe en varios esquemas y no se sabe a cuál se refiere; se omite.`);
      return undefined;
    }
    if (found) return found;
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    if (schema && SYSTEM_SCHEMAS.has(lower(schema))) return undefined;
    if (!schema && SYSTEM_SCHEMAS.has(lower(parts[0]))) return undefined;
    const name = parts[parts.length - 1];
    const entity: Entity = {
      schema,
      name,
      kind: 'table',
      materialized: false,
      temp: false,
      placeholder: true,
      columns: [],
      unique: [],
      description: 'Se lee o se referencia en el DDL, pero no está definida en él.',
      line,
    };
    this.entities.set(keyOf(schema, name), entity);
    this.order.push(entity);
    missing.add(parts.join('.'));
    return entity;
  }

  /** Aplica los `ALTER TABLE` y los `COMMENT ON`, ya con todas las tablas definidas. */
  settle(): void {
    for (const alter of this.alters) {
      const entity = this.find(alter.parts);
      if (!entity || entity === 'ambiguous') {
        this.count('ALTER TABLE de tablas que no están en el archivo');
        continue;
      }
      for (const action of alter.actions) this.alterAction(entity, action);
    }
    for (const c of this.comments) {
      if (c.kind === 'SCHEMA') {
        // El comentario de un esquema lo recoge su contenedor.
        this.schemaComments.set(lower(c.parts[c.parts.length - 1]), c.text);
        continue;
      }
      const isColumn = c.kind === 'COLUMN';
      const entity = this.find(isColumn ? c.parts.slice(0, -1) : c.parts);
      if (!entity || entity === 'ambiguous') {
        if (['TABLE', 'VIEW', 'COLUMN'].includes(c.kind)) this.count('COMMENT ON de objetos que no están en el archivo');
        continue;
      }
      if (!isColumn) entity.description = c.text || undefined;
      else {
        const col = entity.columns.find((x) => lower(x.name) === lower(c.parts[c.parts.length - 1]));
        if (col) col.description = c.text || undefined;
      }
    }
  }

  private alterAction(entity: Entity, action: Tok[]): void {
    if (isW(action[0], 'ADD')) {
      let i = 1;
      if (isW(action[i], 'COLUMN')) i += 1;
      if (isW(action[i], 'IF') && isW(action[i + 1], 'NOT') && isW(action[i + 2], 'EXISTS')) i += 3;
      const rest = action.slice(i);
      if (rest.length === 0) return;
      // Oracle: `ADD (columna tipo, otra tipo)`.
      const group = isP(rest[0], '(') && closeOf(rest, 0) > 0 ? splitTop(rest.slice(1, closeOf(rest, 0))) : [rest];
      for (const item of group) {
        if (this.isConstraint(item)) this.constraint(entity, item);
        else if (isName(item[0]) && !isW(item[0], 'DEFAULT')) this.column(entity, item);
      }
    } else if (isW(action[0], 'ALTER')) {
      const at = isW(action[1], 'COLUMN') ? 2 : 1;
      const col = isName(action[at]) ? entity.columns.find((c) => lower(c.name) === lower(action[at].v)) : undefined;
      if (col && isW(action[at + 1], 'SET') && isW(action[at + 2], 'NOT') && isW(action[at + 3], 'NULL')) col.notNull = true;
      else if (col && isW(action[at + 1], 'DROP') && isW(action[at + 2], 'NOT') && isW(action[at + 3], 'NULL')) col.notNull = false;
    }
  }

  // ───────────── resultado ─────────────

  summary(): void {
    const parts: string[] = [];
    if (this.defaults > 0) parts.push(`${this.defaults} valor(es) por defecto`);
    if (this.checks > 0) parts.push(`${this.checks} restricción(es) CHECK`);
    if (this.indexes > 0) parts.push(`${this.indexes} índice(s) o clave(s) de búsqueda de CREATE TABLE`);
    for (const [label, n] of this.unmapped) parts.push(`${n} × ${label}`);
    if (parts.length > 0) this.warnings.add(`Sin mapear (el modelo de datos no los recoge): ${parts.join(', ')}.`);
    if (this.compositeUnique.length > 0) {
      this.warnings.add(`${this.compositeUnique.length} restricción(es) UNIQUE de varias columnas no se marcan como clave (${this.compositeUnique.slice(0, 6).join('; ')}${this.compositeUnique.length > 6 ? '; …' : ''}); sí cuentan para decidir si una clave foránea es 1:1.`);
    }
  }
}

/** Nombres de columna de una lista entre paréntesis (`(a, b DESC, c(10))`). */
function idents(inner: Tok[]): string[] {
  return splitTop(inner)
    .map((it) => it[0])
    .filter(isName)
    .map((t) => t.v);
}

/** Parámetros de un tipo (`10,2`, `'a','b'`, `100 char`). */
function params(inner: Tok[]): string {
  return splitTop(inner)
    .map((part) => part.map((t) => (t.k === 'str' ? `'${t.v}'` : t.k === 'word' ? t.v.toLowerCase() : t.v)).join(' '))
    .join(',');
}

interface Link {
  /** Hijo (la tabla con la clave foránea) → padre (la referenciada). */
  child: Entity;
  parent: Entity;
  cols: string[];
  mandatory: boolean;
  unique: boolean;
}

interface Lineage {
  view: Entity;
  inputs: Entity[];
  mappings: Array<{ from: Entity; fromColumn: string; toColumn: string; transform: string }>;
  columns?: ColDef[];
}

/**
 * Columnas y mapeos de una consulta sencilla: cada elemento de la lista del SELECT es una columna (`p.id`, `p.id AS pedido`)
 * o una expresión con alias (`sum(l.cantidad) AS unidades`). Solo se enlaza lo que se puede resolver sin duda: un calificador
 * que es una tabla del `FROM` o un nombre sin calificar que está en una sola de ellas, con la columna declarada en ella.
 */
function selectColumns(info: SelectInfo, sources: Array<{ ref: TableRef; entity?: Entity }>, names?: string[]): Pick<Lineage, 'columns' | 'mappings'> | undefined {
  const link = info.simple;
  const byQualifier = new Map<string, Entity | undefined>();
  for (const { ref, entity } of sources) {
    const last = ref.parts[ref.parts.length - 1];
    for (const q of [ref.alias, last, ref.parts.slice(-2).join('.')]) if (q && !byQualifier.has(lower(q))) byQualifier.set(lower(q), entity);
    if (ref.alias) byQualifier.set(lower(ref.alias), entity);
  }
  const known = [...new Set(sources.map((s) => s.entity).filter((e): e is Entity => !!e && e.columns.length > 0))];
  const owning = (column: string): Entity | undefined => {
    const holders = known.filter((e) => e.columns.some((c) => lower(c.name) === lower(column)));
    return holders.length === 1 && known.length === sources.length ? holders[0] : undefined;
  };
  const columns: ColDef[] = [];
  const mappings: Lineage['mappings'] = [];
  const seen = new Set<string>();
  // Si el SELECT no es sencillo (CTE, UNION, subconsultas) los alias pueden esconder otras tablas: solo se toman los nombres de las columnas.
  const add = (name: string, type: string | undefined, from: Array<{ entity: Entity; column: string }>, transform: string): void => {
    if (!seen.has(lower(name))) {
      seen.add(lower(name));
      columns.push({ name, ...(type && link ? { type } : {}), notNull: false, pk: false, uk: false, fk: false });
    }
    for (const f of link ? from : []) {
      if (!mappings.some((m) => m.from === f.entity && lower(m.fromColumn) === lower(f.column) && lower(m.toColumn) === lower(name))) {
        mappings.push({ from: f.entity, fromColumn: f.column, toColumn: name, transform });
      }
    }
  };
  const source = (entity: Entity, column: string): { entity: Entity; column: string; type?: string } | undefined => {
    const col = entity.columns.find((c) => lower(c.name) === lower(column));
    return col ? { entity, column: col.name, type: col.type } : undefined;
  };

  for (const [index, item] of info.items.entries()) {
    if (item.length === 0) return undefined;
    // `*` y `t.*`
    const star = isP(item[item.length - 1], '*') && (item.length === 1 || (item.length >= 3 && isP(item[item.length - 2], '.')));
    if (star) {
      const q = item.length >= 3 ? item.slice(0, -2).filter(isName).map((t) => t.v).join('.') : undefined;
      const targets = q === undefined ? sources.map((s) => s.entity) : [byQualifier.get(lower(q)) ?? byQualifier.get(lower(q.split('.').pop()!))];
      if (!link || targets.length === 0 || targets.some((e) => !e || e.columns.length === 0)) return undefined;
      for (const e of targets as Entity[]) for (const c of e.columns) add(c.name, c.type, [{ entity: e, column: c.name }], 'copia');
      continue;
    }
    // Alias explícito (`AS x`) o implícito (`expr x`).
    let expr = item;
    let alias: string | undefined;
    const last = item[item.length - 1];
    if (item.length >= 3 && isW(item[item.length - 2], 'AS') && isName(last)) {
      alias = last.v;
      expr = item.slice(0, -2);
    } else if (item.length >= 2 && isName(last) && !(last.k === 'word' && NOT_REFERENCES.has(last.u))) {
      const before = item[item.length - 2];
      if (isName(before) || isP(before, ')') || before.k === 'str' || before.k === 'num') {
        alias = last.v;
        expr = item.slice(0, -1);
      }
    }
    const explicit = names?.[index];
    const direct = readName(expr, 0);
    if (direct && direct.next === expr.length) {
      const column = direct.parts[direct.parts.length - 1];
      const qualifier = direct.parts.slice(0, -1);
      const entity = qualifier.length > 0 ? (byQualifier.get(lower(qualifier.join('.'))) ?? byQualifier.get(lower(qualifier[qualifier.length - 1]))) : owning(column);
      const src = entity ? source(entity, column) : undefined;
      add(explicit ?? alias ?? column, src?.type, src ? [src] : [], 'copia');
      continue;
    }
    const outName = explicit ?? alias;
    if (!outName) continue;
    const from: Array<{ entity: Entity; column: string }> = [];
    for (let i = 0; i < expr.length; i += 1) {
      const t = expr[i];
      if (!isName(t) || isP(expr[i - 1], '.') || isP(expr[i + 1], '(') || isW(expr[i - 1], 'AS') || isP(expr[i - 1], ':')) continue;
      if (isP(expr[i + 1], '.')) {
        const col = readName(expr, i);
        if (!col || col.parts.length < 2) continue;
        const entity = byQualifier.get(lower(col.parts.slice(0, -1).join('.'))) ?? byQualifier.get(lower(col.parts[col.parts.length - 2]));
        const src = entity ? source(entity, col.parts[col.parts.length - 1]) : undefined;
        if (src) from.push(src);
        i = col.next - 1;
      } else if (t.k === 'qid' || !NOT_REFERENCES.has(t.u)) {
        const entity = owning(t.v);
        const src = entity ? source(entity, t.v) : undefined;
        if (src) from.push(src);
      }
    }
    const text = renderTokens(expr);
    add(outName, undefined, from, text.length > 90 ? `${text.slice(0, 87)}…` : text);
  }
  return columns.length > 0 ? { columns, mappings } : undefined;
}

/**
 * Importa un DDL de SQL como documento de datos (ver la cabecera de este archivo para el mapeo).
 */
export function fromDdl(source: string, options: DataImportOptions = {}): DataImportResult {
  const text = source.replace(/^﻿/, '');
  if (!text.trim()) throw new DataImportError('El texto SQL está vacío.');
  const ddl = new Ddl();
  for (const st of splitStatements(tokenize(text))) ddl.statement(st);
  ddl.settle();

  const missing = new Set<string>();
  // Claves foráneas → relaciones.
  const links: Link[] = [];
  for (const fk of ddl.fks) {
    const parent = ddl.resolve(fk.ref, fk.line, missing);
    if (!parent) continue;
    if (parent === fk.table) {
      ddl.warnings.add(`línea ${fk.line}: «${fk.table.name}» se refiere a sí misma (${fk.cols.join(', ')}); el modelo de datos no admite relaciones recursivas, solo se marca la columna como clave foránea.`);
      continue;
    }
    const cols = fk.cols.map((c) => fk.table.columns.find((x) => lower(x.name) === lower(c))).filter((c): c is ColDef => !!c);
    const mandatory = cols.length > 0 && cols.every((c) => c.notNull || c.pk);
    const set = new Set(fk.cols.map(lower));
    const unique = fk.table.unique.some((u) => u.every((c) => set.has(c)));
    if (!links.some((l) => l.child === fk.table && l.parent === parent && l.cols.join() === fk.cols.join())) links.push({ child: fk.table, parent, cols: fk.cols, mandatory, unique });
  }

  // Vistas y `CREATE TABLE AS` → linaje.
  const lineages: Lineage[] = [];
  for (const view of [...ddl.order]) {
    if (!view.query) continue;
    const info = analyzeSelect(view.query.tokens);
    const label = view.kind === 'view' ? 'la vista' : 'la tabla';
    const named = view.schema ? `${view.schema}.${view.name}` : view.name;
    if (info.problem) {
      ddl.warnings.add(`línea ${view.line}: no se pudo deducir el linaje de ${label} «${named}» (${info.problem}); se importa sin pipeline.`);
      if (view.query.names) view.columns = view.query.names.map((name) => ({ name, notNull: false, pk: false, uk: false, fk: false }));
      continue;
    }
    const sources = info.refs.map((ref) => ({ ref, entity: ddl.resolve(ref.parts, ref.line, missing) }));
    const inputs = [...new Set(sources.map((s) => s.entity).filter((e): e is Entity => !!e && e !== view))];
    if (inputs.length === 0) {
      ddl.warnings.add(`línea ${view.line}: ${label} «${named}» no lee ninguna tabla que se pueda identificar; se importa sin pipeline.`);
      continue;
    }
    const derived = info.items.length > 0 ? selectColumns(info, sources, view.query.names) : undefined;
    const columns = derived?.columns ?? view.query.names?.map((name): ColDef => ({ name, notNull: false, pk: false, uk: false, fk: false }));
    if (columns) view.columns = columns;
    lineages.push({ view, inputs, mappings: derived?.mappings ?? [], columns });
  }
  if (missing.size > 0) {
    const list = [...missing];
    ddl.warnings.add(`${list.length} tabla(s) se leen o se referencian pero no están definidas en el DDL; se crean vacías para conservar el linaje y las relaciones: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}.`);
  }

  // Ids: contenedores por esquema, después tablas y vistas; los nombres repetidos entre esquemas llevan el esquema delante.
  const ids = new Set<string>();
  const schemas = new Map<string, { id: string; name: string }>();
  for (const e of ddl.order) {
    if (!e.schema || schemas.has(lower(e.schema))) continue;
    schemas.set(lower(e.schema), { id: pickId(slugify(e.schema) || 'esquema', ids), name: e.schema });
  }
  const names = new Map<string, number>();
  for (const e of ddl.order) names.set(lower(e.name), (names.get(lower(e.name)) ?? 0) + 1);
  const idOf = new Map<Entity, string>();
  for (const e of ddl.order) idOf.set(e, pickId(slugify(e.schema ? `${e.schema}-${e.name}` : e.name) || (e.kind === 'view' ? 'vista' : 'tabla'), ids));

  const asset = (e: Entity): DataAsset => {
    const columns: Column[] = e.columns.map((c) => {
      const keys = COLUMN_KEY_ORDER.filter((k) => c[k]);
      return {
        name: c.name,
        ...(c.type ? { type: c.type } : {}),
        ...(keys.length > 0 ? { keys } : {}),
        ...(!c.notNull && !c.pk && !e.query ? { nullable: true } : {}),
        ...(c.description ? { description: c.description } : {}),
      };
    });
    const tags = [...(e.materialized ? ['materializada'] : []), ...(e.temp ? ['temporal'] : [])];
    return {
      id: idOf.get(e)!,
      kind: e.kind,
      name: e.schema && (names.get(lower(e.name)) ?? 0) > 1 ? `${e.schema}.${e.name}` : e.name,
      ...(e.description ? { description: e.description } : {}),
      ...(e.schema ? { parentId: schemas.get(lower(e.schema))!.id } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(columns.length > 0 ? { columns } : {}),
    };
  };
  const containers: DataAsset[] = [...schemas.entries()].map(([key, s]) => ({
    id: s.id,
    kind: 'database',
    name: s.name,
    description: ddl.schemaComments.get(key) ?? `Esquema «${s.name}» del DDL importado.`,
  }));
  const assets = [...containers, ...ddl.order.map(asset)];

  const relationIds = new Set<string>();
  const relations: Relation[] = links.map((l) => {
    const cardinality: Cardinality = l.unique ? '1:1' : '1:N';
    return {
      id: pickId(`${idOf.get(l.parent)}--${idOf.get(l.child)}`, relationIds),
      sourceId: idOf.get(l.parent)!,
      targetId: idOf.get(l.child)!,
      cardinality,
      description: `${l.cols.join(', ')} · ${l.mandatory ? '1..1' : '0..1'} → ${l.unique ? '0..1' : '0..N'}`,
    };
  });

  const pipelineIds = new Set<string>();
  const reserved = new Set(ids);
  const pipelines: Pipeline[] = lineages.map((l) => {
    const target = idOf.get(l.view)!;
    const named = asset(l.view).name;
    const mappings: ColumnMapping[] = l.mappings
      .filter((m) => m.from !== l.view)
      .map((m) => ({ from: { assetId: idOf.get(m.from)!, column: m.fromColumn }, to: { assetId: target, column: m.toColumn }, transform: m.transform }));
    return {
      id: pickId(`${l.view.kind === 'view' ? (l.view.materialized ? 'vista-materializada' : 'vista') : 'carga'}-${target}`, pipelineIds, reserved),
      name: l.view.kind === 'view' ? `${l.view.materialized ? 'Vista materializada' : 'Vista'} ${named}` : `Carga de ${named}`,
      kind: 'elt',
      inputs: l.inputs.map((e) => idOf.get(e)!),
      outputs: [target],
      tool: 'SQL',
      ...(l.view.kind === 'view' && !l.view.materialized ? { schedule: 'en cada consulta' } : {}),
      ...(mappings.length > 0 ? { mappings } : {}),
    };
  });

  const hint = personalHint(ddl.order.flatMap((e) => e.columns.map((c) => ({ table: e.name, column: c.name }))));
  if (hint) ddl.warnings.add(hint);
  ddl.summary();

  if (ddl.order.length === 0) {
    const why = ddl.warnings.result();
    throw new DataImportError(
      `El SQL no define ninguna tabla ni vista que se pueda importar (se buscan CREATE TABLE y CREATE VIEW).${why.length > 0 ? ` ${why[0]}` : ''}`,
    );
  }
  const name = options.name?.trim() || options.fallbackName?.trim().replace(/\.(sql|ddl)$/i, '') || 'Modelo de datos SQL';
  const result = validateDataDocument({ version: DATA_DOCUMENT_VERSION, workspace: { name }, domains: [], assets, pipelines, relations });
  if (!result.ok) throw new DataImportError(`No se pudo construir un documento válido a partir del SQL:\n${formatDataIssues(result.issues)}`);
  return { document: result.document, warnings: ddl.warnings.result() };
}
