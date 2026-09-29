import { classifyFill, CARD_FILL, parseC4TypeLabel, type C4CellKind } from '../../export/drawio/styles';
import { slugify } from '../../model/factories';
import { MAX_ID_LENGTH, pickId } from '../ids';
import { Warnings } from '../warnings';
import { formatIssues, validateDocument } from '../../model/schema';
import {
  DEFAULT_SIZES,
  DOCUMENT_VERSION,
  PARENT_TYPE,
  VIEW_SCOPE_TYPE,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
  type C4ViewElement,
  type ElementShape,
  type ElementType,
  type ViewType,
} from '../../model/types';
import { bracketContent, labelToLines, parseStyle, resolvePlaceholders, type ParsedStyle } from './labels';
import { readPages, type DrawioPage, type RawCell } from './pages';
import { DrawioImportError } from './xml';

export { DrawioImportError };

export interface DrawioImportOptions {
  /** Nombre del documento (un `.drawio` no guarda uno). Por defecto "Diagrama C4". */
  name?: string;
}

export interface DrawioImportResult {
  document: C4Document;
  /** Cosas que no se pudieron importar tal cual (formas omitidas, jerarquías imposibles…). Vacío si todo encajó. */
  warnings: string[];
}

/**
 * Id "escrito a propósito" (kebab-case en minúsculas): distingue los ids de un documento C4 de los aleatorios que
 * genera draw.io (`qKL8bDKQnnmqKWi-3zvG-1`) o los numéricos de versiones antiguas (`2`, `3`).
 */
const READABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PAGE_LINK = /^data:page\/id,(.+)$/;
/** Prefijos de id que escribe `toDrawio`: permiten recuperar el id original del documento al reimportar. */
const ELEMENT_PREFIX = /^el-(.+)$/;
const RELATIONSHIP_PREFIX = /^rel-(.+)$/;
const MAX_READABLE_LENGTH = 60;
/** Id de una arista implícita (`relación@origen->destino`, la que dibuja una vista cuando un extremo está oculto). */
const IMPLIED_EDGE = /^(.+?)@(.+)->(.+)$/;

interface Explicit {
  type: ElementType;
  external: boolean;
}

/** Forma de una página que puede convertirse en elemento C4. */
interface Candidate {
  cell: RawCell;
  annotated: boolean;
  name: string;
  description?: string;
  technology?: string;
  /** Tipo que declara la propia celda (c4Type, "[Tipo: …]" o forma de persona/cilindro), independiente del contexto. */
  explicit?: Explicit;
  external: boolean;
  shape?: ElementShape;
  color?: string;
  linkPageId?: string;
  parent?: Candidate;
  children: Candidate[];
  type?: ElementType;
}

interface ElementDraft {
  element: C4Element;
  linkPageId?: string;
}

interface PageNode {
  cand: Candidate;
  draft: ElementDraft;
  rect?: { x: number; y: number; width: number; height: number };
}

interface PageAnalysis {
  page: DrawioPage;
  nodes: PageNode[];
}

interface RelationshipDraft {
  relationship: C4Relationship;
  implied: boolean;
}

/** Id del documento C4 que la celda lleva codificado (`el-<id>` de `toDrawio`, o un id legible), si lo hay. */
function ownElementId(cellId: string): string | undefined {
  const prefixed = ELEMENT_PREFIX.exec(cellId)?.[1];
  if (prefixed !== undefined) return prefixed.length <= MAX_ID_LENGTH ? prefixed : undefined;
  return READABLE_ID.test(cellId) && cellId.length <= MAX_READABLE_LENGTH ? cellId : undefined;
}

