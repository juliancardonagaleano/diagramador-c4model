import type { Box, EdgeNotation, EditorEdge, EditorGraph, EditorNode, EditorSpec, GraphLayout, NodeNotation } from '@iark/kernel';

export const FALLBACK_NODE: NodeNotation = { kind: '?', label: 'Elemento', glyph: '□', shape: 'rect', fill: '#475569', width: 180, height: 72 };
export const FALLBACK_EDGE: EdgeNotation = { kind: '?', label: 'Relación', stroke: '#475569', line: 'solid', width: 1.5 };

export interface FlowNodeData extends Record<string, unknown> {
  node: EditorNode;
  notation: NodeNotation;
  group: boolean;
  width: number;
  height: number;
}

export interface FlowNode {
  id: string;
  type: 'notation';
  position: { x: number; y: number };
  data: FlowNodeData;
  parentId?: string;
  /** Medidas conocidas de antemano: React Flow las usa para el minimapa y el encuadre sin esperar a medir el DOM. */
  width: number;
  height: number;
  style: { width: number; height: number };
  zIndex: number;
  selected?: boolean;
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: EditorEdge;
  notation: EdgeNotation;
  /** Selección desde la etiqueta de la arista (que se dibuja fuera del SVG de las aristas). */
  onPick?(id: string, additive: boolean): void;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: 'notation';
  style: { stroke: string; strokeWidth: number; strokeDasharray?: string };
  markerEnd?: { type: 'arrowclosed' | 'arrow'; color: string };
  markerStart?: { type: 'arrowclosed'; color: string };
  data: FlowEdgeData;
  selected?: boolean;
}

const ORIGIN = { x: 0, y: 0 };

type Placed = Pick<FlowNode, 'id' | 'position' | 'parentId'>;

