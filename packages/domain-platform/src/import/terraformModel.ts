/**
 * Lectura de Terraform en todas sus formas a un mismo modelo intermedio (`TfModel`): HCL (`.tf`), JSON de configuración
 * (`.tf.json`), estado (`.tfstate`, versión 4) y la salida de `terraform show -json` (de un estado o de un plan). El
 * importador de plataforma trabaja solo sobre este modelo.
 *
 * Un nodo es un recurso o una fuente de datos con sus atributos (valores literales y `HclExpr` para lo que no se evalúa), las
 * referencias a otros nodos y, en el estado y el plan, los atributos reales de cada instancia. Los valores que no son del
 * lenguaje (contraseñas del estado, por ejemplo) se quedan en memoria: el importador solo lee los atributos que mapea.
 */
import { PlatformImportError } from './fromMermaid';
import { HclExpr, HclSyntaxError, isExpr, normalizeRef, parseHcl, parseTemplateString, refsOf, type HclBlock, type HclValue } from './hcl';

export type TfValue = HclValue;
export type TfObject = { [key: string]: TfValue };

export interface TfInstance {
  /** Clave de `count` (número) o de `for_each` (cadena); `undefined` si el recurso no tiene varias instancias. */
  key?: string | number;
  attrs: TfObject;
}

export type TfAction = 'create' | 'update' | 'delete' | 'replace' | 'no-op' | 'read';

export interface TfNode {
  /** `aws_db_instance.orders`, `data.aws_ami.ubuntu` o, dentro de un módulo (estado), `module.vpc.aws_subnet.private`. */
  address: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  /** `module.vpc` si el recurso está dentro de un módulo (solo en el estado y el plan, donde se despliegan). */
  modulePath?: string;
  /** Atributos de la primera instancia (o del bloque HCL); los bloques anidados son listas de objetos. */
  attrs: TfObject;
  /** Instancias reales (estado y plan); vacío en HCL. */
  instances: TfInstance[];
  /** Direcciones a las que apunta: referencias del código, `depends_on`, dependencias del estado y ids físicos. */
  refs: string[];
  /** Solo las de `depends_on` / `dependencies`. */
  dependsOn: string[];
  /** `count`/`for_each` del HCL: número de instancias o `'dynamic'` si depende de algo que no se evalúa. */
  count?: number | 'dynamic';
  /** Acción del plan sobre este recurso. */
  action?: TfAction;
  line?: number;
}

export interface TfModule {
  name: string;
  source?: string;
  version?: string;
  attrs: TfObject;
  refs: string[];
  dependsOn: string[];
  line?: number;
}

export interface TfProvider {
  name: string;
  alias?: string;
  attrs: TfObject;
}

export interface TfModel {
  format: 'hcl' | 'json' | 'state' | 'plan';
  nodes: TfNode[];
  modules: TfModule[];
  variables: Map<string, TfValue | undefined>;
  locals: Map<string, TfValue>;
  providers: TfProvider[];
  /** Nombre del workspace de Terraform Cloud / backend remoto, si el código lo declara. */
  workspace?: string;
  /** Identificador físico (`id`, `arn`…) → dirección del nodo, para enlazar lo que el estado guarda como valores sueltos. */
  index: Map<string, string>;
  /** ¿Usa `terraform.workspace` en alguna parte? */
  usesWorkspace: boolean;
  warnings: string[];
}

const emptyModel = (format: TfModel['format']): TfModel => ({ format, nodes: [], modules: [], variables: new Map(), locals: new Map(), providers: [], index: new Map(), usesWorkspace: false, warnings: [] });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const stripIndex = (address: string): string => address.replace(/\[[^\]]*\]/g, '');

// ───────────── utilidades de lectura de valores ─────────────

