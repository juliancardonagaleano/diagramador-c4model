import { pickId, Warnings } from '@iark/kernel';
import { formatDataIssues, validateDataDocument } from '../schema';
import {
  CLASSIFICATIONS,
  DATA_DOCUMENT_VERSION,
  type AssetKind,
  type Cardinality,
  type Classification,
  type Column,
  type ColumnKey,
  type DataAsset,
  type Domain,
  type Pipeline,
  type Relation,
} from '../types';
import { slugify } from './common';
import { DataImportError, type DataImportOptions, type DataImportResult } from './fromMermaid';

/**
 * Importa el `manifest.json` de dbt (`target/manifest.json`) como documento de datos.
 *
 * Qué entrada pasa a qué elemento:
 * - `sources` → activos `table` colgados de una fuente (`source`) por cada grupo (`source_name`); la fuente toma su descripción y
 *   su cargador (`loader`) como tecnología.
 * - `models`, `seeds` y `snapshots` → activos `table` o `view` (view, ephemeral y materialized_view son vistas; el resto, tablas)
 *   colgados de un almacén (`warehouse`) por cada `base.esquema`. La materialización va como metadato en `technology`
 *   (`dbt · incremental`). Sus columnas son las documentadas (`columns`: nombre, `data_type`, `description`).
 * - Linaje: un pipeline `elt` por modelo o snapshot que une los activos de `depends_on.nodes` con él, con `dbt` como herramienta
 *   (y `meta.schedule` como frecuencia, si lo declara). Un seed sale de su CSV (`seeds/x.csv`, un `file` en la fuente «Seeds de
 *   dbt») por un pipeline `batch`. dbt no publica el linaje de columnas: no se crean mapeos.
 * - Pruebas (`tests`): `unique` → `uk`, `not_null` → columna obligatoria y `relationships` → relación entre los dos modelos (el
 *   referenciado como origen, `1:1` si la columna es única y `1:N` si no; la descripción lleva la opcionalidad, igual que en el DDL:
 *   `cliente_id · 1..1 → 0..N`) y `fk` en la columna. Si una sola columna del modelo es a la vez `unique` y `not_null`, se toma
 *   por clave primaria (convención de dbt) y se avisa; las restricciones declaradas (`constraints`: `primary_key`, `unique`,
 *   `foreign_key`) valen sin más. Las pruebas con `where` no son una garantía general y no cuentan.
 * - Gobierno, solo lo que el manifest declara: `meta.owner` (o el propietario del `group`) → responsable; `meta.steward` → custodio;
 *   `meta.domain` o el `group` → dominio; `meta.classification` → clasificación; `meta.contains_pii` (o `meta.pii`) en el modelo o en
 *   una columna → datos personales; `meta.retention` → retención; `tags` → etiquetas. Nada se deduce de nombres ni etiquetas.
 * - `exposures` → activos `report` (o `model` si son de tipo `ml`) con un pipeline `batch` desde los activos de los que dependen.
 *
 * No se mapea (se resume en un aviso): `analysis`, `operation`, macros del proyecto, métricas, modelos semánticos, consultas
 * guardadas, pruebas unitarias, pruebas de otros tipos y nodos deshabilitados.
 */

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
const truthy = (v: unknown): boolean => v === true || (typeof v === 'string' && /^(?:true|yes|si|sí)$/i.test(v.trim()));
/** Los objetos hijos de un objeto, en el orden del archivo (las columnas se quedan como se documentaron). */
const inOrder = (v: unknown): Array<[string, Json]> => Object.entries(rec(v) ?? {}).flatMap(([k, x]): Array<[string, Json]> => (rec(x) ? [[k, x as Json]] : []));
/** Lo mismo, por clave: el resultado no depende del orden en que dbt escribió el manifest. */
const entries = (v: unknown): Array<[string, Json]> => inOrder(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const CLASSIFICATION_ALIASES: Record<string, Classification> = {
  public: 'public',
  publica: 'public',
  pública: 'public',
  internal: 'internal',
  interna: 'internal',
  interno: 'internal',
  confidential: 'confidential',
  confidencial: 'confidential',
  restricted: 'restricted',
  restringida: 'restricted',
  restringido: 'restricted',
};
const ADAPTERS: Record<string, string> = {
  snowflake: 'Snowflake',
  postgres: 'PostgreSQL',
  bigquery: 'BigQuery',
  redshift: 'Redshift',
  databricks: 'Databricks',
  duckdb: 'DuckDB',
  spark: 'Spark',
  trino: 'Trino',
  sqlserver: 'SQL Server',
  mysql: 'MySQL',
  oracle: 'Oracle',
  athena: 'Athena',
  clickhouse: 'ClickHouse',
};
const VIEW_MATERIALIZATIONS = new Set(['view', 'ephemeral', 'materialized_view']);

/** `dbt/<artefacto>/v<n>` de `metadata.dbt_schema_version`. */
const artifactOf = (version: unknown): string | undefined => /dbt\/([a-z-]+)\/v\d+/.exec(String(version ?? ''))?.[1];

/** ¿El texto es un `manifest.json` de dbt? Por `metadata.dbt_schema_version` o por las claves `nodes` y `sources`/`child_map`. */
export function looksLikeDbtManifest(text: string): boolean {
  const head = text.slice(0, 8000);
  if (!/^\s*\{/.test(head)) return false;
  if (/"dbt_schema_version"\s*:\s*"[^"]*dbt\//.test(head)) return true;
  if (text.length > 80_000_000) return false;
  try {
    const json = rec(JSON.parse(text));
    if (!json) return false;
    if (str(rec(json.metadata)?.dbt_schema_version)?.includes('dbt/')) return true;
    return rec(json.nodes) !== undefined && (rec(json.sources) !== undefined || rec(json.child_map) !== undefined);
  } catch {
    return false;
  }
}

interface Item {
  uid: string;
  type: 'source' | 'model' | 'seed' | 'snapshot';
  node: Json;
  depth: number;
}

interface TestFacts {
  unique: Set<string>;
  notNull: Set<string>;
}

/** `ref('x')`, `ref('pkg', 'x')` o `source('a', 'b')` dentro de un texto de dbt. */
function parseRef(text: string | undefined): { type: 'ref'; name: string; pkg?: string } | { type: 'source'; source: string; name: string } | undefined {
  if (!text) return undefined;
  const source = /\bsource\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/.exec(text);
  if (source) return { type: 'source', source: source[1], name: source[2] };
  const ref = /\bref\(\s*(?:['"]([^'"]+)['"]\s*,\s*)?['"]([^'"]+)['"]/.exec(text);
  return ref ? { type: 'ref', name: ref[2], ...(ref[1] ? { pkg: ref[1] } : {}) } : undefined;
}

/**
 * Importa el manifest de dbt como documento de datos (ver la cabecera de este archivo para el mapeo).
 */
export function fromDbt(source: string, options: DataImportOptions = {}): DataImportResult {
  if (!source.trim()) throw new DataImportError('El manifest de dbt está vacío.');
  let json: Json | undefined;
  try {
    json = rec(JSON.parse(source));
  } catch (error) {
    throw new DataImportError(`El archivo no es JSON válido: ${(error as Error).message}`);
  }
  if (!json) throw new DataImportError('El JSON no es un manifest de dbt: se esperaba un objeto con `metadata` y `nodes`.');
  const metadata = rec(json.metadata);
  const artifact = artifactOf(metadata?.dbt_schema_version);
  if (artifact && artifact !== 'manifest') {
    throw new DataImportError(`El JSON es un artefacto de dbt «${artifact}», no el manifest: importa \`target/manifest.json\`.`);
  }
  if (!artifact && !(rec(json.nodes) && (rec(json.sources) || rec(json.child_map)))) {
    throw new DataImportError('El JSON no parece un manifest de dbt: falta `metadata.dbt_schema_version` y las claves `nodes` y `sources`.');
  }

  const warnings = new Warnings();
  const skipped = new Map<string, number>();
  const skip = (label: string): void => void skipped.set(label, (skipped.get(label) ?? 0) + 1);
  const projectName = str(metadata?.project_name);

  // ───────── nodos que se importan ─────────
  const enabled = (node: Json): boolean => rec(node.config)?.enabled !== false;
  const items: Item[] = [];
  for (const [uid, node] of entries(json.sources)) {
    if (enabled(node)) items.push({ uid, type: 'source', node, depth: 0 });
    else skip('nodos deshabilitados');
  }
  const tests: Array<[string, Json]> = [];
  for (const [uid, node] of entries(json.nodes)) {
    const type = str(node.resource_type) ?? uid.split('.')[0];
    if (type === 'model' || type === 'seed' || type === 'snapshot') {
      if (enabled(node)) items.push({ uid, type, node, depth: 0 });
      else skip('nodos deshabilitados');
    } else if (type === 'test') {
      if (enabled(node)) tests.push([uid, node]);
    } else skip(type === 'sql_operation' || type === 'rpc' ? 'operation' : type);
  }
  const byUid = new Map(items.map((i) => [i.uid, i]));

  // Profundidad en el linaje: las fuentes primero, y cada modelo después de lo que lee (para ordenar los activos por capas).
  const depthOf = (uid: string, path: Set<string> = new Set()): number => {
    const item = byUid.get(uid);
    if (!item || path.has(uid)) return 0;
    if (item.depth > 0 || item.type === 'source') return item.depth;
    path.add(uid);
    const deps = strs(rec(item.node.depends_on)?.nodes).filter((d) => byUid.has(d));
    item.depth = deps.length === 0 ? 1 : 1 + Math.max(...deps.map((d) => depthOf(d, path)));
    path.delete(uid);
    return item.depth;
  };
  for (const item of items) depthOf(item.uid);
  items.sort((a, b) => a.depth - b.depth || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

  const exposures = entries(json.exposures).filter(([, e]) => {
    if (rec(e.config)?.enabled === false) {
      skip('nodos deshabilitados');
      return false;
    }
    return true;
  });
  for (const key of ['metrics', 'semantic_models', 'saved_queries', 'unit_tests']) {
    const n = Object.keys(rec(json[key]) ?? {}).length;
    if (n > 0) skipped.set(key, n);
  }
  const projectMacros = entries(json.macros).filter(([, m]) => (projectName ? str(m.package_name) === projectName : false)).length;
  if (projectMacros > 0) skipped.set('macros del proyecto', projectMacros);
  const disabled = Object.keys(rec(json.disabled) ?? {}).length;
  if (disabled > 0) skipped.set('nodos deshabilitados', (skipped.get('nodos deshabilitados') ?? 0) + disabled);

  if (items.length === 0) throw new DataImportError('El manifest no tiene models, seeds, snapshots ni sources que importar.');

  // ───────── gobierno declarado: grupos, dominios, propietarios ─────────
  const groups = new Map<string, string | undefined>();
  for (const [, g] of entries(json.groups)) {
    const name = str(g.name);
    if (name) groups.set(name, str(rec(g.owner)?.name) ?? str(rec(g.owner)?.email));
  }
  const domains = new Map<string, Domain>();
  const domainIds = new Set<string>();
  const domainFor = (name: string | undefined, owner?: string): string | undefined => {
    if (!name) return undefined;
    const key = slugify(name) || name;
    let d = domains.get(key);
    if (!d) {
      d = { id: pickId(key, domainIds), name, ...(owner ? { owner } : {}) };
      domains.set(key, d);
    } else if (owner && !d.owner) d.owner = owner;
    return d.id;
  };
  const ownerName = (v: unknown): string | undefined => str(v) ?? str(rec(v)?.name) ?? str(rec(v)?.email);
  const metaOf = (node: Json): Json => ({ ...rec(rec(node.config)?.meta), ...rec(node.meta) });
  const classificationOf = (meta: Json, label: string): Classification | undefined => {
    const raw = str(meta.classification);
    if (!raw) return undefined;
    const found = CLASSIFICATION_ALIASES[raw.toLowerCase()];
    if (!found) warnings.add(`${label}: meta.classification «${raw}» no es una clasificación (${CLASSIFICATIONS.join(', ')}); se ignora.`);
    return found;
  };
  const governance = (node: Json, label: string): Partial<DataAsset> => {
    const meta = metaOf(node);
    const group = str(node.group) ?? str(rec(node.config)?.group);
    const owner = ownerName(meta.owner) ?? (group ? groups.get(group) : undefined);
    const steward = ownerName(meta.steward) ?? ownerName(meta.data_steward);
    const domainId = domainFor(str(meta.domain) ?? group, group && !str(meta.domain) ? groups.get(group) : undefined);
    const classification = classificationOf(meta, label);
    const retention = str(meta.retention) ?? (typeof meta.retention === 'number' ? String(meta.retention) : undefined);
    return {
      ...(owner ? { owner } : {}),
      ...(steward ? { steward } : {}),
      ...(domainId ? { domainId } : {}),
      ...(classification ? { classification } : {}),
      ...(truthy(meta.contains_pii) || truthy(meta.pii) ? { pii: true } : {}),
      ...(retention ? { retention } : {}),
    };
  };
  const tagsOf = (node: Json): string[] => [...new Set([...strs(node.tags), ...strs(rec(node.config)?.tags)])];

  // ───────── pruebas: pistas de claves y relaciones ─────────
  const refIndex = new Map<string, string[]>();
  const sourceIndex = new Map<string, string>();
  for (const i of items) {
    const name = str(i.node.name) ?? i.uid;
    if (i.type === 'source') sourceIndex.set(`${str(i.node.source_name) ?? ''}.${name}`, i.uid);
    else refIndex.set(name, [...(refIndex.get(name) ?? []), i.uid]);
  }
  const resolveRef = (text: string | undefined, fromPackage: string | undefined): string | undefined => {
    const parsed = parseRef(text);
    if (!parsed) return undefined;
    if (parsed.type === 'source') return sourceIndex.get(`${parsed.source}.${parsed.name}`);
    const candidates = (refIndex.get(parsed.name) ?? []).filter((uid) => !parsed.pkg || str(byUid.get(uid)!.node.package_name) === parsed.pkg);
    if (candidates.length <= 1) return candidates[0];
    return candidates.find((uid) => str(byUid.get(uid)!.node.package_name) === fromPackage);
  };
  const facts = new Map<string, TestFacts>();
  const factsOf = (uid: string): TestFacts => {
    let f = facts.get(uid);
    if (!f) facts.set(uid, (f = { unique: new Set(), notNull: new Set() }));
    return f;
  };
  interface Link {
    child: string;
    column: string;
    parent: string;
    field?: string;
  }
  const links: Link[] = [];
  const otherTests = new Map<string, number>();
  const countTest = (label: string): void => void otherTests.set(label, (otherTests.get(label) ?? 0) + 1);
  for (const [uid, test] of tests) {
    const meta = rec(test.test_metadata);
    if (!meta) {
      countTest('singulares');
      continue;
    }
    const kwargs = rec(meta.kwargs) ?? {};
    const name = str(meta.name) ?? 'desconocida';
    const namespace = str(meta.namespace);
    const kind = namespace ? `${namespace}.${name}` : name;
    const attached = str(test.attached_node) ?? resolveRef(typeof kwargs.model === 'string' ? kwargs.model : undefined, str(test.package_name));
    const column = str(test.column_name) ?? str(kwargs.column_name);
    const conditional = (str(rec(test.config)?.where) ?? str(kwargs.where)) !== undefined;
    if (!['unique', 'not_null', 'relationships'].includes(kind) || !column) {
      countTest(kind);
      continue;
    }
    if (conditional) {
      countTest(`${kind} con where`);
      continue;
    }
    if (!attached || !byUid.has(attached)) continue;
    if (kind === 'unique') factsOf(attached).unique.add(column);
    else if (kind === 'not_null') factsOf(attached).notNull.add(column);
    else {
      const parent = resolveRef(typeof kwargs.to === 'string' ? kwargs.to : undefined, str(test.package_name));
      if (!parent) warnings.add(`La prueba «${str(test.name) ?? uid}» (relationships) apunta a un modelo que no está en el manifest; no se crea la relación.`);
      else links.push({ child: attached, column, parent, field: str(kwargs.field) });
    }
  }

  // ───────── activos ─────────
  const adapter = str(metadata?.adapter_type);
  const technology = adapter ? (ADAPTERS[adapter] ?? adapter) : undefined;
  const ids = new Set<string>();
  const assetId = new Map<string, string>();
  const assets: DataAsset[] = [];
  const pipelines: Pipeline[] = [];
  const pipelineIds = new Set<string>();
  const reserved = new Set<string>();
  const lineAssets = new Map<string, DataAsset>();

  const sourceGroups = new Map<string, DataAsset>();
  const warehouses = new Map<string, DataAsset>();
  const ownersByContainer = new Map<string, Array<string | undefined>>();
  const noteOwner = (container: DataAsset, owner: string | undefined): void => void ownersByContainer.set(container.id, [...(ownersByContainer.get(container.id) ?? []), owner]);
  const sourceGroup = (item: Item): DataAsset => {
    const name = str(item.node.source_name) ?? 'dbt';
    let g = sourceGroups.get(name);
    if (!g) {
      const description = str(item.node.source_description);
      const loader = str(item.node.loader);
      const owner = ownerName(rec(item.node.source_meta)?.owner);
      g = { id: pickId(slugify(name) || 'fuente', ids), kind: 'source', name, ...(description ? { description } : {}), ...(loader ? { technology: loader } : {}), ...(owner ? { owner } : {}) };
      sourceGroups.set(name, g);
      assets.push(g);
    }
    return g;
  };
  const warehouse = (item: Item): DataAsset => {
    const name = [str(item.node.database), str(item.node.schema)].filter(Boolean).join('.') || 'Almacén dbt';
    let w = warehouses.get(name);
    if (!w) {
      const schema = str(item.node.schema);
      const database = str(item.node.database);
      const description = schema ? `Esquema «${schema}»${database ? ` de la base «${database}»` : ''} donde dbt materializa sus modelos.` : undefined;
      w = { id: pickId(slugify(name) || 'almacen', ids), kind: 'warehouse', name, ...(description ? { description } : {}), ...(technology ? { technology } : {}) };
      warehouses.set(name, w);
      assets.push(w);
    }
    return w;
  };

  const columnsOf = (item: Item, keys: Map<string, Set<ColumnKey>>): Column[] =>
    inOrder(item.node.columns).map(([key, c]) => {
      const name = str(c.name) ?? key;
      const type = str(c.data_type);
      const description = str(c.description);
      const k = [...(keys.get(name) ?? [])].sort((a, b) => ['pk', 'fk', 'uk'].indexOf(a) - ['pk', 'fk', 'uk'].indexOf(b));
      return {
        name,
        ...(type ? { type } : {}),
        ...(k.length > 0 ? { keys: k } : {}),
        ...(truthy(metaOf(c).contains_pii) || truthy(metaOf(c).pii) ? { pii: true } : {}),
        ...(description ? { description } : {}),
      };
    });

  // Claves por activo: restricciones declaradas y, si no, lo que dicen las pruebas.
  const keysOf = new Map<string, Map<string, Set<ColumnKey>>>();
  const addKey = (uid: string, column: string, key: ColumnKey): void => {
    const per = keysOf.get(uid) ?? new Map<string, Set<ColumnKey>>();
    keysOf.set(uid, per);
    per.set(column, new Set([...(per.get(column) ?? []), key]));
  };
  const inferred: string[] = [];
  const constraintLinks: Link[] = [];
  for (const item of items) {
    const explicit = new Set<string>();
    const declared = (c: Json, columns: string[]): void => {
      const type = str(c.type);
      for (const column of columns) {
        if (type === 'primary_key') {
          addKey(item.uid, column, 'pk');
          explicit.add(column);
        } else if (type === 'unique' && columns.length === 1) {
          addKey(item.uid, column, 'uk');
          factsOf(item.uid).unique.add(column);
        } else if (type === 'not_null') factsOf(item.uid).notNull.add(column);
      }
      if (type === 'foreign_key') {
        const parent = resolveRef(str(c.to), str(item.node.package_name));
        const field = strs(c.to_columns)[0];
        if (parent && columns.length === 1) constraintLinks.push({ child: item.uid, column: columns[0], parent, field });
      }
    };
    for (const [key, col] of inOrder(item.node.columns)) {
      for (const c of Array.isArray(col.constraints) ? col.constraints : []) if (rec(c)) declared(rec(c)!, [str(col.name) ?? key]);
    }
    for (const c of Array.isArray(item.node.constraints) ? item.node.constraints : []) if (rec(c)) declared(rec(c)!, strs(rec(c)!.columns));
    // unique + not_null en una sola columna = clave primaria por convención de dbt.
    const f = factsOf(item.uid);
    const both = [...f.unique].filter((c) => f.notNull.has(c));
    const hasPk = [...(keysOf.get(item.uid)?.values() ?? [])].some((s) => s.has('pk'));
    for (const column of f.unique) {
      if (!hasPk && both.length === 1 && both[0] === column) {
        addKey(item.uid, column, 'pk');
        inferred.push(`${str(item.node.name) ?? item.uid}.${column}`);
      } else if (!keysOf.get(item.uid)?.get(column)?.has('pk')) addKey(item.uid, column, 'uk');
    }
  }
  for (const l of [...links, ...constraintLinks]) addKey(l.child, l.column, 'fk');

  const seedsGroup: { asset?: DataAsset } = {};
  const seedFiles: Array<{ item: Item; file: DataAsset }> = [];
  for (const item of items) {
    const name = str(item.node.name) ?? item.uid;
    const label = `${item.type === 'source' ? 'La fuente' : 'El modelo'} «${name}»`;
    const config = rec(item.node.config);
    const materialized = str(config?.materialized) ?? (item.type === 'model' ? 'view' : item.type);
    const kind: AssetKind = item.type === 'model' && VIEW_MATERIALIZATIONS.has(materialized) ? 'view' : 'table';
    const parent = item.type === 'source' ? sourceGroup(item) : warehouse(item);
    const version = item.node.version !== undefined && item.node.version !== null ? ` v${String(item.node.version)}` : '';
    const description = str(item.node.description);
    const gov = governance(item.node, label);
    const columns = columnsOf(item, keysOf.get(item.uid) ?? new Map());
    const tags = [...tagsOf(item.node), ...(materialized === 'materialized_view' ? ['materializada'] : [])];
    const asset: DataAsset = {
      id: pickId(slugify(item.type === 'source' ? `${str(item.node.source_name) ?? ''}-${name}` : `${name}${version}`) || 'activo', ids),
      kind,
      name: `${name}${version}`,
      ...(description ? { description } : {}),
      ...(item.type === 'source' ? {} : { technology: `dbt · ${item.type === 'model' ? materialized : item.type}` }),
      ...gov,
      parentId: parent.id,
      ...(tags.length > 0 ? { tags } : {}),
      ...(columns.length > 0 ? { columns } : {}),
    };
    assetId.set(item.uid, asset.id);
    noteOwner(parent, gov.owner);
    assets.push(asset);
    lineAssets.set(asset.id, asset);
    if (item.type === 'seed') {
      // El seed sale del CSV del repositorio.
      const path = str(item.node.original_file_path) ?? `seeds/${name}.csv`;
      seedsGroup.asset ??= { id: pickId('seeds-de-dbt', ids), kind: 'source', name: 'Seeds de dbt', description: 'Archivos CSV del repositorio que `dbt seed` carga como tablas.', technology: 'CSV' };
      const file: DataAsset = { id: pickId(slugify(path.replace(/^.*\//, '')) || `${asset.id}-csv`, ids), kind: 'file', name: path.replace(/^.*\//, ''), description: `Seed «${name}» (${path}).`, technology: 'CSV', parentId: seedsGroup.asset.id, ...(gov.owner ? { owner: gov.owner } : {}) };
      seedFiles.push({ item, file });
    }
  }
  if (seedsGroup.asset) assets.push(seedsGroup.asset, ...seedFiles.map((s) => s.file));

  // Responsable de los contenedores: el de sus hijos, si todos declaran el mismo (el de la fuente, si lo declara, manda).
  for (const container of [...sourceGroups.values(), ...warehouses.values()]) {
    const owners = ownersByContainer.get(container.id) ?? [];
    const first = owners[0];
    if (!container.owner && first && owners.every((o) => o === first)) container.owner = first;
  }
  if (seedsGroup.asset) {
    const owners = [...new Set(seedFiles.map((s) => s.file.owner))];
    if (owners.length === 1 && owners[0]) seedsGroup.asset.owner = owners[0];
  }

  // ───────── exposiciones → informes y modelos ─────────
  const exposureAssets: Array<{ uid: string; asset: DataAsset; node: Json }> = [];
  for (const [uid, node] of exposures) {
    const name = str(node.label) ?? str(node.name) ?? uid;
    const type = str(node.type) ?? 'dashboard';
    const gov = governance(node, `La exposición «${name}»`);
    const owner = ownerName(node.owner) ?? gov.owner;
    const url = str(node.url);
    const description = [str(node.description), url ? `Enlace: ${url}` : undefined].filter(Boolean).join('\n');
    const tags = tagsOf(node);
    const asset: DataAsset = {
      id: pickId(slugify(str(node.name) ?? name) || 'exposicion', ids),
      kind: type === 'ml' ? 'model' : 'report',
      name,
      ...(description ? { description } : {}),
      technology: type,
      ...gov,
      ...(owner ? { owner } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    assets.push(asset);
    assetId.set(uid, asset.id);
    exposureAssets.push({ uid, asset, node });
  }
  for (const a of assets) reserved.add(a.id);

  // ───────── pipelines ─────────
  const missing = new Set<string>();
  const inputsOf = (node: Json, self: string): string[] => {
    const result: string[] = [];
    for (const dep of strs(rec(node.depends_on)?.nodes)) {
      const id = assetId.get(dep);
      if (id) {
        if (id !== self && !result.includes(id)) result.push(id);
      } else if (/^(?:model|seed|snapshot|source)\./.test(dep)) missing.add(dep);
    }
    return result;
  };
  for (const item of items) {
    const id = assetId.get(item.uid)!;
    const name = str(item.node.name) ?? item.uid;
    const meta = metaOf(item.node);
    const schedule = str(meta.schedule);
    if (item.type === 'seed') {
      const file = seedFiles.find((s) => s.item === item)!.file;
      pipelines.push({ id: pickId(`dbt-seed-${id}`, pipelineIds, reserved), name: `dbt seed: ${name}`, kind: 'batch', inputs: [file.id], outputs: [id], tool: 'dbt seed', ...(schedule ? { schedule } : {}) });
    } else if (item.type !== 'source') {
      const inputs = inputsOf(item.node, id);
      if (inputs.length === 0) continue;
      pipelines.push({
        id: pickId(`dbt-${id}`, pipelineIds, reserved),
        name: `dbt${item.type === 'snapshot' ? ' snapshot' : ''}: ${name}`,
        kind: 'elt',
        inputs,
        outputs: [id],
        tool: 'dbt',
        ...(schedule ? { schedule } : {}),
      });
    }
  }
  for (const { uid, asset, node } of exposureAssets) {
    const inputs = inputsOf(node, asset.id);
    if (inputs.length === 0) {
      warnings.add(`La exposición «${asset.name}» no depende de ningún modelo o fuente del manifest; se importa sin pipeline.`);
      continue;
    }
    pipelines.push({ id: pickId(`dbt-exposicion-${asset.id}`, pipelineIds, reserved), name: `Exposición: ${asset.name}`, kind: 'batch', inputs, outputs: [asset.id], description: `Exposición ${uid}` });
  }
  if (missing.size > 0) {
    warnings.add(`${missing.size} dependencia(s) apuntan a nodos que no están en el manifest (¿deshabilitados o de otro proyecto?) y se omiten en el linaje: ${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? ', …' : ''}.`);
  }

  // ───────── relaciones ─────────
  const relationIds = new Set<string>();
  const relations: Relation[] = [];
  const seen = new Set<string>();
  for (const l of [...links, ...constraintLinks]) {
    const child = assetId.get(l.child);
    const parent = assetId.get(l.parent);
    if (!child || !parent) continue;
    const label = `${lineAssets.get(child)?.name ?? l.child}.${l.column}`;
    if (child === parent) {
      warnings.add(`${label} apunta a su propia tabla; el modelo de datos no admite relaciones recursivas, solo se marca la columna como clave foránea.`);
      continue;
    }
    const key = `${child}|${l.column}|${parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const childFacts = factsOf(l.child);
    const unique = childFacts.unique.has(l.column) || (keysOf.get(l.child)?.get(l.column)?.has('pk') ?? false);
    const mandatory = childFacts.notNull.has(l.column) || (keysOf.get(l.child)?.get(l.column)?.has('pk') ?? false);
    const cardinality: Cardinality = unique ? '1:1' : '1:N';
    relations.push({
      id: pickId(`${parent}--${child}`, relationIds),
      sourceId: parent,
      targetId: child,
      cardinality,
      description: `${l.column} · ${mandatory ? '1..1' : '0..1'} → ${unique ? '0..1' : '0..N'}`,
    });
  }

  // ───────── avisos de lo que no se mapea ─────────
  if (inferred.length > 0) {
    warnings.add(`${inferred.length} clave(s) primaria(s) deducida(s) de unique + not_null (convención de dbt; revísalas): ${inferred.slice(0, 8).join(', ')}${inferred.length > 8 ? ', …' : ''}.`);
  }
  if (skipped.size > 0) warnings.add(`Sin mapear (no son activos de datos): ${[...skipped].map(([label, n]) => `${n} ${label}`).join(', ')}.`);
  if (otherTests.size > 0) warnings.add(`Pruebas que no dan claves ni relaciones: ${[...otherTests].map(([label, n]) => `${n} ${label}`).join(', ')}.`);

  const description = [metadata?.dbt_version ? `dbt ${String(metadata.dbt_version)}` : undefined, technology].filter(Boolean).join(' · ');
  const name = options.name?.trim() || projectName || options.fallbackName?.trim().replace(/\.json$/i, '') || 'Proyecto dbt';
  const result = validateDataDocument({
    version: DATA_DOCUMENT_VERSION,
    workspace: { name, description: `Importado de un manifest de dbt${description ? ` (${description})` : ''}.` },
    domains: [...domains.values()],
    assets,
    pipelines,
    relations,
  });
  if (!result.ok) throw new DataImportError(`No se pudo construir un documento válido a partir del manifest de dbt:\n${formatDataIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
