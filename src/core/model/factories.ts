import { nanoid } from 'nanoid';
import {
  DEFAULT_SIZES,
  DOCUMENT_VERSION,
  ELEMENT_TYPE_LABELS,
  VIEW_TYPE_LABELS,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
  type ElementType,
  type ViewType,
} from './types';

/** Convierte un nombre en un id legible y estable (kebab-case ASCII). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = base || nanoid(6);
  if (!used.has(root)) return root;
  let i = 2;
  while (used.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
}

export function createEmptyDocument(name = 'Nuevo diagrama C4'): C4Document {
  return {
    version: DOCUMENT_VERSION,
    workspace: { name },
    model: { elements: [], relationships: [] },
    views: [],
  };
}

export function createElement(
  type: ElementType,
  partial: Partial<Omit<C4Element, 'type'>> & { name?: string } = {},
  existingIds: Iterable<string> = [],
): C4Element {
  const name = partial.name ?? `${ELEMENT_TYPE_LABELS[type]} nuevo`;
  const id = partial.id ?? uniqueId(slugify(name), existingIds);
  const element: C4Element = { id, type, name };
  if (partial.description !== undefined) element.description = partial.description;
  if (partial.technology !== undefined) element.technology = partial.technology;
  if (partial.tags !== undefined) element.tags = partial.tags;
  if (partial.external !== undefined) element.external = partial.external;
  if (partial.parentId !== undefined) element.parentId = partial.parentId;
  if (partial.shape !== undefined) element.shape = partial.shape;
  if (partial.color !== undefined) element.color = partial.color;
  return element;
}

export function createRelationship(
  sourceId: string,
  targetId: string,
  partial: Partial<Omit<C4Relationship, 'sourceId' | 'targetId'>> = {},
  existingIds: Iterable<string> = [],
): C4Relationship {
  const id = partial.id ?? uniqueId(`${sourceId}--${targetId}`, existingIds);
  const rel: C4Relationship = { id, sourceId, targetId };
  if (partial.description !== undefined) rel.description = partial.description;
  if (partial.technology !== undefined) rel.technology = partial.technology;
  if (partial.tags !== undefined) rel.tags = partial.tags;
  return rel;
}

export function createView(
  type: ViewType,
  partial: Partial<Omit<C4View, 'type'>> = {},
  existingIds: Iterable<string> = [],
): C4View {
  const title = partial.title ?? VIEW_TYPE_LABELS[type];
  const id = partial.id ?? uniqueId(slugify(`${type}-${partial.scopeId ?? title}`), existingIds);
  const view: C4View = { id, type, title, elements: partial.elements ?? [] };
  if (partial.scopeId !== undefined) view.scopeId = partial.scopeId;
  if (partial.description !== undefined) view.description = partial.description;
  if (partial.layout !== undefined) view.layout = partial.layout;
  return view;
}

export function defaultSize(element: Pick<C4Element, 'type'>): { width: number; height: number } {
  return DEFAULT_SIZES[element.type];
}

/** Devuelve el conjunto de ids de los ancestros (padre, abuelo, …) de un elemento. */
export function ancestorIds(elementId: string, elements: Map<string, C4Element>): string[] {
  const result: string[] = [];
  let current = elements.get(elementId);
  const guard = new Set<string>();
  while (current?.parentId && !guard.has(current.parentId)) {
    guard.add(current.parentId);
    result.push(current.parentId);
    current = elements.get(current.parentId);
  }
  return result;
}

export function elementMap(doc: C4Document): Map<string, C4Element> {
  return new Map(doc.model.elements.map((e) => [e.id, e]));
}

/**
 * Construye la lista de elementos que "por defecto" pertenecen a una vista según C4:
 * - contexto: el sistema, todas las personas y sistemas relacionados con él;
 * - contenedores: los contenedores del sistema y todo lo relacionado con ellos desde fuera;
 * - componentes: los componentes del contenedor y todo lo relacionado con ellos desde fuera.
 */
