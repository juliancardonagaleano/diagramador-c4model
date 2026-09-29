import { classifyFill } from '../../export/drawio/styles';
import { createView, slugify, suggestViewElements } from '../../model/factories';
import { formatIssues, validateDocument } from '../../model/schema';
import {
  DOCUMENT_VERSION,
  VIEW_SCOPE_TYPE,
  VIEW_TYPE_LABELS,
  type C4Document,
  type C4Element,
  type C4LayoutOptions,
  type C4Relationship,
  type C4View,
  type ElementShape,
  type ElementType,
  type ViewType,
} from '../../model/types';
import { defaultViews } from '../defaultViews';
import { pickId, Warnings } from '@iark/kernel';
import { DslImportError, parseDsl, type DslStatement, type DslToken, type IncludeResolver } from './parse';

export { DslImportError };
export type { IncludeResolver };

export interface DslImportOptions {
  /** Nombre del documento: sustituye al que declare el `workspace`. */
  name?: string;
  /** Nombre a usar si el DSL no declara ninguno (p. ej. el del archivo). Por defecto "Diagrama C4". */
  fallbackName?: string;
  /** Ruta del archivo que se importa: el resolvedor de `!include` la recibe para resolver rutas relativas. */
  file?: string;
  /** Lee los archivos de `!include`. Sin él, los `!include` se omiten con un aviso. */
  resolveInclude?: IncludeResolver;
}

export interface DslImportResult {
  document: C4Document;
  /** Lo que no se pudo importar tal cual (construcciones no soportadas, referencias rotas…). Vacío si todo encajó. */
  warnings: string[];
}

interface Ctx {
  /** Elemento dentro del que se está (sistema o contenedor), si lo hay. */
  parent?: C4Element;
  /** Identificadores de los ancestros, para los identificadores jerárquicos (`sistema.contenedor`). */
  path: string[];
}

interface Tok {
  text: string;
  quoted: boolean;
}

interface PendingRelationship {
  st: DslStatement;
  ident?: string;
  source: string;
  target: string;
  description?: string;
  technology?: string;
  tags?: string[];
  ctx: Ctx;
}

interface ViewDef {
  st: DslStatement;
  type: ViewType;
  scopeName?: string;
  key?: string;
  description?: string;
}

interface Style {
  shape?: string;
  background?: string;
}

const ELEMENT_KEYWORDS: Record<string, ElementType> = {
  person: 'person',
  softwaresystem: 'softwareSystem',
  container: 'container',
  component: 'component',
};

/** Etiqueta que Structurizr asigna por defecto a cada tipo de elemento (los estilos se aplican por etiqueta). */
const TYPE_TAG: Record<ElementType, string> = {
  person: 'Person',
  softwareSystem: 'Software System',
  container: 'Container',
  component: 'Component',
};

const VIEW_KEYWORDS: Record<string, { type: ViewType; scoped: boolean }> = {
  systemlandscape: { type: 'systemContext', scoped: false },
  systemcontext: { type: 'systemContext', scoped: true },
  container: { type: 'container', scoped: true },
  component: { type: 'component', scoped: true },
};

/** Vistas de Structurizr que no tienen equivalente en este modelo. */
const UNSUPPORTED_VIEWS = new Set(['filtered', 'dynamic', 'deployment', 'custom', 'image']);

/** Sentencias de presentación o configuración que no cambian el modelo: se ignoran sin avisar. */
const SILENT = new Set(['configuration', 'branding', 'terminology', 'themes', 'theme', 'animation', '!identifiers', '!impliedrelationships', 'relationship']);

const DEPLOYMENT = new Set(['deploymentenvironment', 'deploymentnode', 'infrastructurenode', 'softwaresysteminstance', 'containerinstance', 'deploymentgroup']);

const SHAPES: Record<string, ElementShape> = {
  cylinder: 'database',
  pipe: 'queue',
  webbrowser: 'browser',
  mobiledeviceportrait: 'mobile',
  mobiledevicelandscape: 'mobile',
};

