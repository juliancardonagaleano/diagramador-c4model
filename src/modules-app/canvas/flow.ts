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

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: 'smoothstep';
  label?: string;
  style: { stroke: string; strokeWidth: number; strokeDasharray?: string };
  markerEnd?: { type: 'arrowclosed'; color: string };
  markerStart?: { type: 'arrowclosed'; color: string };
  data: { edge: EditorEdge; notation: EdgeNotation };
  selected?: boolean;
}

const notationOf = (spec: EditorSpec<unknown>, kind: string): NodeNotation => spec.nodeKinds.find((k) => k.kind === kind) ?? FALLBACK_NODE;
const edgeNotationOf = (spec: EditorSpec<unknown>, kind: string): EdgeNotation => spec.edgeKinds.find((k) => k.kind === kind) ?? FALLBACK_EDGE;

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 4', dotted: '2 4' };

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

  const nodes: FlowNode[] = [...graph.nodes]
    .sort((a, b) => depth(a.id) - depth(b.id))
    .map((n) => {
      const notation = notationOf(spec, n.kind);
      const abs = absolute.get(n.id)!;
      const parent = n.parentId && byId.has(n.parentId) ? absolute.get(n.parentId) : undefined;
      const group = parents.has(n.id);
      return {
        id: n.id,
        type: 'notation',
        position: parent ? { x: abs.x - parent.x, y: abs.y - parent.y } : { x: abs.x, y: abs.y },
        ...(parent ? { parentId: n.parentId } : {}),
        data: { node: n, notation, group, width: abs.width, height: abs.height },
        width: abs.width,
        height: abs.height,
        style: { width: abs.width, height: abs.height },
        zIndex: group ? 0 : 1,
      };
    });

  const edges: FlowEdge[] = graph.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => {
      const notation = edgeNotationOf(spec, e.kind);
      const width = e.width ?? notation.width ?? 1.5;
      const label = [e.label, ...(e.badges ?? []).map((b) => `«${b}»`)].filter(Boolean).join(' ');
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        ...(label ? { label } : {}),
        style: { stroke: notation.stroke, strokeWidth: width, strokeDasharray: DASH[notation.line ?? 'solid'] },
        ...(notation.arrowEnd === false ? {} : { markerEnd: { type: 'arrowclosed' as const, color: notation.stroke } }),
        ...(notation.arrowStart ? { markerStart: { type: 'arrowclosed' as const, color: notation.stroke } } : {}),
        data: { edge: e, notation },
      };
    });

  return { nodes, edges };
}