/** Igual para una flecha; separa además las aristas implícitas (`relación@origen->destino`) de las directas. */
function ownEdgeId(cellId: string): { baseId: string; implied: boolean } | undefined {
  const prefixed = RELATIONSHIP_PREFIX.exec(cellId)?.[1];
  const raw = prefixed ?? cellId;
  const implied = IMPLIED_EDGE.exec(raw);
  const baseId = implied ? implied[1] : raw;
  const own = prefixed !== undefined || (READABLE_ID.test(baseId) && baseId.length <= MAX_READABLE_LENGTH);
  return own && baseId.length <= MAX_ID_LENGTH ? { baseId, implied: !!implied } : undefined;
}

const normalizeName = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Nivel jerárquico que corresponde a una forma sin tipo declarado, según lo que la contiene. */
function typeByDepth(parentType: ElementType | undefined): ElementType {
  if (!parentType) return 'softwareSystem';
  if (parentType === 'softwareSystem') return 'container';
  return 'component';
}

function hexColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return undefined;
}

/** Color de acento de una celda: el relleno, o (notación "tarjeta") la franja de la etiqueta / el borde del cilindro. */
function accentColor(style: ParsedStyle, rawLabel: string): string | undefined {
  const fill = style.props.fillColor;
  if (fill && fill.toLowerCase() === CARD_FILL.toLowerCase()) {
    return hexColor(/background-color:\s*(#[0-9a-f]{3,6})\b/i.exec(rawLabel)?.[1] ?? style.props.strokeColor);
  }
  return hexColor(fill);
}

function shapeOf(style: ParsedStyle, annotated: boolean): ElementShape | undefined {
  const shape = style.props.shape ?? '';
  if (/^cylinder/i.test(shape) || shape === 'mxgraph.flowchart.database') {
    const direction = style.props.direction;
    return direction === 'south' || direction === 'north' ? 'queue' : 'database';
  }
  if (/webBrowserContainer|browserWindow/i.test(shape)) return 'browser';
  if (/mobile/i.test(shape) || (annotated && style.props.rounded === '1' && style.props.arcSize === '30')) return 'mobile';
  return undefined;
}

function isPersonShape(style: ParsedStyle): boolean {
  const shape = style.props.shape ?? '';
  return /^mxgraph\.c4\.person/i.test(shape) || shape === 'umlActor' || shape === 'actor';
}

/** `[Contenedor: Java]` → tipo + tecnología; `[Java]` → solo tecnología; `[Sistema externo]` → solo tipo. */
function splitBracket(inner: string): { kind?: { kind: C4CellKind; external: boolean }; technology?: string } {
  const colon = inner.indexOf(':');
  if (colon >= 0) {
    const kind = parseC4TypeLabel(inner.slice(0, colon));
    if (kind) return { kind, technology: inner.slice(colon + 1).trim() || undefined };
  }
  const kind = parseC4TypeLabel(inner);
  return kind ? { kind } : { technology: inner };
}

const ELEMENT_KINDS: Partial<Record<C4CellKind, ElementType>> = {
  person: 'person',
  softwareSystem: 'softwareSystem',
  container: 'container',
  component: 'component',
  'boundary-softwareSystem': 'softwareSystem',
  'boundary-container': 'container',
};

function explicitOf(parsed: { kind: C4CellKind; external: boolean } | null | undefined): Explicit | undefined {
  const type = parsed ? ELEMENT_KINDS[parsed.kind] : undefined;
  return parsed && type ? { type, external: parsed.external } : undefined;
}

class Importer {
  private readonly warnings = new Warnings();
  private readonly drafts = new Map<string, ElementDraft>();
  private readonly elementOrder: ElementDraft[] = [];
  private readonly elementIds = new Set<string>();
  private readonly reservedElementIds = new Set<string>();
  private readonly relationships = new Map<string, RelationshipDraft>();
  private readonly relationshipIds = new Set<string>();
  private readonly reservedRelationshipIds = new Set<string>();
  private readonly analyses: PageAnalysis[] = [];

  constructor(private readonly pages: DrawioPage[]) {
    // Los ids propios (los que escribe `toDrawio` o los legibles) se reservan de antemano: un id generado a partir de un nombre no puede quitárselos.
    for (const page of pages) {
      for (const cell of page.cells) {
        if (cell.vertex) {
          const own = ownElementId(cell.id);
          if (own) this.reservedElementIds.add(own);
        } else if (cell.edge) {
          const own = ownEdgeId(cell.id);
          if (own) this.reservedRelationshipIds.add(own.baseId);
        }
      }
    }
  }

  run(name: string): DrawioImportResult {
    for (const page of this.pages) this.importPage(page);
    if (this.elementOrder.length === 0) {
      throw new DrawioImportError(
        'No se encontró ninguna forma importable en el archivo. Se importan las formas con texto (personas, sistemas, contenedores, componentes) y las flechas entre ellas.',
      );
    }
    const views = this.buildViews();
    const document = {
      version: DOCUMENT_VERSION,
      workspace: { name },
      model: {
        elements: this.elementOrder.map((d) => d.element),
        relationships: [...this.relationships.values()].map((d) => d.relationship),
      },
      views,
    };
    const result = validateDocument(document);
    if (!result.ok) throw new DrawioImportError(`No se pudo construir un documento C4 válido a partir del archivo:\n${formatIssues(result.issues)}`);
    return { document: result.document, warnings: this.warnings.result() };
  }

  // ───────────────────────── Páginas → elementos y relaciones ─────────────────────────

  private importPage(page: DrawioPage): void {
    const cells = new Map<string, RawCell>();
    for (const cell of page.cells) cells.set(cell.id, cell);
    const parentOf = (cell: RawCell): RawCell | undefined => (cell.parent !== undefined ? cells.get(cell.parent) : undefined);
    const limit = cells.size + 1;
    const hidden = (cell: RawCell): boolean => {
      let cur: RawCell | undefined = cell;
      for (let n = 0; cur && n < limit; n += 1, cur = parentOf(cur)) if (!cur.visible) return true;
      return false;
    };
    /** Posición absoluta de la celda: en draw.io la geometría de un hijo es relativa a la de su contenedor. */
    const absolute = (cell: RawCell): { x: number; y: number } | undefined => {
      const g = cell.geometry;
      if (!g || g.relative) return undefined;
      let x = g.x ?? 0;
      let y = g.y ?? 0;
      let cur = parentOf(cell);
      for (let n = 0; cur && n < limit; n += 1, cur = parentOf(cur)) {
        if (cur.geometry && !cur.geometry.relative) {
          x += cur.geometry.x ?? 0;
          y += cur.geometry.y ?? 0;
        }
      }
      return { x, y };
    };

    const edgeLabels = new Map<string, string[]>();
    let notes = 0;
    let blanks = 0;
    const candidates: Candidate[] = [];

    for (const cell of cells.values()) {
      if (!cell.vertex || cell.parent === '0' || hidden(cell)) continue;
      const style = parseStyle(cell.style);
      if (style.flags.has('group')) continue; // agrupación invisible: solo aporta su posición a los hijos
      const isHtml = style.props.html === '1';
      const lines = labelToLines(resolvePlaceholders(cell.value, cell.attrs, isHtml), isHtml);
      const owner = parentOf(cell);
      if (owner?.edge) {
        // Etiqueta suelta de una flecha: aporta su texto a la relación si esta no tiene descripción.
        edgeLabels.set(owner.id, [...(edgeLabels.get(owner.id) ?? []), ...lines]);
        continue;
      }

      const annotated = cell.attrs.c4Type !== undefined || cell.attrs.c4Name !== undefined;
      const declared = annotated && cell.attrs.c4Type ? parseC4TypeLabel(cell.attrs.c4Type) : null;
      // Marcos decorativos de la librería C4 (p. ej. "Enterprise Boundary") y celdas que son relaciones: no son elementos.
      if (declared?.kind === 'boundary-other' || declared?.kind === 'relationship') continue;
      if (!annotated && (style.flags.has('text') || style.props.shape === 'text')) {
        notes += 1;
        continue;
      }

      let name: string | undefined;
      let description: string | undefined;
      let technology: string | undefined;
      let hint: ReturnType<typeof splitBracket>['kind'];
      if (annotated) {
        name = cell.attrs.c4Name?.trim() || lines[0];
        description = cell.attrs.c4Description?.trim() || undefined;
        technology = cell.attrs.c4Technology?.trim() || undefined;
      } else {
        const [first, ...rest] = lines;
        name = first;
        const descriptionLines: string[] = [];
        let bracketSeen = false;
        for (const line of rest) {
          const inner = bracketContent(line);
          if (inner !== null && !bracketSeen) {
            bracketSeen = true;
            const split = splitBracket(inner);
            hint = split.kind;
            technology = split.technology;
          } else {
            descriptionLines.push(line);
          }
        }
        description = descriptionLines.join(' ') || undefined;
      }
      if (!name) {
        blanks += 1;
        continue;
      }

      const shape = shapeOf(style, annotated);
      let explicit = explicitOf(declared) ?? explicitOf(hint);
      if (!explicit && isPersonShape(style)) explicit = { type: 'person', external: false };
      if (!explicit && (shape === 'database' || shape === 'queue' || shape === 'browser' || shape === 'mobile')) {
        explicit = { type: 'container', external: false };
      }
      let external = explicit?.external ?? false;
      let color: string | undefined;
      if (annotated && explicit) {
        const accent = accentColor(style, cell.value);
        if (accent) {
          const kind = classifyFill(explicit.type, accent);
          if (kind === 'external') external = true;
          else if (kind === 'custom') color = accent;
        }
      }
      candidates.push({
        cell,
        annotated,
        name,
        description,
        technology,
        explicit,
        external,
        shape: explicit?.type === 'person' ? undefined : shape,
        color,
        linkPageId: PAGE_LINK.exec(cell.attrs.link ?? '')?.[1],
        children: [],
      });
    }
    if (notes > 0) this.warnings.add(`Página «${page.name}»: se omitieron ${notes} nota(s) de texto suelto.`);
    if (blanks > 0) this.warnings.add(`Página «${page.name}»: se omitieron ${blanks} forma(s) sin texto.`);

    // ── Jerarquía: cada forma cuelga de la forma importable más cercana que la contiene.
    const link = (active: Candidate[]): void => {
      const alive = new Map(active.map((c) => [c.cell.id, c]));
      for (const c of active) {
        c.parent = undefined;
        c.children = [];
      }
      for (const c of active) {
        let cur = parentOf(c.cell);
        for (let n = 0; cur && n < limit; n += 1, cur = parentOf(cur)) {
          const found = alive.get(cur.id);
          if (found && found !== c) {
            c.parent = found;
            found.children.push(c);
            break;
          }
        }
      }
    };
    link(candidates);
    // Una agrupación sin tipo que contiene personas o sistemas (p. ej. un marco "Empresa") no es un elemento C4.
    const decor = candidates.filter(
      (c) => !c.explicit && c.children.some((k) => k.explicit?.type === 'person' || k.explicit?.type === 'softwareSystem'),
    );
    let active = candidates;
    if (decor.length > 0) {
      for (const d of decor) this.warnings.add(`Página «${page.name}»: «${d.name}» agrupa personas o sistemas, no es un elemento C4; se omite el marco y se conservan sus formas.`);
      const drop = new Set(decor);
      active = candidates.filter((c) => !drop.has(c));
      link(active);
    }

    // ── Tipos: primero lo que cada forma declara; el resto, por lo que contiene y por su nivel de anidamiento.
    const order: Candidate[] = [];
    const visited = new Set<Candidate>();
    const visit = (root: Candidate): void => {
      const stack = [root];
      while (stack.length > 0) {
        const c = stack.pop()!;
        if (visited.has(c)) continue;
        visited.add(c);
        order.push(c);
        for (let i = c.children.length - 1; i >= 0; i -= 1) stack.push(c.children[i]);
      }
    };
    for (const c of active) if (!c.parent) visit(c);
    for (const c of active) {
      if (visited.has(c)) continue;
      // Referencias circulares entre padres (archivo corrupto): se rompe el ciclo por esta forma.
      c.parent?.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = undefined;
      visit(c);
    }
    for (const c of order) {
      if (c.explicit) c.type = c.explicit.type;
      else if (c.children.some((k) => k.explicit?.type === 'component')) c.type = 'container';
      else if (c.children.some((k) => k.explicit?.type === 'container')) c.type = 'softwareSystem';
      else if (!c.parent && c.children.length > 0 && this.knowsContainer(c.name)) c.type = 'container';
      else c.type = typeByDepth(c.parent?.type);
    }

    // ── Elementos del modelo (uniendo con los de otras páginas).
    const occurrences = new Map<string, number>();
    const nodes: PageNode[] = [];
    const nodeByCell = new Map<string, PageNode>();
    for (const c of active) {
      const own = ownElementId(c.cell.id);
      let key: string;
      if (own !== undefined) {
        key = `id:${own}`;
      } else {
        const base = `n:${c.type}|${normalizeName(c.name)}`;
        const seen = occurrences.get(base) ?? 0;
        occurrences.set(base, seen + 1);
        key = `${base}#${seen}`;
      }
      const draft = this.upsertElement(key, c, own, page);
      const abs = absolute(c.cell);
      const size = DEFAULT_SIZES[draft.element.type];
      const g = c.cell.geometry;
      const node: PageNode = {
        cand: c,
        draft,
        rect: abs
          ? {
              x: Math.round(abs.x),
              y: Math.round(abs.y),
              width: g?.width && g.width > 0 ? Math.round(g.width) : size.width,
              height: g?.height && g.height > 0 ? Math.round(g.height) : size.height,
            }
          : undefined,
      };
      nodes.push(node);
      nodeByCell.set(c.cell.id, node);
    }
    for (const node of nodes) {
      const parent = node.cand.parent ? nodeByCell.get(node.cand.parent.cell.id) : undefined;
      if (!parent) continue;
      const element = node.draft.element;
      if (PARENT_TYPE[element.type] === parent.draft.element.type) {
        element.parentId ??= parent.draft.element.id;
      } else {
        this.warnings.add(
          `Página «${page.name}»: «${element.name}» (${element.type}) está dentro de «${parent.draft.element.name}» (${parent.draft.element.type}), que no puede contenerlo; se importa sin padre.`,
        );
      }
    }

    // ── Relaciones.
    let dangling = 0;
    for (const cell of cells.values()) {
      if (!cell.edge || hidden(cell) || cell.parent === '0') continue;
      const source = cell.source !== undefined ? nodeByCell.get(cell.source) : undefined;
      const target = cell.target !== undefined ? nodeByCell.get(cell.target) : undefined;
      if (!source || !target) {
        dangling += 1;
        continue;
      }
      if (source.draft === target.draft) {
        this.warnings.add(`Página «${page.name}»: una flecha une «${source.draft.element.name}» consigo mismo; se omite.`);
        continue;
      }
      this.addRelationship(cell, source.draft.element.id, target.draft.element.id, edgeLabels.get(cell.id));
    }
    if (dangling > 0) this.warnings.add(`Página «${page.name}»: se omitieron ${dangling} flecha(s) sin origen o destino conectado a una forma importada.`);

    this.analyses.push({ page, nodes });
  }

  /** ¿Hay ya un contenedor con este nombre (de una página anterior)? Sirve para tipar el marco de una página C3. */
  private knowsContainer(name: string): boolean {
    const wanted = normalizeName(name);
    return this.elementOrder.some((d) => d.element.type === 'container' && normalizeName(d.element.name) === wanted);
  }

  private upsertElement(key: string, c: Candidate, ownId: string | undefined, page: DrawioPage): ElementDraft {
    const type = c.type!;
    const existing = this.drafts.get(key);
    if (existing) {
      const e = existing.element;
      if (e.type !== type) this.warnings.add(`Página «${page.name}»: «${e.name}» aparece como ${type} y como ${e.type}; se usa ${e.type}.`);
      e.description ??= c.description;
      e.technology ??= c.technology;
      e.shape ??= c.shape;
      e.color ??= c.color;
      if (c.external) e.external ??= true;
      existing.linkPageId ??= c.linkPageId;
      return existing;
    }
    const id = ownId !== undefined ? pickId(ownId, this.elementIds) : pickId(slugify(c.name) || type, this.elementIds, this.reservedElementIds);
    const element: C4Element = { id, type, name: c.name };
    if (c.description) element.description = c.description;
    if (c.technology) element.technology = c.technology;
    if (c.external) element.external = true;
    if (c.shape) element.shape = c.shape;
    if (c.color) element.color = c.color;
    const draft: ElementDraft = { element, linkPageId: c.linkPageId };
    this.drafts.set(key, draft);
    this.elementOrder.push(draft);
    return draft;
  }

  private addRelationship(cell: RawCell, sourceId: string, targetId: string, extraLines: string[] | undefined): void {
    const own = ownEdgeId(cell.id);
    const baseId = own?.baseId;
    const implied = own?.implied ?? false;

    let description: string | undefined;
    let technology: string | undefined;
    if (cell.attrs.c4Description !== undefined || cell.attrs.c4Technology !== undefined) {
      description = cell.attrs.c4Description?.trim() || undefined;
      technology = cell.attrs.c4Technology?.trim() || undefined;
    } else {
      const isHtml = parseStyle(cell.style).props.html === '1';
      const parts = this.edgeText(labelToLines(resolvePlaceholders(cell.value, cell.attrs, isHtml), isHtml));
      description = parts.description;
      technology = parts.technology;
    }
    if (!description && extraLines) {
      const parts = this.edgeText(extraLines);
      description = parts.description;
      technology ??= parts.technology;
    }

    const key = baseId !== undefined ? `id:${baseId}` : `p:${sourceId}->${targetId}|${description ?? ''}|${technology ?? ''}`;
    const existing = this.relationships.get(key);
    // Una flecha implícita solo describe la relación si ninguna página la dibuja directamente entre sus extremos reales.
    if (existing && (implied || !existing.implied)) return;
    const relationship: C4Relationship = {
      id: existing
        ? existing.relationship.id
        : baseId !== undefined
          ? pickId(baseId, this.relationshipIds)
          : pickId(`${sourceId}--${targetId}`, this.relationshipIds, this.reservedRelationshipIds),
      sourceId,
      targetId,
    };
    if (description) relationship.description = description;
    if (technology) relationship.technology = technology;
    this.relationships.set(key, { relationship, implied });
  }

  private edgeText(lines: string[]): { description?: string; technology?: string } {
    const description: string[] = [];
    let technology: string | undefined;
    for (const line of lines) {
      const inner = bracketContent(line);
      if (inner !== null && technology === undefined) technology = inner;
      else description.push(line);
    }
    return { description: description.join(' ') || undefined, technology };
  }

  // ───────────────────────── Páginas → vistas ─────────────────────────

  private buildViews(): C4View[] {
    const usedIds = new Set<string>();
    const reserved = new Set(this.pages.map((p) => p.id).filter((id): id is string => !!id && READABLE_ID.test(id) && id.length <= MAX_READABLE_LENGTH));
    const views: C4View[] = [];

    for (const { page, nodes } of this.analyses) {
      if (nodes.length === 0) {
        this.warnings.add(`La página «${page.name}» no tiene formas importables; no se crea su vista.`);
        continue;
      }
      // Un id de página legible (los de `toDrawio`) se conserva como id de vista; los aleatorios de draw.io se sustituyen por el nombre.
      const id = page.id && reserved.has(page.id) ? pickId(page.id, usedIds) : pickId(slugify(page.name) || 'vista', usedIds, reserved);

      const scopeNode = this.scopeOf(page, nodes);
      const scope = scopeNode?.draft.element ?? this.linkedScope(page);
      const leaves = nodes.filter((n) => n.cand.children.length === 0);
      const type: ViewType = scope
        ? scope.type === 'container'
          ? 'component'
          : 'container'
        : leaves.some((n) => n.draft.element.type === 'component')
          ? 'component'
          : leaves.some((n) => n.draft.element.type === 'container')
            ? 'container'
            : 'systemContext';

      const elements: C4ViewElement[] = [];
      const seen = new Set<string>();
      for (const node of nodes) {
        const element = node.draft.element;
        if (seen.has(element.id) || (type !== 'systemContext' && element.id === scope?.id)) continue;
        seen.add(element.id);
        // Los boundaries no llevan geometría propia: se derivan de sus hijos.
        elements.push(node.cand.children.length === 0 && node.rect ? { id: element.id, ...node.rect } : { id: element.id });
      }
      const view: C4View = { id, type, title: page.name, elements };
      if (scope && VIEW_SCOPE_TYPE[type] === scope.type) view.scopeId = scope.id;
      views.push(view);
    }

    // Una vista de contexto sin marco de alcance: su sistema es el único propio que tiene una vista de detalle.
    const detailed = new Set(views.filter((v) => v.type !== 'systemContext').map((v) => v.scopeId));
    const elementById = new Map(this.elementOrder.map((d) => [d.element.id, d.element]));
    for (const view of views) {
      if (view.type !== 'systemContext' || view.scopeId) continue;
      const own = view.elements
        .map((e) => elementById.get(e.id)!)
        .filter((e) => e.type === 'softwareSystem' && !e.external && detailed.has(e.id));
      if (own.length === 1) view.scopeId = own[0].id;
    }
    return views;
  }

  /** Marco de alcance de la página: el boundary (sistema o contenedor) más externo; si hay varios, el enlazado o el mayor. */
  private scopeOf(page: DrawioPage, nodes: PageNode[]): PageNode | undefined {
    const roots = nodes.filter(
      (n) => n.cand.children.length > 0 && !n.cand.parent && (n.draft.element.type === 'softwareSystem' || n.draft.element.type === 'container'),
    );
    if (roots.length <= 1) return roots[0];
    const linked = roots.find((n) => page.id !== undefined && n.draft.linkPageId === page.id);
    if (linked) return linked;
    const area = (n: PageNode): number => (n.rect ? n.rect.width * n.rect.height : 0);
    return roots.reduce((best, n) => (area(n) > area(best) ? n : best));
  }

  /** Alcance deducido de un enlace `data:page/id,<página>` de un sistema o contenedor que apunta a esta página. */
  private linkedScope(page: DrawioPage): C4Element | undefined {
    if (!page.id) return undefined;
    return this.elementOrder.find(
      (d) => d.linkPageId === page.id && (d.element.type === 'softwareSystem' || d.element.type === 'container'),
    )?.element;
  }
}

/**
 * Convierte un archivo de draw.io (`.drawio`, sin comprimir o con páginas comprimidas) en un documento C4.
 *
 * Cada página pasa a ser una vista. Reconoce los `.drawio` que genera `toDrawio` (recuperando los ids) y los
 * de la librería C4 de draw.io (atributos `c4Name`, `c4Type`, `c4Description`, `c4Technology`); las formas
 * sueltas se interpretan por su texto (`Nombre`, `[Tipo: tecnología]`, descripción), su forma (persona,
 * cilindro) y su anidamiento (sistema › contenedor › componente). Lo que no se puede importar se comunica en
 * `warnings`. Lanza `DrawioImportError` si el archivo no es un diagrama de draw.io utilizable.
 */
export async function fromDrawio(xml: string, options: DrawioImportOptions = {}): Promise<DrawioImportResult> {
  const pages = await readPages(xml);
  return new Importer(pages).run(options.name?.trim() || 'Diagrama C4');
}