/** Etiquetas de uso común para marcar un sistema como externo. */
const EXTERNAL_TAGS = new Set(['external', 'existing system']);

const AUTOLAYOUT: Record<string, C4LayoutOptions['direction']> = { tb: 'DOWN', bt: 'UP', lr: 'RIGHT', rl: 'LEFT' };

const keywordOf = (tokens: Tok[], from = 0): string => (tokens[from] && !tokens[from].quoted ? tokens[from].text.toLowerCase() : '');

function normalizeHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return undefined;
}

class Interpreter {
  private readonly warnings = new Warnings();
  private readonly unsupportedKeywords = new Map<string, { count: number; loc: string }>();
  private readonly constants = new Map<string, string>();
  private readonly elements: C4Element[] = [];
  private readonly elementIds = new Set<string>();
  private readonly qualified = new Map<string, C4Element>();
  private readonly short = new Map<string, C4Element[]>();
  private readonly pending: PendingRelationship[] = [];
  private readonly relationships: C4Relationship[] = [];
  private readonly relationshipIds = new Set<string>();
  private readonly relationshipKeys = new Set<string>();
  private readonly styles = new Map<string, Style>();
  private readonly viewDefs: ViewDef[] = [];
  private readonly viewBlocks: DslStatement[] = [];
  private workspaceName: string | undefined;
  private workspaceDescription: string | undefined;
  private relationshipExpressionWarned = false;

  constructor(private readonly options: DslImportOptions) {}

  run(text: string): DslImportResult {
    const statements = parseDsl(text, { file: this.options.file, resolveInclude: this.options.resolveInclude, warn: (m) => this.warnings.add(m) });
    let found = false;
    for (const st of statements) {
      const tokens = this.expand(st);
      if (tokens.length === 0) continue;
      const kw = keywordOf(tokens);
      if (kw === 'workspace') {
        if (found) this.warnings.add(`${st.loc}: hay más de un «workspace»; se ignora este.`);
        else this.interpretWorkspace(st, tokens);
        found = true;
      } else if (kw === '!const' || kw === '!var') {
        this.defineConstant(st, tokens);
      } else if (!SILENT.has(kw)) {
        this.unsupported(kw || tokens[0].text, st.loc);
      }
    }
    if (!found) throw new DslImportError('No se encontró el bloque «workspace { … }»: un DSL de Structurizr debe empezar por él.');
    if (this.elements.length === 0) {
      throw new DslImportError('El DSL no define ningún elemento: se esperaban person, softwareSystem, container o component dentro de «model { … }».');
    }

    this.resolveRelationships();
    for (const block of this.viewBlocks) this.interpretViews(block);
    this.applyStyles();
    const views = this.buildViews();
    this.reportUnsupported();

    const name = this.options.name?.trim() || this.workspaceName?.trim() || this.options.fallbackName?.trim() || 'Diagrama C4';
    const document = {
      version: DOCUMENT_VERSION,
      workspace: { name, ...(this.workspaceDescription?.trim() ? { description: this.workspaceDescription.trim() } : {}) },
      model: { elements: this.elements, relationships: this.relationships },
      views,
    };
    const result = validateDocument(document);
    if (!result.ok) throw new DslImportError(`No se pudo construir un documento C4 válido a partir del DSL:\n${formatIssues(result.issues)}`);
    return { document: result.document, warnings: this.warnings.result() };
  }

  // ───────────────────────── Utilidades ─────────────────────────

  /** Tokens de una sentencia con las constantes `${NOMBRE}` ya sustituidas. */
  private expand(st: DslStatement): Tok[] {
    return st.tokens.map((t: DslToken) => ({
      quoted: t.quoted,
      text: t.text.replace(/\$\{([\w.-]+)\}/g, (match, name: string) => {
        const value = this.constants.get(name);
        if (value === undefined) {
          this.warnings.add(`${st.loc}: la constante «${name}» no está definida.`);
          return match;
        }
        return value;
      }),
    }));
  }