/** Valor en una ruta (`vpc_config.subnet_ids`); los bloques anidados (listas de objetos) se atraviesan por su primer elemento. */
export function dig(value: unknown, path: string): TfValue | undefined {
  let current: unknown = value;
  for (const key of path.split('.')) {
    while (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object' || isExpr(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) return undefined;
  }
  return current as TfValue;
}

/** Los bloques anidados de ese nombre (varios `ingress { … }`), cada uno como objeto. */
export function blocksOf(value: unknown, key: string): TfObject[] {
  if (!isObject(value) || isExpr(value)) return [];
  return asList((value as Record<string, unknown>)[key]).filter((b): b is TfObject => isObject(b) && !isExpr(b));
}

/** Evalúa lo que se puede de un valor: variables y locales con valor literal, plantillas con ellas y `merge`/`concat`. */
export class Scope {
  usedWorkspace = false;
  constructor(private readonly model: TfModel) {}

  /** Valor evaluado, o `undefined` si depende de algo que no se conoce. Las listas conservan `undefined` en los elementos no evaluables. */
  value(v: unknown, depth = 0): unknown {
    if (v === null || typeof v !== 'object') return v;
    if (depth > 8) return undefined;
    if (isExpr(v)) return this.expr(v, depth);
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = this.value(x, depth + 1);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }

  /** Cadena (o número/booleano pasado a cadena) evaluada. */
  str(v: unknown): string | undefined {
    const r = this.value(v);
    return typeof r === 'string' ? r : typeof r === 'number' || typeof r === 'boolean' ? String(r) : undefined;
  }

  num(v: unknown): number | undefined {
    const r = this.value(v);
    if (typeof r === 'number') return r;
    if (typeof r === 'string' && r.trim() !== '' && Number.isFinite(Number(r))) return Number(r);
    return undefined;
  }

  bool(v: unknown): boolean | undefined {
    const r = this.value(v);
    if (typeof r === 'boolean') return r;
    if (r === 'true') return true;
    if (r === 'false') return false;
    return undefined;
  }

  /** Lista evaluada: solo los elementos conocidos, como cadenas. */
  strings(v: unknown): string[] {
    const r = this.value(v);
    if (typeof r === 'string') return [r];
    return Array.isArray(r) ? r.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String) : [];
  }

  /** Etiquetas (`tags`, `labels`, `tags_all`) con valor conocido. */
  tags(attrs: TfObject): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ['tags_all', 'tags', 'labels', 'user_labels']) {
      const r = this.value(attrs[key]);
      if (isObject(r)) for (const [k, x] of Object.entries(r)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x);
    }
    return out;
  }

  private refValue(text: string, depth: number): unknown {
    const m = /^(var|local)\.([A-Za-z0-9_-]+)$/.exec(text.trim());
    if (!m) {
      if (text.trim() === 'terraform.workspace') this.usedWorkspace = true;
      return undefined;
    }
    const found = m[1] === 'var' ? this.model.variables.get(m[2]) : this.model.locals.get(m[2]);
    return found === undefined ? undefined : this.value(found, depth + 1);
  }

  private expr(e: HclExpr, depth: number): unknown {
    if (e.template !== undefined) {
      let unresolved = false;
      const text = e.template.replace(/\$\{\s*([^}]*?)\s*\}/g, (_all, inner: string) => {
        const r = this.refValue(inner, depth);
        if (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') return String(r);
        unresolved = true;
        return '';
      });
      return unresolved || text.includes('%{') ? undefined : text;
    }
    if (e.call) {
      const args = e.call.args.map((a) => this.value(a, depth + 1));
      switch (e.call.fn) {
        case 'merge':
          return Object.assign({}, ...args.filter(isObject));
        case 'concat':
          return args.flatMap((a) => (Array.isArray(a) ? a : []));
        case 'tomap':
        case 'tolist':
        case 'toset':
        case 'tostring':
        case 'trimspace':
          return typeof args[0] === 'string' && e.call.fn === 'trimspace' ? args[0].trim() : args[0];
        case 'lower':
          return typeof args[0] === 'string' ? args[0].toLowerCase() : undefined;
        case 'upper':
          return typeof args[0] === 'string' ? args[0].toUpperCase() : undefined;
        default:
          return undefined;
      }
    }
    return this.refValue(e.text, depth);
  }
}