/** Posición absoluta de cada nodo (la de React Flow es relativa al padre en los hijos de un grupo). */
export function absolutePositions(nodes: readonly Placed[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, { x: number; y: number }>();
  const resolve = (id: string, depth: number): { x: number; y: number } => {
    const known = result.get(id);
    if (known) return known;
    const node = byId.get(id)!;
    const parent = node.parentId && byId.has(node.parentId) && depth < 20 ? resolve(node.parentId, depth + 1) : ORIGIN;
    const at = { x: node.position.x + parent.x, y: node.position.y + parent.y };
    result.set(id, at);
    return at;
  };
  for (const n of nodes) resolve(n.id, 0);
  return result;
}

/**
 * Posiciones absolutas tras un arrastre: `changes` trae las nuevas posiciones (relativas al padre) que notifica React
 * Flow. Los descendientes de un grupo movido lo acompañan.
 */
export function movedByDrag(nodes: readonly Placed[], moved: ReadonlyMap<string, { x: number; y: number }>, changes: ReadonlyArray<{ id: string; position: { x: number; y: number } }>): Map<string, { x: number; y: number }> {
  const absolute = absolutePositions(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const dragged = new Set(changes.map((c) => c.id));
  const next = new Map(moved);
  for (const change of changes) {
    const node = byId.get(change.id);
    const before = absolute.get(change.id);
    if (!node || !before) continue;
    const parent = (node.parentId && absolute.get(node.parentId)) || ORIGIN;
    const after = { x: Math.round(change.position.x + parent.x), y: Math.round(change.position.y + parent.y) };
    next.set(change.id, after);
    const pending = [...(children.get(change.id) ?? [])];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const at = absolute.get(id);
      if (dragged.has(id) || !at) continue;
      next.set(id, { x: at.x + after.x - before.x, y: at.y + after.y - before.y });
      pending.push(...(children.get(id) ?? []));
    }
  }
  return next;
}

/**
 * Elemento sobre el que se ha soltado `id`: el más pequeño (que no sea él ni descendiente suyo) que contiene el centro de
 * su caja. Las posiciones son absolutas; `sizes` da el ancho y alto de cada nodo.
 */
export function dropTarget(nodes: readonly Placed[], sizes: ReadonlyMap<string, { width: number; height: number }>, id: string): string | undefined {
  const absolute = absolutePositions(nodes);
  const at = absolute.get(id);
  const size = sizes.get(id);
  if (!at || !size) return undefined;
  const center = { x: at.x + size.width / 2, y: at.y + size.height / 2 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inside = (candidate: string): boolean => {
    for (let p = byId.get(candidate)?.parentId, depth = 0; p && depth < 20; p = byId.get(p)?.parentId, depth++) if (p === id) return true;
    return false;
  };
  let best: { id: string; area: number } | undefined;
  for (const n of nodes) {
    const box = absolute.get(n.id);
    const dims = sizes.get(n.id);
    if (n.id === id || !box || !dims || inside(n.id)) continue;
    if (center.x < box.x || center.x > box.x + dims.width || center.y < box.y || center.y > box.y + dims.height) continue;
    const area = dims.width * dims.height;
    if (!best || area < best.area) best = { id: n.id, area };
  }
  return best?.id;
}

const notationOf = (spec: EditorSpec<unknown>, kind: string): NodeNotation => spec.nodeKinds.find((k) => k.kind === kind) ?? FALLBACK_NODE;
const edgeNotationOf = (spec: EditorSpec<unknown>, kind: string): EdgeNotation => spec.edgeKinds.find((k) => k.kind === kind) ?? FALLBACK_EDGE;

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 4', dotted: '2 4' };

const MARK_SLOT = 22;
const CHAR_WIDTH = 6.6;

/** Texto de la etiqueta de una arista: su nombre seguido de las insignias de texto entre «». */
export function edgeLabelText(edge: EditorEdge): string {
  return [edge.label, ...(edge.badges ?? []).map((b) => `«${b}»`)].filter(Boolean).join(' ');
}

/** Texto con el que se reserva el hueco de la etiqueta en el autolayout: el de la etiqueta y espacio para sus insignias gráficas. */
export function layoutLabelText(edge: EditorEdge): string {
  const room = '\u00a0'.repeat(Math.ceil(((edge.marks?.length ?? 0) * MARK_SLOT) / CHAR_WIDTH));
  const text = edgeLabelText(edge);
  return room ? `${room}${text}` : text;
}

/** Firma de la estructura del grafo: cambia cuando hay nodos, aristas o padres nuevos (no cuando solo cambia un texto). */
export function structureKey(graph: EditorGraph): string {
  return JSON.stringify([graph.nodes.map((n) => [n.id, n.parentId ?? '', n.label, n.sublabel ?? '']), graph.edges.map((e) => [e.id, e.source, e.target, e.label ?? ''])]);
}

/**
 * Convierte el grafo del módulo en nodos y aristas de React Flow. `layout` da las posiciones absolutas calculadas;
 * `moved` las que la persona ha arrastrado (tienen prioridad). Los nodos con hijos visibles son grupos: sus hijos llevan
 * `parentId` y posición relativa, y los padres van antes que los hijos, como exige React Flow.
 */
export function buildFlow(
  spec: EditorSpec<unknown>,
  graph: EditorGraph,
  layout: GraphLayout | undefined,
  moved: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parents = new Set(graph.nodes.filter((n) => n.parentId && byId.has(n.parentId)).map((n) => n.parentId as string));
  const boxes = new Map<string, Box>([...(layout?.nodes ?? []), ...(layout?.groups ?? [])].map((b) => [b.id, b]));

  const absolute = new Map<string, { x: number; y: number; width: number; height: number }>();
  graph.nodes.forEach((n, i) => {
    const notation = notationOf(spec, n.kind);
    const box = boxes.get(n.id);
    const fallback = { x: (i % 4) * 240, y: Math.floor(i / 4) * 140 };
    const at = moved.get(n.id) ?? (box ? { x: box.x, y: box.y } : fallback);
    absolute.set(n.id, { ...at, width: box?.width ?? n.width ?? notation.width, height: box?.height ?? n.height ?? notation.height });
  });

  const depth = (id: string): number => {
    let d = 0;
    for (let p = byId.get(id)?.parentId; p && byId.has(p) && d < 20; p = byId.get(p)?.parentId) d++;
    return d;
  };

  // Cada grupo queda por encima del que lo contiene y todos los elementos por encima de cualquier grupo.
  const leafZ = Math.max(0, ...graph.nodes.filter((n) => parents.has(n.id)).map((n) => depth(n.id))) + 1;

  const nodes: FlowNode[] = [...graph.nodes]
    .sort((a, b) => depth(a.id) - depth(b.id))
    .map((n) => {
      const notation = notationOf(spec, n.kind);
      const abs = absolute.get(n.id)!;
      const parent = n.parentId && byId.has(n.parentId) ? absolute.get(n.parentId) : undefined;
      const group = parents.has(n.id) || notation.container === true;
      return {
        id: n.id,
        type: 'notation',
        position: parent ? { x: abs.x - parent.x, y: abs.y - parent.y } : { x: abs.x, y: abs.y },
        ...(parent ? { parentId: n.parentId } : {}),
        data: { node: n, notation, group, width: abs.width, height: abs.height },
        width: abs.width,
        height: abs.height,
        style: { width: abs.width, height: abs.height },
        zIndex: group ? depth(n.id) : leafZ,
      };
    });

  const edges: FlowEdge[] = graph.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => {
      const notation = edgeNotationOf(spec, e.kind);
      const width = e.width ?? notation.width ?? 1.5;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'notation',
        style: { stroke: notation.stroke, strokeWidth: width, strokeDasharray: DASH[notation.line ?? 'solid'] },
        ...(notation.arrowEnd === false ? {} : { markerEnd: { type: notation.head === 'open' ? ('arrow' as const) : ('arrowclosed' as const), color: notation.stroke } }),
        ...(notation.arrowStart ? { markerStart: { type: 'arrowclosed' as const, color: notation.stroke } } : {}),
        data: { edge: e, notation },
      };
    });

  return { nodes, edges };
}