  private defineConstant(st: DslStatement, tokens: Tok[]): void {
    if (tokens.length < 3) {
      this.warnings.add(`${st.loc}: ${tokens[0].text} necesita un nombre y un valor.`);
      return;
    }
    this.constants.set(tokens[1].text, tokens[2].text);
  }

  private unsupported(keyword: string, loc: string): void {
    const seen = this.unsupportedKeywords.get(keyword);
    if (seen) seen.count += 1;
    else this.unsupportedKeywords.set(keyword, { count: 1, loc });
  }

  private reportUnsupported(): void {
    for (const [keyword, { count, loc }] of this.unsupportedKeywords) {
      this.warnings.add(`Se ${count === 1 ? 'ignoró 1 sentencia' : `ignoraron ${count} sentencias`} «${keyword}» (no soportada; la primera, en ${loc}).`);
    }
  }

  // ───────────────────────── workspace y modelo ─────────────────────────

  private interpretWorkspace(st: DslStatement, tokens: Tok[]): void {
    if (keywordOf(tokens, 1) === 'extends') {
      throw new DslImportError(`${st.loc}: «workspace extends» (heredar de otro workspace) no está soportado.`);
    }
    this.workspaceName = tokens[1]?.text;
    this.workspaceDescription = tokens[2]?.text;
    for (const child of st.block ?? []) {
      const t = this.expand(child);
      if (t.length === 0) continue;
      const kw = keywordOf(t);
      if (kw === 'model') this.interpretModel(child.block ?? [], { path: [] });
      else if (kw === 'views') this.viewBlocks.push(child);
      else if (kw === 'name') this.workspaceName = t[1]?.text ?? this.workspaceName;
      else if (kw === 'description') this.workspaceDescription = t[1]?.text ?? this.workspaceDescription;
      else if (kw === '!const' || kw === '!var') this.defineConstant(child, t);
      else if (!SILENT.has(kw)) this.unsupported(kw || t[0].text, child.loc);
    }
  }

  private interpretModel(statements: DslStatement[], ctx: Ctx): void {
    for (const st of statements) {
      const tokens = this.expand(st);
      if (tokens.length === 0) {
        this.interpretModel(st.block ?? [], ctx); // bloque suelto: se trata como un grupo
        continue;
      }
      const hasIdent = tokens[1]?.text === '=' && !tokens[1].quoted;
      const ident = hasIdent ? tokens[0].text : undefined;
      const rest = hasIdent ? tokens.slice(2) : tokens;
      const kw = keywordOf(rest);

      if (kw === '!const' || kw === '!var') {
        this.defineConstant(st, rest);
      } else if (rest.some((t) => t.text === '->' && !t.quoted)) {
        this.addPendingRelationship(st, rest, ident, ctx);
      } else if (ELEMENT_KEYWORDS[kw]) {
        this.defineElement(st, rest, ident, ELEMENT_KEYWORDS[kw], ctx);
      } else if (kw === 'group' || kw === 'enterprise') {
        this.interpretModel(st.block ?? [], ctx); // agrupaciones visuales: solo aportan su contenido
      } else if (kw === 'tags' || kw === 'description' || kw === 'technology') {
        this.setAttribute(st, kw, rest, ctx);
      } else if (DEPLOYMENT.has(kw)) {
        this.unsupported('despliegue (deploymentEnvironment, deploymentNode…)', st.loc);
      } else if (!SILENT.has(kw)) {
        this.unsupported(kw || rest[0]?.text || '=', st.loc);
      }
    }
  }