/** Nombre y número de instancias de `count` / `for_each` de un bloque HCL. */
function instanceCount(attrs: TfObject): number | 'dynamic' | undefined {
  if ('count' in attrs) return typeof attrs.count === 'number' ? attrs.count : 'dynamic';
  const each = attrs.for_each;
  if (each === undefined) return undefined;
  if (isObject(each) && !isExpr(each)) return Object.keys(each).length;
  if (isExpr(each) && each.call && ['toset', 'tolist'].includes(each.call.fn) && Array.isArray(each.call.args[0])) return each.call.args[0].length;
  return 'dynamic';
}

// ───────────── HCL ─────────────

/** Atributos de un bloque con sus bloques anidados como listas de objetos (como los da Terraform en JSON). */
function bodyToObject(block: { attrs: Record<string, HclValue>; blocks: HclBlock[] }): TfObject {
  const out: TfObject = { ...block.attrs };
  for (const nested of block.blocks) {
    const existing = out[nested.type];
    out[nested.type] = [...(Array.isArray(existing) ? existing : []), bodyToObject(nested)];
  }
  return out;
}

function addProvider(model: TfModel, name: string, attrs: TfObject): void {
  const alias = typeof attrs.alias === 'string' ? attrs.alias : undefined;
  model.providers.push({ name, ...(alias ? { alias } : {}), attrs });
}

function noteWorkspace(model: TfModel, attrs: TfObject): void {
  // terraform { cloud { workspaces { name = "..." } } } y backend "remote" { workspaces { name = "..." } }.
  const scope = new Scope(model);
  const cloud = blocksOf(attrs, 'cloud')[0];
  const remote = blocksOf(attrs, 'backend')[0];
  for (const holder of [cloud, remote]) {
    const name = holder ? scope.str(dig(holder, 'workspaces.name')) : undefined;
    if (name && !model.workspace) model.workspace = name;
  }
}

/** Un texto de HCL; con `name` (el archivo, cuando se leen varios juntos) los avisos y los errores dicen de cuál vienen. */
interface HclSource {
  name?: string;
  text: string;
}

/** `línea 3` o, con archivo, `main.tf, línea 3`. */
const hclPlace = (name: string | undefined, line: number): string => (name ? `${name}, línea ${line}` : `línea ${line}`);

function fromHcl(text: string): TfModel {
  return fromHclSources([{ text }]);
}

/** Lee varios textos de HCL como un solo stack: es lo mismo que leer su concatenación, pero cada aviso y error lleva su archivo. */
function fromHclSources(sources: HclSource[]): TfModel {
  const model = emptyModel('hcl');
  const found: Array<{ block: HclBlock; name?: string }> = [];
  for (const { name, text } of sources) {
    let file;
    try {
      file = parseHcl(text);
    } catch (error) {
      if (error instanceof HclSyntaxError) throw new PlatformImportError(`El HCL de Terraform no es válido (${hclPlace(name, error.line)}): ${error.message}.`);
      throw error;
    }
    // Los avisos del analizador empiezan por «línea N: …»: con archivo pasan a «main.tf, línea N: …».
    model.warnings.push(...file.warnings.map((w) => (name ? `${name}, ${w}` : w)));
    for (const block of file.blocks) found.push({ block, name });
  }
  const known = new Set(['resource', 'data', 'variable', 'locals', 'module', 'provider', 'terraform', 'output', 'moved', 'import', 'check', 'removed']);
  if (!found.some((f) => known.has(f.block.type))) {
    const first = model.warnings[0];
    throw new PlatformImportError(`El texto no contiene bloques de Terraform (resource, data, variable, locals, module, provider…).${first ? ` ${/^línea /.test(first) ? `${first[0].toUpperCase()}${first.slice(1)}` : first}.` : ''}`);
  }
  for (const { block, name } of found) {
    const attrs = bodyToObject(block);
    if (block.type === 'resource' || block.type === 'data') {
      const [type, label] = block.labels;
      if (!type || !label) {
        model.warnings.push(`${hclPlace(name, block.line)}: el bloque ${block.type} necesita tipo y nombre; se omite.`);
        continue;
      }
      const mode = block.type === 'data' ? 'data' : 'managed';
      const dependsOn = refsOf(attrs.depends_on);
      const count = instanceCount(attrs);
      model.nodes.push({
        address: mode === 'data' ? `data.${type}.${label}` : `${type}.${label}`,
        mode,
        type,
        name: label,
        attrs,
        instances: [],
        refs: unique([...refsOf(attrs), ...dependsOn]),
        dependsOn,
        ...(count !== undefined ? { count } : {}),
        line: block.line,
      });
    } else if (block.type === 'variable') {
      if (block.labels[0]) model.variables.set(block.labels[0], block.attrs.default);
    } else if (block.type === 'locals') {
      for (const [k, v] of Object.entries(block.attrs)) model.locals.set(k, v);
    } else if (block.type === 'provider') {
      if (block.labels[0]) addProvider(model, block.labels[0], attrs);
    } else if (block.type === 'module') {
      if (!block.labels[0]) continue;
      const source = new Scope(model).str(block.attrs.source);
      const version = new Scope(model).str(block.attrs.version);
      const dependsOn = refsOf(block.attrs.depends_on);
      model.modules.push({ name: block.labels[0], ...(source ? { source } : {}), ...(version ? { version } : {}), attrs, refs: unique([...refsOf(attrs), ...dependsOn]), dependsOn, line: block.line });
    } else if (block.type === 'terraform') noteWorkspace(model, attrs);
  }
  return finalize(model);
}

