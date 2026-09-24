import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { deriveView, type DerivedBoundary, type DerivedNode, type DerivedView } from '../model/viewDerivation';
import { BOUNDARY_PADDING, type C4Document, type C4View, type C4ViewElement, type LayoutDirection } from '../model/types';

export interface LayoutOptions {
  direction?: LayoutDirection;
  spacing?: number;
  layerSpacing?: number;
  /** Recalcular todo aunque ya haya coordenadas. */
  force?: boolean;
}

export interface PositionedElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  viewId: string;
  positions: PositionedElement[];
  /** Geometría calculada de los boundaries (derivada; no se persiste). */
  boundaries: PositionedElement[];
}

const DEFAULTS = { direction: 'DOWN' as LayoutDirection, spacing: 60, layerSpacing: 90 };

let elkInstance: InstanceType<typeof ELK> | null = null;
function elk(): InstanceType<typeof ELK> {
  if (!elkInstance) elkInstance = new ELK();
  return elkInstance;
}

/**
 * Calcula posiciones absolutas para los nodos de una vista usando ELK (algoritmo
 * `layered` con jerarquía incluida, para que los boundaries se traten como nodos
 * compuestos). Devuelve las posiciones, sin mutar el documento.
 */
export async function layoutView(doc: C4Document, viewId: string, options: LayoutOptions = {}): Promise<LayoutResult> {
  const derived = deriveView(doc, viewId);
  return layoutDerivedView(derived, options);
}

export async function layoutDerivedView(derived: DerivedView, options: LayoutOptions = {}): Promise<LayoutResult> {
  const { view, nodes, boundaries, edges } = derived;
  const direction = options.direction ?? view.layout?.direction ?? DEFAULTS.direction;
  const spacing = options.spacing ?? view.layout?.spacing ?? DEFAULTS.spacing;
  const layerSpacing = options.layerSpacing ?? view.layout?.layerSpacing ?? DEFAULTS.layerSpacing;
  const force = options.force ?? false;

  if (nodes.length === 0) return { viewId: view.id, positions: [], boundaries: [] };

  const anyPositioned = nodes.some((n) => n.positioned);
  const allPositioned = nodes.every((n) => n.positioned);
  if (allPositioned && !force) {
    return {
      viewId: view.id,
      positions: nodes.map((n) => ({ id: n.id, x: n.x!, y: n.y!, width: n.width, height: n.height })),
      boundaries: boundaries
        .filter((b) => b.x !== undefined)
        .map((b) => ({ id: b.id, x: b.x!, y: b.y!, width: b.width!, height: b.height! })),
    };
  }
  const interactive = anyPositioned && !force;

  const rootOptions: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': String(spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
    'elk.spacing.edgeNode': '30',
    'elk.spacing.edgeEdge': '20',
    'elk.layered.spacing.edgeNodeBetweenLayers': '30',
    'elk.spacing.componentComponent': String(spacing),
    'elk.layered.nodePlacement.strategy': interactive ? 'INTERACTIVE' : 'BRANDES_KOEPF',
    'elk.layered.crossingMinimization.strategy': interactive ? 'INTERACTIVE' : 'LAYER_SWEEP',
    'elk.layered.cycleBreaking.strategy': interactive ? 'INTERACTIVE' : 'GREEDY',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.padding': '[top=20,left=20,bottom=20,right=20]',
  };

  const boundaryPadding = `[top=${BOUNDARY_PADDING.top},left=${BOUNDARY_PADDING.left},bottom=${BOUNDARY_PADDING.bottom},right=${BOUNDARY_PADDING.right}]`;

  const elkNodeFor = (n: DerivedNode): ElkNode => ({
    id: n.id,
    width: n.width,
    height: n.height,
    ...(interactive && n.positioned ? { x: n.x, y: n.y } : {}),
    layoutOptions: interactive && n.positioned ? { 'elk.position': `(${n.x},${n.y})` } : undefined,
  });

  const boundaryById = new Map(boundaries.map((b) => [b.id, b]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const build = (b: DerivedBoundary): ElkNode => ({
    id: b.id,
    layoutOptions: { 'elk.padding': boundaryPadding, 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': '(200, 120)' },
    children: b.children.map((cid) => (nodeById.has(cid) ? elkNodeFor(nodeById.get(cid)!) : build(boundaryById.get(cid)!))),
  });

  const topLevel: ElkNode[] = [
    ...boundaries.filter((b) => !b.boundaryId).map(build),
    ...nodes.filter((n) => !n.boundaryId).map(elkNodeFor),
  ];

  const elkEdges: ElkExtendedEdge[] = edges.map((e) => ({ id: e.id, sources: [e.sourceId], targets: [e.targetId] }));

  const graph: ElkNode = { id: 'root', layoutOptions: rootOptions, children: topLevel, edges: elkEdges };
  const result = await elk().layout(graph);

  const positions: PositionedElement[] = [];
  const boundaryPositions: PositionedElement[] = [];
  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    for (const child of node.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      const item = { id: child.id, x: round(x), y: round(y), width: child.width ?? 0, height: child.height ?? 0 };
      if (boundaryById.has(child.id)) {
        boundaryPositions.push(item);
        walk(child, x, y);
      } else {
        positions.push(item);
      }
    }
  };
  walk(result, 0, 0);

  return { viewId: view.id, positions, boundaries: boundaryPositions };
}

function round(n: number): number {
  return Math.round(n);
}

/** Devuelve una copia de la vista con las posiciones aplicadas. */
export function applyLayoutToView(view: C4View, result: LayoutResult): C4View {
  const byId = new Map(result.positions.map((p) => [p.id, p]));
  const elements: C4ViewElement[] = view.elements.map((ve) => {
    const p = byId.get(ve.id);
    return p ? { ...ve, x: p.x, y: p.y, width: p.width, height: p.height } : ve;
  });
  return { ...view, elements };
}

/** Aplica autolayout a una vista y devuelve un documento nuevo (inmutable). */
export async function autoLayoutView(doc: C4Document, viewId: string, options: LayoutOptions = {}): Promise<C4Document> {
  const result = await layoutView(doc, viewId, options);
  return {
    ...doc,
    views: doc.views.map((v) => (v.id === viewId ? applyLayoutToView(v, result) : v)),
  };
}

/** Aplica autolayout a todas las vistas del documento (solo a las que lo necesitan, salvo `force`). */
export async function autoLayoutDocument(doc: C4Document, options: LayoutOptions = {}): Promise<C4Document> {
  let current = doc;
  for (const view of doc.views) {
    current = await autoLayoutView(current, view.id, options);
  }
  return current;
}