  private defineElement(st: DslStatement, rest: Tok[], ident: string | undefined, type: ElementType, ctx: Ctx): void {
    const args = rest.slice(1).map((t) => t.text);
    const name = args[0]?.trim();
    if (!name) {
      this.warnings.add(`${st.loc}: falta el nombre del ${rest[0].text}; se omite.`);
      return;
    }
    const required = type === 'container' ? 'softwareSystem' : type === 'component' ? 'container' : undefined;
    if (required ? ctx.parent?.type !== required : ctx.parent) {
      const where = ctx.parent ? `dentro de «${ctx.parent.name}» (${ctx.parent.type})` : 'fuera de un ' + (required === 'softwareSystem' ? 'softwareSystem' : 'container');
      this.warnings.add(`${st.loc}: «${name}» (${type}) no puede estar ${where}; se omite junto con su contenido.`);
      return;
    }

    const detailed = type === 'container' || type === 'component';
    const description = args[1]?.trim();
    const technology = detailed ? args[2]?.trim() : undefined;
    const tags = this.splitTags(detailed ? args[3] : args[2]);
    const element: C4Element = { id: pickId(ident ?? (slugify(name) || type), this.elementIds), type, name };
    if (description) element.description = description;
    if (technology) element.technology = technology;
    if (tags.length > 0) element.tags = tags;
    if (ctx.parent) element.parentId = ctx.parent.id;
    this.elements.push(element);
    const path = this.register(st, ident, element, ctx);
    if (st.block) this.interpretModel(st.block, { parent: element, path });
  }

  /** Registra el identificador (calificado por sus ancestros y corto) y devuelve el camino para los hijos. */
  private register(st: DslStatement, ident: string | undefined, element: C4Element, ctx: Ctx): string[] {
    if (!ident) return ctx.path;
    const qualified = [...ctx.path, ident].join('.');
    if (this.qualified.has(qualified)) {
      this.warnings.add(`${st.loc}: el identificador «${qualified}» ya está en uso; no se podrá referenciar este elemento.`);
    } else {
      this.qualified.set(qualified, element);
      const list = this.short.get(ident) ?? [];
      list.push(element);
      this.short.set(ident, list);
    }
    return [...ctx.path, ident];
  }