// ───────────── JSON de configuración (.tf.json) ─────────────

const TF_JSON_KEYS = ['resource', 'data', 'variable', 'locals', 'module', 'provider', 'terraform', 'output'];

/** Valor JSON de un `.tf.json`: sus cadenas son plantillas (`${aws_vpc.main.id}` es una referencia). */
function jsonValue(v: unknown, templates: boolean): TfValue {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return templates ? parseTemplateString(v) : v;
  if (Array.isArray(v)) return v.map((x) => jsonValue(x, templates));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonValue(x, templates)]));
  return null;
}

function jsonObject(v: unknown, templates: boolean): TfObject {
  const r = jsonValue(v, templates);
  return isObject(r) && !isExpr(r) ? (r as TfObject) : {};
}

function fromTfJson(json: Record<string, unknown>): TfModel {
  const model = emptyModel('json');
  const each = (section: unknown, fn: (type: string, name: string, body: unknown) => void, depth: 1 | 2): void => {
    for (const block of asList(section)) {
      if (!isObject(block)) continue;
      for (const [first, level] of Object.entries(block)) {
        if (depth === 1) for (const body of asList(level)) fn(first, first, body);
        else if (isObject(level)) for (const [second, body] of Object.entries(level)) for (const b of asList(body)) fn(first, second, b);
      }
    }
  };
  for (const [section, mode] of [['resource', 'managed'], ['data', 'data']] as const) {
    each(
      json[section],
      (type, name, body) => {
        const attrs = jsonObject(body, true);
        if (typeof attrs.depends_on !== 'undefined') attrs.depends_on = asList(jsonValue(attrs.depends_on, false)).map((d) => new HclExpr(String(d), [normalizeRef(String(d))].filter((r): r is string => !!r)));
        const dependsOn = refsOf(attrs.depends_on);
        const count = instanceCount(attrs);
        model.nodes.push({
          address: mode === 'data' ? `data.${type}.${name}` : `${type}.${name}`,
          mode,
          type,
          name,
          attrs,
          instances: [],
          refs: unique([...refsOf(attrs), ...dependsOn]),
          dependsOn,
          ...(count !== undefined ? { count } : {}),
        });
      },
      2,
    );
  }
  each(json.variable, (name, _n, body) => void model.variables.set(name, isObject(body) ? jsonValue(body.default, true) : undefined), 1);
  for (const block of asList(json.locals)) if (isObject(block)) for (const [k, v] of Object.entries(block)) model.locals.set(k, jsonValue(v, true));
  each(json.provider, (name, _n, body) => addProvider(model, name, jsonObject(body, true)), 1);
  each(
    json.module,
    (name, _n, body) => {
      const attrs = jsonObject(body, true);
      const scope = new Scope(model);
      const dependsOn = asList(isObject(body) ? body.depends_on : undefined).map((d) => normalizeRef(String(d))).filter((r): r is string => !!r);
      model.modules.push({ name, ...(scope.str(attrs.source) ? { source: scope.str(attrs.source) } : {}), ...(scope.str(attrs.version) ? { version: scope.str(attrs.version) } : {}), attrs, refs: unique([...refsOf(attrs), ...dependsOn]), dependsOn });
    },
    1,
  );
  for (const block of asList(json.terraform)) if (isObject(block)) noteWorkspace(model, jsonObject(block, true));
  return finalize(model);
}

