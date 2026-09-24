import { ancestorIds, elementMap } from './factories';
import {
  BOUNDARY_PADDING,
  DEFAULT_SIZES,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
} from './types';

export interface DerivedNode {
  id: string;
  element: C4Element;
  /** Boundary (id de elemento) que contiene visualmente a este nodo, si lo hay. */
  boundaryId?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  positioned: boolean;
}

export interface DerivedBoundary {
  id: string;
  element: C4Element;
  /** Boundary padre (anidamiento), si lo hay. */
  boundaryId?: string;
  /** Ids de nodos y boundaries directamente contenidos. */
  children: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DerivedEdge {
  id: string;
  relationship: C4Relationship;
  sourceId: string;
  targetId: string;
  /** true si algún extremo se resolvió a un ancestro visible en lugar del elemento real. */
  implied: boolean;
}

export interface DerivedView {
  view: C4View;
  nodes: DerivedNode[];
  boundaries: DerivedBoundary[];
  edges: DerivedEdge[];
}

/**
 * Deriva lo que se dibuja en una vista a partir del modelo:
 * - qué elementos son nodos y cuáles boundaries (el alcance de la vista y todo
 *   elemento visible que tenga hijos visibles);
 * - dentro de qué boundary va cada nodo;
 * - qué relaciones se dibujan (directas o implícitas hacia el ancestro visible).
 */
export function deriveView(doc: C4Document, viewId: string): DerivedView {
  const view = doc.views.find((v) => v.id === viewId);
  if (!view) throw new Error(`La vista "${viewId}" no existe`);
  const elements = elementMap(doc);

  const visibleIds = new Set<string>();
  for (const ve of view.elements) if (elements.has(ve.id)) visibleIds.add(ve.id);

  const boundaryIds = new Set<string>();
  if (view.type !== 'systemContext' && view.scopeId && elements.has(view.scopeId)) {
    boundaryIds.add(view.scopeId);
  }
  for (const id of visibleIds) {
    const el = elements.get(id)!;
    if (el.parentId && visibleIds.has(el.parentId)) boundaryIds.add(el.parentId);
  }
  // Los ancestros intermedios de un boundary también son boundaries si están visibles.
  for (const id of [...boundaryIds]) {
    for (const anc of ancestorIds(id, elements)) if (visibleIds.has(anc)) boundaryIds.add(anc);
  }

  const nearestBoundary = (id: string): string | undefined =>
    ancestorIds(id, elements).find((anc) => boundaryIds.has(anc));

  const geometry = new Map(view.elements.map((ve) => [ve.id, ve]));

  const nodes: DerivedNode[] = [];
  for (const id of visibleIds) {
    if (boundaryIds.has(id)) continue;
    const element = elements.get(id)!;
    const g = geometry.get(id);
    const size = DEFAULT_SIZES[element.type];
    nodes.push({
      id,
      element,
      boundaryId: nearestBoundary(id),
      x: g?.x,
      y: g?.y,
      width: g?.width ?? size.width,
      height: g?.height ?? size.height,
      positioned: g?.x !== undefined && g?.y !== undefined,
    });
  }

  const boundaries: DerivedBoundary[] = [...boundaryIds].map((id) => ({
    id,
    element: elements.get(id)!,
    boundaryId: nearestBoundary(id),
    children: [],
  }));
  const boundaryById = new Map(boundaries.map((b) => [b.id, b]));
  for (const n of nodes) if (n.boundaryId) boundaryById.get(n.boundaryId)?.children.push(n.id);
  for (const b of boundaries) if (b.boundaryId) boundaryById.get(b.boundaryId)?.children.push(b.id);

  // Ordenar boundaries de más interno a más externo para calcular geometría.
  const depth = (b: DerivedBoundary): number => (b.boundaryId ? 1 + depth(boundaryById.get(b.boundaryId)!) : 0);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const b of [...boundaries].sort((a, c) => depth(c) - depth(a))) {
    const rects = b.children
      .map((cid) => nodeById.get(cid) ?? boundaryById.get(cid))
      .filter((r): r is DerivedNode | DerivedBoundary => !!r && r.x !== undefined && r.y !== undefined && r.width !== undefined && r.height !== undefined);
    if (rects.length === 0) continue;
    const minX = Math.min(...rects.map((r) => r.x!));
    const minY = Math.min(...rects.map((r) => r.y!));
    const maxX = Math.max(...rects.map((r) => r.x! + r.width!));
    const maxY = Math.max(...rects.map((r) => r.y! + r.height!));
    b.x = minX - BOUNDARY_PADDING.left;
    b.y = minY - BOUNDARY_PADDING.top;
    b.width = maxX - minX + BOUNDARY_PADDING.left + BOUNDARY_PADDING.right;
    b.height = maxY - minY + BOUNDARY_PADDING.top + BOUNDARY_PADDING.bottom;
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const resolveEndpoint = (id: string): { id: string; implied: boolean } | null => {
    if (nodeIds.has(id)) return { id, implied: false };
    const anc = ancestorIds(id, elements).find((a) => nodeIds.has(a));
    return anc ? { id: anc, implied: true } : null;
  };

  const edges: DerivedEdge[] = [];
  const seen = new Set<string>();
  for (const rel of doc.model.relationships) {
    const src = resolveEndpoint(rel.sourceId);
    const tgt = resolveEndpoint(rel.targetId);
    if (!src || !tgt || src.id === tgt.id) continue;
    const implied = src.implied || tgt.implied;
    const key = `${src.id}->${tgt.id}|${rel.description ?? ''}`;
    if (implied && seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: implied ? `${rel.id}@${src.id}->${tgt.id}` : rel.id,
      relationship: rel,
      sourceId: src.id,
      targetId: tgt.id,
      implied,
    });
  }

  return { view, nodes, boundaries, edges };
}

/** Rectángulo que envuelve todo lo dibujado en una vista (solo elementos posicionados). */
export function viewBounds(derived: DerivedView): { x: number; y: number; width: number; height: number } | null {
  const rects = [...derived.nodes, ...derived.boundaries].filter(
    (r) => r.x !== undefined && r.y !== undefined && r.width !== undefined && r.height !== undefined,
  );
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((r) => r.x!));
  const minY = Math.min(...rects.map((r) => r.y!));
  const maxX = Math.max(...rects.map((r) => r.x! + r.width!));
  const maxY = Math.max(...rects.map((r) => r.y! + r.height!));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