  private splitTags(value: string | undefined): string[] {
    return (value ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  private setAttribute(st: DslStatement, kw: string, rest: Tok[], ctx: Ctx): void {
    const value = rest[1]?.text;
    if (!ctx.parent || value === undefined) {
      this.unsupported(kw, st.loc);
      return;
    }
    if (kw === 'description') ctx.parent.description = value;
    else if (kw === 'technology') ctx.parent.technology = value;
    else ctx.parent.tags = [...new Set([...(ctx.parent.tags ?? []), ...this.splitTags(value)])];
  }

  /** Busca un elemento por identificador: primero por ámbito (jerárquico), luego global y, si es único, por nombre corto. */
  private resolve(name: string, ctx: Ctx, loc: string): C4Element | undefined {
    if (name === 'this') return ctx.parent;
    for (let i = ctx.path.length; i >= 0; i -= 1) {
      const found = this.qualified.get([...ctx.path.slice(0, i), name].join('.'));
      if (found) return found;
    }
    const candidates = this.short.get(name);
    if (candidates?.length === 1) return candidates[0];
    if (candidates && candidates.length > 1) this.warnings.add(`${loc}: el identificador «${name}» es ambiguo; use el nombre calificado (p. ej. sistema.${name}).`);
    return undefined;
  }

  // ───────────────────────── relaciones ─────────────────────────

  private addPendingRelationship(st: DslStatement, rest: Tok[], ident: string | undefined, ctx: Ctx): void {
    const arrow = rest.findIndex((t) => t.text === '->' && !t.quoted);
    const sources = rest.slice(0, arrow);
    const target = rest[arrow + 1];
    if (sources.length > 1 || !target) {
      this.warnings.add(`${st.loc}: relación no válida (se esperaba «origen -> destino "descripción" "tecnología"»); se omite.`);
      return;
    }
    const args = rest.slice(arrow + 2).map((t) => t.text);
    this.pending.push({
      st,
      ident,
      source: sources[0]?.text ?? 'this',
      target: target.text,
      description: args[0]?.trim() || undefined,
      technology: args[1]?.trim() || undefined,
      tags: this.splitTags(args[2]),
      ctx,
    });
  }

  /** Las relaciones se resuelven al final, así pueden referirse a elementos definidos más abajo. */
  private resolveRelationships(): void {
    for (const p of this.pending) {
      const source = this.resolve(p.source, p.ctx, p.st.loc);
      const target = this.resolve(p.target, p.ctx, p.st.loc);
      if (!source || !target) {
        const missing = !source ? p.source : p.target;
        // Si el identificador era ambiguo, `resolve` ya lo avisó.
        if ((this.short.get(missing)?.length ?? 0) < 2) this.warnings.add(`${p.st.loc}: la relación usa «${missing}», que no es un elemento conocido; se omite.`);
        continue;
      }
      if (source === target) {
        this.warnings.add(`${p.st.loc}: «${source.name}» no puede relacionarse consigo mismo; se omite.`);
        continue;
      }
      const key = `${source.id}>${target.id}|${p.description ?? ''}|${p.technology ?? ''}`;
      if (this.relationshipKeys.has(key)) {
        this.warnings.add(`${p.st.loc}: relación duplicada entre «${source.name}» y «${target.name}»; se omite.`);
        continue;
      }
      this.relationshipKeys.add(key);
      const relationship: C4Relationship = {
        id: pickId(p.ident ?? `${source.id}--${target.id}`, this.relationshipIds),
        sourceId: source.id,
        targetId: target.id,
      };
      if (p.description) relationship.description = p.description;
      if (p.technology) relationship.technology = p.technology;
      if (p.tags && p.tags.length > 0) relationship.tags = p.tags;
      this.relationships.push(relationship);
    }
  }

  // ───────────────────────── estilos ─────────────────────────

  private interpretStyles(block: DslStatement[]): void {
    for (const st of block) {
      const t = this.expand(st);
      if (keywordOf(t) !== 'element' || !t[1]) continue;
      const style: Style = this.styles.get(t[1].text.toLowerCase()) ?? {};
      for (const prop of st.block ?? []) {
        const p = this.expand(prop);
        const kw = keywordOf(p);
        if (kw === 'shape' && p[1]) style.shape = p[1].text.toLowerCase();
        else if (kw === 'background' && p[1]) style.background = p[1].text;
      }
      this.styles.set(t[1].text.toLowerCase(), style);
    }
  }

  /** Convierte los estilos por etiqueta en `shape`, `color` y `external`, como el editor los entiende. */
  private applyStyles(): void {
    for (const el of this.elements) {
      const userTags = el.tags ?? [];
      let shape: string | undefined;
      let background: string | undefined;
      for (const tag of ['Element', TYPE_TAG[el.type], ...userTags]) {
        const style = this.styles.get(tag.toLowerCase());
        if (style?.shape) shape = style.shape;
        if (style?.background) background = style.background;
      }
      if (userTags.some((t) => EXTERNAL_TAGS.has(t.toLowerCase()))) el.external = true;
      if (shape && el.type !== 'person' && SHAPES[shape]) el.shape = SHAPES[shape];
      const hex = normalizeHex(background);
      if (hex) {
        const kind = classifyFill(el.type, hex);
        if (kind === 'external') el.external = true;
        else if (kind === 'custom') el.color = hex;
      }
    }
  }

  // ───────────────────────── vistas ─────────────────────────

  private interpretViews(block: DslStatement): void {
    for (const st of block.block ?? []) {
      const tokens = this.expand(st);
      if (tokens.length === 0) continue;
      const hasIdent = tokens[1]?.text === '=' && !tokens[1].quoted;
      const rest = hasIdent ? tokens.slice(2) : tokens;
      const kw = keywordOf(rest);
      const view = VIEW_KEYWORDS[kw];
      if (kw === 'styles') {
        this.interpretStyles(st.block ?? []);
      } else if (view) {
        const args = rest.slice(1).map((t) => t.text);
        const scopeName = view.scoped ? args.shift() : undefined;
        if (view.scoped && !scopeName) {
          this.warnings.add(`${st.loc}: la vista «${rest[0]?.text}» necesita el elemento de su alcance; se omite.`);
          continue;
        }
        this.viewDefs.push({ st, type: view.type, scopeName, key: args[0]?.trim() || undefined, description: args[1]?.trim() || undefined });
      } else if (UNSUPPORTED_VIEWS.has(kw)) {
        this.unsupported(`vista ${kw}`, st.loc);
      } else if (kw === '!const' || kw === '!var') {
        this.defineConstant(st, rest);
      } else if (!SILENT.has(kw)) {
        this.unsupported(kw || rest[0]?.text || '=', st.loc);
      }
    }
  }

  private buildViews(): C4View[] {
    const modelDoc: C4Document = {
      version: DOCUMENT_VERSION,
      workspace: { name: 'x' },
      model: { elements: this.elements, relationships: this.relationships },
      views: [],
    };
    const views: C4View[] = [];
    const viewIds = new Set<string>();
    for (const def of this.viewDefs) {
      const view = this.buildView(def, modelDoc, viewIds);
      if (view) views.push(view);
    }
    if (views.length === 0) {
      this.warnings.add('El DSL no define vistas que se puedan importar: se crearon las vistas por defecto (contexto, contenedores y componentes).');
      return defaultViews(this.elements, this.relationships);
    }
    return views;
  }

  private buildView(def: ViewDef, modelDoc: C4Document, viewIds: Set<string>): C4View | undefined {
    const { st, type } = def;
    let scope: C4Element | undefined;
    if (def.scopeName !== undefined) {
      scope = this.resolve(def.scopeName, { path: [] }, st.loc);
      if (!scope) {
        this.warnings.add(`${st.loc}: el alcance «${def.scopeName}» de la vista no es un elemento conocido; se omite la vista.`);
        return undefined;
      }
      if (scope.type !== VIEW_SCOPE_TYPE[type]) {
        this.warnings.add(`${st.loc}: el alcance de una vista ${type} debe ser un ${VIEW_SCOPE_TYPE[type]}, pero «${scope.name}» es un ${scope.type}; se omite la vista.`);
        return undefined;
      }
    }

    const included: string[] = [];
    const add = (ids: string[]): void => {
      for (const id of ids) if (!included.includes(id)) included.push(id);
    };
    let sawInclude = false;
    let title: string | undefined;
    let description = def.description;
    let layout: C4LayoutOptions | undefined;

    for (const child of st.block ?? []) {
      const t = this.expand(child);
      const kw = keywordOf(t);
      if (kw === 'include' || kw === 'exclude') {
        sawInclude ||= kw === 'include';
        for (const expr of t.slice(1)) {
          const ids = this.evaluate(expr.text, type, scope, modelDoc, child.loc);
          if (!ids) continue;
          if (kw === 'include') add(ids);
          else for (const id of ids) included.splice(0, included.length, ...included.filter((x) => x !== id));
        }
      } else if (kw === 'autolayout') {
        layout = this.autoLayout(t);
      } else if (kw === 'title' && t[1]) {
        title = t[1].text;
      } else if (kw === 'description' && t[1]) {
        description = t[1].text;
      } else if (kw === '!const' || kw === '!var') {
        this.defineConstant(child, t);
      } else if (!SILENT.has(kw)) {
        this.unsupported(kw || t[0]?.text || '{', child.loc);
      }
    }
    if (!sawInclude) this.warnings.add(`${st.loc}: la vista no incluye ningún elemento (falta «include»).`);

    const key = def.key && def.key.length <= 120 ? def.key : undefined;
    const elements = included.filter((id) => type === 'systemContext' || id !== scope?.id).map((id) => ({ id }));
    // El modelo exige que un contexto de sistema muestre su propio sistema (`include *` lo incluye, pero un `include` selectivo o un `exclude` no).
    if (type === 'systemContext' && scope && !elements.some((e) => e.id === scope.id)) {
      this.warnings.add(`${st.loc}: la vista systemContext no incluía su alcance «${scope.name}»; se añade.`);
      elements.unshift({ id: scope.id });
    }
    const view = createView(
      type,
      {
        ...(key ? { id: pickId(key, viewIds) } : {}),
        scopeId: scope?.id,
        title: title ?? (scope ? `${VIEW_TYPE_LABELS[type]} - ${scope.name}` : 'Panorama de sistemas'),
        description,
        elements,
        layout,
      },
      viewIds,
    );
    viewIds.add(view.id);
    return view;
  }

  private autoLayout(tokens: Tok[]): C4LayoutOptions | undefined {
    const layout: C4LayoutOptions = { direction: AUTOLAYOUT[tokens[1]?.text.toLowerCase()] ?? 'DOWN' };
    const rank = Number(tokens[2]?.text);
    const node = Number(tokens[3]?.text);
    if (Number.isFinite(rank) && rank > 0) layout.layerSpacing = rank;
    if (Number.isFinite(node) && node > 0) layout.spacing = node;
    return layout;
  }

  /** Elementos que designa una expresión de `include`/`exclude`; `undefined` si no se soporta. */
  private evaluate(expr: string, type: ViewType, scope: C4Element | undefined, modelDoc: C4Document, loc: string): string[] | undefined {
    const ctx: Ctx = { path: [] };
    if (expr === '*') return suggestViewElements(modelDoc, type, scope?.id);

    const property = /^element\.(tag|type|parent)\s*(==|!=)\s*(.+)$/i.exec(expr);
    if (property) {
      const [, prop, op, raw] = property;
      const wanted = raw.split(',').map((v) => v.trim().toLowerCase());
      const parent = prop.toLowerCase() === 'parent' ? this.resolve(raw.trim(), ctx, loc) : undefined;
      const matches = this.elements.filter((el) => {
        if (prop.toLowerCase() === 'tag') return ['element', TYPE_TAG[el.type], ...(el.tags ?? [])].some((tag) => wanted.includes(tag.toLowerCase()));
        if (prop.toLowerCase() === 'type') return wanted.includes(el.type.toLowerCase());
        return !!parent && el.parentId === parent.id;
      });
      const ids = new Set(matches.map((el) => el.id));
      return op === '==' ? [...ids] : this.elements.filter((el) => !ids.has(el.id)).map((el) => el.id);
    }
    if (/^relationship/i.test(expr)) {
      if (!this.relationshipExpressionWarned) {
        this.relationshipExpressionWarned = true;
        this.warnings.add(`${loc}: las expresiones de relaciones («${expr}») no están soportadas en include/exclude; no afectan a las vistas.`);
      }
      return undefined;
    }

    const connected = /^(->)?(.+?)(->)?$/.exec(expr);
    const [, before, name, after] = connected ?? [];
    const el = this.resolve(name ?? expr, ctx, loc);
    if (!el) {
      this.warnings.add(`${loc}: la expresión «${expr}» no corresponde a ningún elemento; se ignora.`);
      return undefined;
    }
    const ids = [el.id];
    for (const r of this.relationships) {
      if (after && r.sourceId === el.id) ids.push(r.targetId);
      if (before && r.targetId === el.id) ids.push(r.sourceId);
    }
    return ids;
  }
}

/**
 * Convierte un DSL de Structurizr (`workspace { model { … } views { … } }`) en un documento C4.
 *
 * Importa `person`, `softwareSystem`, `container` y `component` (con su jerarquía, descripción, tecnología y
 * etiquetas), las relaciones `a -> b "descripción" "tecnología"` (también las escritas dentro de un elemento),
 * los identificadores planos y jerárquicos (`!identifiers hierarchical`), las constantes `!const`, los `!include`
 * (con `resolveInclude`), las vistas `systemLandscape`/`systemContext`/`container`/`component` con sus
 * `include`/`exclude` y `autoLayout`, y los estilos por etiqueta (`shape`, `background`) como forma, color y "externo".
 * El DSL no tiene coordenadas: las vistas quedan sin posicionar (se colocan con autolayout). Lo que no se puede
 * importar (despliegue, vistas dinámicas, `!docs`…) se comunica en `warnings`. Lanza `DslImportError`, con la línea,
 * si el texto no es un DSL utilizable.
 */
export function fromStructurizrDsl(text: string, options: DslImportOptions = {}): DslImportResult {
  return new Interpreter(options).run(text);
}