// ───────────── estado (.tfstate) ─────────────

/** Valores de un estado o un plan: son valores finales, no plantillas. */
const plain = (v: unknown): TfValue => jsonValue(v, false);

function moduleOf(address: string): string | undefined {
  const m = /^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)+)/.exec(address);
  return m ? stripIndex(m[1].slice(0, -1)) : undefined;
}

function fromState(json: Record<string, unknown>): TfModel {
  const model = emptyModel('state');
  for (const r of asList(json.resources)) {
    if (!isObject(r) || typeof r.type !== 'string' || typeof r.name !== 'string') {
      model.warnings.push('Un recurso del estado no tiene tipo o nombre; se omite.');
      continue;
    }
    const mode = r.mode === 'data' ? 'data' : 'managed';
    const modulePath = typeof r.module === 'string' ? stripIndex(r.module) : undefined;
    const instances: TfInstance[] = [];
    const dependsOn: string[] = [];
    for (const i of asList(r.instances)) {
      if (!isObject(i)) continue;
      const key = typeof i.index_key === 'string' || typeof i.index_key === 'number' ? i.index_key : undefined;
      instances.push({ ...(key !== undefined ? { key } : {}), attrs: jsonObject(i.attributes, false) });
      for (const d of asList(i.dependencies)) if (typeof d === 'string') dependsOn.push(stripIndex(d));
    }
    const base = mode === 'data' ? `data.${r.type}.${r.name}` : `${r.type}.${r.name}`;
    model.nodes.push({
      address: modulePath ? `${modulePath}.${base}` : base,
      mode,
      type: r.type,
      name: r.name,
      ...(modulePath ? { modulePath } : {}),
      attrs: instances[0]?.attrs ?? {},
      instances,
      refs: unique(dependsOn),
      dependsOn: unique(dependsOn),
    });
  }
  return finalize(model);
}

// ───────────── terraform show -json (estado o plan) ─────────────

const ACTIONS: Record<string, TfAction> = { create: 'create', update: 'update', delete: 'delete', read: 'read', 'no-op': 'no-op' };

function actionOf(actions: unknown): TfAction | undefined {
  const list = asList(actions).filter((a): a is string => typeof a === 'string');
  if (list.includes('delete') && list.includes('create')) return 'replace';
  return list.map((a) => ACTIONS[a]).find(Boolean);
}