export function suggestViewElements(doc: C4Document, type: ViewType, scopeId?: string): string[] {
  const elements = elementMap(doc);
  const ids = new Set<string>();
  if (type === 'systemContext') {
    if (scopeId) ids.add(scopeId);
    for (const rel of doc.model.relationships) {
      const src = elements.get(rel.sourceId);
      const tgt = elements.get(rel.targetId);
      if (!src || !tgt) continue;
      const srcTop = topLevelId(rel.sourceId, elements);
      const tgtTop = topLevelId(rel.targetId, elements);
      if (!scopeId || srcTop === scopeId || tgtTop === scopeId) {
        ids.add(srcTop);
        ids.add(tgtTop);
      }
    }
    if (!scopeId) {
      for (const el of doc.model.elements) {
        if (el.type === 'person' || el.type === 'softwareSystem') ids.add(el.id);
      }
    }
    return [...ids];
  }

  const childType = type === 'container' ? 'container' : 'component';
  const children = doc.model.elements.filter((e) => e.type === childType && e.parentId === scopeId);
  children.forEach((c) => ids.add(c.id));
  const childIds = new Set(children.map((c) => c.id));
  for (const rel of doc.model.relationships) {
    const inside = childIds.has(rel.sourceId) ? rel.targetId : childIds.has(rel.targetId) ? rel.sourceId : null;
    if (!inside) continue;
    // El otro extremo se muestra al nivel más alto que no pertenezca al alcance.
    const other = elements.get(inside);
    if (!other) continue;
    const chain = [inside, ...ancestorIds(inside, elements)];
    if (scopeId && chain.includes(scopeId)) continue; // hermano interno: ya está incluido
    // Para vistas de contenedores mostramos sistemas externos (nivel superior); para componentes, contenedores.
    const pick =
      type === 'container'
        ? topLevelId(inside, elements)
        : (chain.find((id) => elements.get(id)?.type === 'container') ?? topLevelId(inside, elements));
    ids.add(pick);
  }
  return [...ids];
}

export type ViewLevel = 'C1' | 'C2' | 'C3';

/** Nivel C4 de una vista: contexto = C1, contenedores = C2, componentes = C3. */
export function viewLevel(view: Pick<C4View, 'type'>): ViewLevel {
  return view.type === 'systemContext' ? 'C1' : view.type === 'container' ? 'C2' : 'C3';
}

/** Tipo de vista "hija" que detalla a un elemento (sistema → contenedores, contenedor → componentes). */
export function childViewType(element: Pick<C4Element, 'type'>): ViewType | null {
  if (element.type === 'softwareSystem') return 'container';
  if (element.type === 'container') return 'component';
  return null;
}

/** Vista que detalla el interior de un elemento (nivel inferior), si existe en el documento. */
export function findChildView(doc: C4Document, elementId: string): C4View | undefined {
  const element = doc.model.elements.find((e) => e.id === elementId);
  if (!element) return undefined;
  const type = childViewType(element);
  if (!type) return undefined;
  return doc.views.find((v) => v.type === type && v.scopeId === elementId);
}

/** Vista de nivel superior a la dada (C3 → C2 del contenedor padre, C2 → C1 del sistema), si existe. */
export function findParentView(doc: C4Document, view: C4View): C4View | undefined {
  if (view.type === 'systemContext') return undefined;
  const scope = view.scopeId ? doc.model.elements.find((e) => e.id === view.scopeId) : undefined;
  if (view.type === 'component') {
    const containerId = scope?.parentId;
    return doc.views.find((v) => v.type === 'container' && v.scopeId === containerId) ?? doc.views.find((v) => v.type === 'container');
  }
  return doc.views.find((v) => v.type === 'systemContext' && v.scopeId === view.scopeId) ?? doc.views.find((v) => v.type === 'systemContext');
}

/** Cadena de navegación C1 › C2 › C3 que conduce a la vista dada (la propia vista al final). */
export function viewBreadcrumb(doc: C4Document, viewId: string): C4View[] {
  const chain: C4View[] = [];
  let current = doc.views.find((v) => v.id === viewId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.unshift(current);
    current = findParentView(doc, current);
  }
  return chain;
}

export function topLevelId(elementId: string, elements: Map<string, C4Element>): string {
  const chain = ancestorIds(elementId, elements);
  return chain.length ? chain[chain.length - 1] : elementId;
}