/** `{ references: [...] }`, `{ constant_value: … }` o un objeto de ellos (las `expressions` de la configuración del plan) como valor. */
function expressionValue(e: unknown): TfValue | undefined {
  if (Array.isArray(e)) return e.map((x) => expressionValue(x) ?? null);
  if (!isObject(e)) return undefined;
  if ('constant_value' in e) return plain(e.constant_value);
  if (Array.isArray(e.references)) return new HclExpr(e.references.join(', '), unique(e.references.map((r) => normalizeRef(String(r))).filter((r): r is string => !!r)));
  const out: TfObject = {};
  for (const [k, x] of Object.entries(e)) {
    const v = expressionValue(x);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Completa `values` (lo que ya se conoce) con las expresiones de la configuración: referencias de lo que aún no tiene valor. */
function overlay(values: TfValue | undefined, expr: TfValue | undefined): TfValue | undefined {
  if (expr === undefined) return values;
  if (values === undefined || values === null) return expr;
  if (Array.isArray(expr)) return Array.isArray(values) ? expr.map((e, i) => overlay(values[i], e) ?? null) : values;
  if (isObject(expr) && !isExpr(expr) && isObject(values) && !isExpr(values)) {
    const out: TfObject = { ...(values as TfObject) };
    for (const [k, e] of Object.entries(expr)) out[k] = overlay((values as TfObject)[k], e) ?? null;
    return out;
  }
  return values;
}

interface ShowResource {
  address: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  values: TfObject;
  dependsOn: string[];
  index?: string | number;
}

function collectShowResources(module: unknown, out: ShowResource[]): void {
  if (!isObject(module)) return;
  for (const r of asList(module.resources)) {
    if (!isObject(r) || typeof r.address !== 'string' || typeof r.type !== 'string' || typeof r.name !== 'string') continue;
    out.push({
      address: r.address,
      mode: r.mode === 'data' ? 'data' : 'managed',
      type: r.type,
      name: r.name,
      values: jsonObject(r.values, false),
      dependsOn: asList(r.depends_on).filter((d): d is string => typeof d === 'string').map(stripIndex),
      ...(typeof r.index === 'string' || typeof r.index === 'number' ? { index: r.index } : {}),
    });
  }
  for (const child of asList(module.child_modules)) collectShowResources(child, out);
}

function fromShow(json: Record<string, unknown>): TfModel {
  const planned = isObject(json.planned_values) ? json.planned_values : undefined;
  const model = emptyModel(planned || json.resource_changes ? 'plan' : 'state');
  const rootOf = (section: unknown): unknown => (isObject(section) ? section.root_module : undefined);
  const found: ShowResource[] = [];
  collectShowResources(rootOf(planned) ?? rootOf(json.values) ?? rootOf(isObject(json.prior_state) ? json.prior_state.values : undefined), found);

  const actions = new Map<string, TfAction>();
  const before = new Map<string, ShowResource>();
  for (const c of asList(json.resource_changes)) {
    if (!isObject(c) || typeof c.address !== 'string' || !isObject(c.change)) continue;
    const action = actionOf(c.change.actions);
    const address = stripIndex(c.address);
    if (action && !(actions.get(address) && actions.get(address) !== action && action === 'no-op')) actions.set(address, action);
    if (action === 'delete' && typeof c.type === 'string' && typeof c.name === 'string' && !found.some((f) => f.address === c.address)) {
      before.set(c.address, { address: c.address, mode: c.mode === 'data' ? 'data' : 'managed', type: c.type, name: c.name, values: jsonObject(c.change.before, false), dependsOn: [] });
    }
  }
  found.push(...before.values());

  // Configuración: referencias y expresiones de los recursos del módulo raíz.
  const configuration = isObject(json.configuration) ? json.configuration : {};
  const configured = new Map<string, Record<string, unknown>>();
  const rootConfig = isObject(configuration.root_module) ? configuration.root_module : {};
  for (const r of asList(rootConfig.resources)) if (isObject(r) && typeof r.address === 'string') configured.set(stripIndex(r.address), r);
  for (const [name, v] of Object.entries(isObject(rootConfig.variables) ? rootConfig.variables : {})) if (isObject(v) && 'default' in v) model.variables.set(name, plain(v.default));
  for (const [name, v] of Object.entries(isObject(json.variables) ? json.variables : {})) if (isObject(v) && 'value' in v) model.variables.set(name, plain(v.value));
  for (const [key, p] of Object.entries(isObject(configuration.provider_config) ? configuration.provider_config : {})) {
    if (!isObject(p)) continue;
    const attrs = expressionValue(p.expressions);
    addProvider(model, typeof p.name === 'string' ? p.name : key, isObject(attrs) && !isExpr(attrs) ? (attrs as TfObject) : {});
  }

  const grouped = new Map<string, ShowResource[]>();
  for (const r of found) {
    const key = stripIndex(r.address);
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }
  for (const [address, list] of grouped) {
    const first = list[0];
    const config = configured.get(address);
    const configExpressions = config ? expressionValue(config.expressions) : undefined;
    const merged = overlay(first.values, isObject(configExpressions) && !isExpr(configExpressions) ? configExpressions : undefined);
    const attrs = isObject(merged) && !isExpr(merged) ? (merged as TfObject) : first.values;
    const dependsOn = unique([...list.flatMap((r) => r.dependsOn), ...asList(config?.depends_on).filter((d): d is string => typeof d === 'string').map(stripIndex)]);
    const configRefs = isObject(configExpressions) ? refsOf(configExpressions as TfValue) : [];
    const modulePath = moduleOf(first.address);
    const instances: TfInstance[] = list.map((r) => ({ ...(r.index !== undefined ? { key: r.index } : {}), attrs: r.values }));
    const action = actions.get(address);
    model.nodes.push({
      address,
      mode: first.mode,
      type: first.type,
      name: first.name,
      ...(modulePath ? { modulePath } : {}),
      attrs,
      instances,
      refs: unique([...configRefs, ...dependsOn]),
      dependsOn,
      ...(action ? { action } : {}),
    });
  }
  return finalize(model);
}

// ───────────── enlace de ids físicos ─────────────

const SUBNET_GROUP = /subnet_group|db_subnet|subnetwork/;
/** Atributos de un recurso que otros nombran por su valor y que no son su `id`: el grupo de seguridad que EKS crea para el clúster. */
const EXTRA_ID_PATHS: Record<string, string[]> = { aws_eks_cluster: ['vpc_config.cluster_security_group_id'] };

/**
 * ¿Parece un identificador físico que otro recurso puede citar (ARN, `vpc-0a1b…`, UUID, ruta de Azure o URL de Google)? Los
 * nombres corrientes (el `id` de un RDS o de un bucket es su nombre) no valen: un `name = "tienda-orders"` cualquiera no
 * debe enlazar con un recurso solo por llamarse igual.
 */
const PHYSICAL_ID = /^(?:arn:|\/subscriptions\/|projects\/|https:\/\/www\.googleapis\.com\/|[a-z]{2,12}(?:-[a-z]{2,12})?-[0-9a-f]{8,}$|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/;

/** Índice de ids físicos y refs por valores sueltos (estado y plan) y marca de uso de `terraform.workspace`. */
function finalize(model: TfModel): TfModel {
  const physical = model.format === 'state' || model.format === 'plan';
  if (physical) {
    for (const node of model.nodes) {
      for (const inst of node.instances.length > 0 ? node.instances : [{ attrs: node.attrs }]) {
        for (const k of ['id', 'arn', 'self_link', 'key_id']) {
          const v = inst.attrs[k];
          if (typeof v === 'string' && PHYSICAL_ID.test(v) && !model.index.has(v)) model.index.set(v, node.address);
        }
        // Los grupos de subredes se citan por su nombre (`db_subnet_group_name`).
        const name = inst.attrs.name;
        if (SUBNET_GROUP.test(node.type) && typeof name === 'string' && name.length >= 4 && !model.index.has(name)) model.index.set(name, node.address);
        for (const path of EXTRA_ID_PATHS[node.type] ?? []) {
          const v = dig(inst.attrs, path);
          if (typeof v === 'string' && v.length >= 4 && !model.index.has(v)) model.index.set(v, node.address);
        }
      }
    }
    for (const node of model.nodes) {
      const found = new Set(node.refs);
      for (const inst of node.instances.length > 0 ? node.instances : [{ attrs: node.attrs }]) {
        for (const address of physicalRefs(model, inst.attrs)) if (address !== node.address) found.add(address);
      }
      node.refs = [...found];
    }
  }
  const mentions = (v: unknown): boolean => refsOf(v as TfValue).includes('terraform.workspace');
  model.usesWorkspace = model.nodes.some((n) => mentions(n.attrs)) || [...model.locals.values()].some(mentions) || model.modules.some((m) => mentions(m.attrs));
  return model;
}

/** Direcciones que un valor nombra: referencias de expresiones y ids físicos que coinciden con un nodo conocido. */
export function physicalRefs(model: TfModel, value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      const address = model.index.get(v);
      if (address) found.add(address);
    } else if (isExpr(v)) for (const r of v.refs) found.add(r);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

// ───────────── entrada ─────────────

function jsonErrorLine(text: string, message: string): string {
  const at = /position (\d+)/.exec(message);
  if (!at) return message;
  const line = text.slice(0, Number(at[1])).split('\n').length;
  return `${message.replace(/\s*\(line \d+ column \d+\)/, '')} (línea ${line})`;
}

/** Lee un texto de Terraform (HCL, `.tf.json`, estado o `terraform show -json`) al modelo intermedio. */
export function readTerraform(source: string): TfModel {
  const text = source.replace(/^﻿/, '');
  if (text.trim() === '') throw new PlatformImportError('El archivo de Terraform está vacío.');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return fromHcl(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PlatformImportError(`El JSON de Terraform no es válido: ${jsonErrorLine(text, (error as Error).message)}.`);
  }
  if (!isObject(json)) throw new PlatformImportError('El JSON no es un objeto de Terraform (se esperaba un estado, un plan de `terraform show -json` o un `.tf.json`).');
  if (Array.isArray(json.resources) && ('terraform_version' in json || 'serial' in json || 'lineage' in json || 'version' in json)) return fromState(json);
  if (Array.isArray(json.modules) && !('resources' in json)) throw new PlatformImportError('Es un estado de Terraform de versión 3 (anterior a 0.12), que no se puede leer: actualízalo con una versión reciente de Terraform.');
  if ('format_version' in json && ['values', 'planned_values', 'resource_changes', 'configuration', 'prior_state'].some((k) => k in json)) return fromShow(json);
  if (Object.keys(json).length > 0 && Object.keys(json).every((k) => TF_JSON_KEYS.includes(k) || k === '//' || k === '//comment')) return fromTfJson(json);
  throw new PlatformImportError('El JSON no es de Terraform: se esperaba un estado (`.tfstate`), la salida de `terraform show -json` o un `.tf.json` con resource/data/variable/module.');
}

/**
 * Lee varios archivos `.tf` como un solo stack (los de una carpeta de Terraform). El modelo es el mismo que el de leer sus textos
 * concatenados, pero los avisos y los errores dicen de qué archivo vienen. Un archivo vacío o solo de comentarios no cuenta (es
 * habitual, p. ej. un `outputs.tf` aún sin salidas); solo se leen juntos archivos HCL: el JSON de Terraform se importa de uno en uno.
 */
export function readTerraformFiles(files: Array<{ name: string; text: string }>): TfModel {
  const sources = files.map((f) => ({ name: f.name, text: f.text.replace(/^﻿/, '') }));
  if (sources.every((f) => f.text.trim() === '')) throw new PlatformImportError('Los archivos de Terraform están vacíos.');
  for (const f of sources) {
    const start = f.text.trimStart();
    if (start.startsWith('{') || start.startsWith('[')) {
      throw new PlatformImportError(`«${f.name}» no es HCL: el JSON de Terraform (.tf.json, estado, plan) se importa de uno en uno, no junto con otros archivos.`);
    }
  }
  const labelled = sources.length > 1;
  return fromHclSources(sources.filter((f) => f.text.trim() !== '').map((f) => ({ text: f.text, ...(labelled ? { name: f.name } : {}) })));
}

/** ¿Parece Terraform? Reconoce HCL por sus bloques y JSON por la forma del estado, del plan o del `.tf.json`. */
export function looksLikeTerraform(source: string): boolean {
  const text = source.replace(/^﻿/, '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isObject(json) || 'apiVersion' in json) return false;
    if (Array.isArray(json.resources) && ('terraform_version' in json || 'serial' in json || 'lineage' in json)) return true;
    if ('format_version' in json && ['values', 'planned_values', 'resource_changes', 'configuration'].some((k) => k in json)) return true;
    const keys = Object.keys(json);
    return keys.length > 0 && keys.every((k) => TF_JSON_KEYS.includes(k)) && ['resource', 'data', 'module', 'variable', 'locals'].some((k) => k in json);
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('<')) return false;
  return /^[ \t]*(?:resource|data)[ \t]+"[^"\n]+"[ \t]+"[^"\n]+"[ \t]*\{|^[ \t]*(?:variable|module|provider|output)[ \t]+"[^"\n]+"[ \t]*\{|^[ \t]*(?:locals|terraform)[ \t]*\{/m.test(text);
}
