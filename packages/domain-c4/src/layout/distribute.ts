import type { DerivedView } from '../model/viewDerivation';
import { BOUNDARY_PADDING, type LayoutDirection } from '../model/types';
import type { PositionedElement } from './elkLayout';
import { estimateLabelSize } from './labelMetrics';
import { rectFromFC, rectToFC, isVertical, type FCRect } from './geometry';

/**
 * Distribución centrada y uniforme: toma las capas que produjo ELK y las
 * recoloca con separación uniforme entre capas y entre nodos, con cada capa
 * centrada sobre un eje común. Los hijos de un boundary quedan contiguos y los
 * nodos exteriores se colocan fuera de la extensión del boundary.
 */

export interface DistributeParams {
  direction: LayoutDirection;
  spacing: number;
  layerSpacing: number;
}

export interface DistributedLayout {
  positions: PositionedElement[];
  /** Índice de capa de cada nodo (0 = primera capa en el sentido del flujo). */
  layerOf: Map<string, number>;
}

interface LayerNode extends FCRect {
  /** Cadena de boundaries (del más externo al más interno) que contienen al nodo. */
  chain: string[];
}

const LAYER_TOLERANCE = 2;

export function distributeCentered(positions: PositionedElement[], derived: DerivedView, params: DistributeParams): DistributedLayout {
  const { direction, spacing, layerSpacing } = params;
  if (positions.length === 0) return { positions: [], layerOf: new Map() };

  const boundaryParent = new Map(derived.boundaries.map((b) => [b.id, b.boundaryId]));
  const nodeBoundary = new Map(derived.nodes.map((n) => [n.id, n.boundaryId]));
  const chainOf = (nodeId: string): string[] => {
    const chain: string[] = [];
    let current = nodeBoundary.get(nodeId);
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      chain.unshift(current);
      current = boundaryParent.get(current);
    }
    return chain;
  };

  // 1. Capas a partir de la coordenada de flujo de ELK.
  const nodes: LayerNode[] = positions.map((p) => ({ ...rectToFC(p, direction), chain: chainOf(p.id) }));
  const sorted = [...nodes].sort((a, b) => a.flow - b.flow);
  const layers: LayerNode[][] = [];
  for (const n of sorted) {
    const last = layers[layers.length - 1];
    if (last && Math.abs(last[0].flow - n.flow) <= LAYER_TOLERANCE) last.push(n);
    else layers.push([n]);
  }
  const layerOf = new Map<string, number>();
  layers.forEach((layer, i) => layer.forEach((n) => layerOf.set(n.id, i)));

  // 2. Separación uniforme entre capas (espacio base + etiqueta más alta que cruza ese hueco).
  const labelExtent = (edge: DerivedView['edges'][number]): number => {
    const size = estimateLabelSize(edge.relationship.description, edge.relationship.technology);
    if (!size) return 0;
    return isVertical(direction) ? size.height : size.width;
  };
  const gapBefore: number[] = layers.map(() => layerSpacing);
  for (const e of derived.edges) {
    const a = layerOf.get(e.sourceId);
    const b = layerOf.get(e.targetId);
    if (a === undefined || b === undefined || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Las etiquetas se colocan en el hueco inmediatamente posterior a la capa de origen (o el central si salta capas).
    const gapIndex = hi - lo === 1 ? hi : Math.floor((lo + hi + 1) / 2);
    gapBefore[gapIndex] = Math.max(gapBefore[gapIndex], layerSpacing + labelExtent(e) + 16);
  }
  const layerThickness = layers.map((layer) => Math.max(...layer.map((n) => n.flowSize)));
  const layerStart: number[] = [];
  let cursor = 0;
  layers.forEach((_, i) => {
    if (i > 0) cursor += gapBefore[i];
    layerStart[i] = cursor;
    cursor += layerThickness[i];
  });

  // 3. Posición transversal: grupos por boundary, separación uniforme, capa centrada en 0.
  const cross = new Map<string, number>();
  const groupKey = (n: LayerNode) => n.chain.join('/');
  const placeContiguous = (items: LayerNode[], start: number): number => {
    let c = start;
    for (const n of items) {
      cross.set(n.id, c);
      c += n.crossSize + spacing;
    }
    return c - spacing;
  };
  const boundaryGap = spacing + BOUNDARY_PADDING.left + BOUNDARY_PADDING.right;

  interface Group {
    key: string;
    items: LayerNode[];
    mean: number;
  }
  const groupsOf = (layer: LayerNode[]): Group[] => {
    const map = new Map<string, LayerNode[]>();
    for (const n of layer) map.set(groupKey(n), [...(map.get(groupKey(n)) ?? []), n]);
    return [...map.entries()]
      .map(([key, items]) => ({ key, items: items.sort((a, b) => a.cross - b.cross), mean: items.reduce((s, n) => s + n.cross + n.crossSize / 2, 0) / items.length }))
      .sort((a, b) => a.mean - b.mean);
  };

  // Pasada 1: capas con nodos interiores → centrar solo los grupos interiores.
  const layerGroups = layers.map(groupsOf);
  const insideLayers = new Set<number>();
  layerGroups.forEach((groups, i) => {
    const inside = groups.filter((g) => g.key !== '');
    if (inside.length === 0) return;
    insideLayers.add(i);
    const total = inside.reduce((s, g) => s + g.items.reduce((t, n) => t + n.crossSize, 0) + spacing * (g.items.length - 1), 0) + boundaryGap * (inside.length - 1);
    let c = -total / 2;
    for (const g of inside) c = placeContiguous(g.items, c) + boundaryGap;
  });

  // Extensión transversal y de capas de cada boundary (sobre sus miembros ya colocados).
  const extent = new Map<string, { min: number; max: number; firstLayer: number; lastLayer: number }>();
  for (const n of nodes) {
    const c = cross.get(n.id);
    if (c === undefined) continue;
    const layer = layerOf.get(n.id)!;
    for (const b of n.chain) {
      const e = extent.get(b) ?? { min: Infinity, max: -Infinity, firstLayer: Infinity, lastLayer: -Infinity };
      e.min = Math.min(e.min, c - BOUNDARY_PADDING.left);
      e.max = Math.max(e.max, c + n.crossSize + BOUNDARY_PADDING.right);
      e.firstLayer = Math.min(e.firstLayer, layer);
      e.lastLayer = Math.max(e.lastLayer, layer);
      extent.set(b, e);
    }
  }

  // Pasada 2: nodos exteriores. Si la capa está dentro del rango de capas de algún boundary,
  // se colocan fuera de la unión de sus extensiones; si no, la capa se centra normalmente.
  layerGroups.forEach((groups, i) => {
    const outside = groups.filter((g) => g.key === '').flatMap((g) => g.items);
    if (outside.length === 0) return;
    const active = [...extent.values()].filter((e) => e.firstLayer <= i && i <= e.lastLayer);
    if (active.length === 0) {
      const total = outside.reduce((s, n) => s + n.crossSize, 0) + spacing * (outside.length - 1);
      placeContiguous(outside, -total / 2);
      return;
    }
    const min = Math.min(...active.map((e) => e.min));
    const max = Math.max(...active.map((e) => e.max));
    const center = (min + max) / 2;
    const left = outside.filter((n) => n.cross + n.crossSize / 2 < centerOriginal(active, nodes, center)).sort((a, b) => b.cross - a.cross);
    const right = outside.filter((n) => !left.includes(n)).sort((a, b) => a.cross - b.cross);
    let c = min - spacing;
    for (const n of left) {
      c -= n.crossSize;
      cross.set(n.id, c);
      c -= spacing;
    }
    c = max + spacing;
    for (const n of right) {
      cross.set(n.id, c);
      c += n.crossSize + spacing;
    }
  });

  // 4. Volver a coordenadas x/y, centrando cada nodo en el grosor de su capa y normalizando el origen.
  const placed: FCRect[] = nodes.map((n) => {
    const i = layerOf.get(n.id)!;
    return { id: n.id, flow: layerStart[i] + (layerThickness[i] - n.flowSize) / 2, cross: cross.get(n.id) ?? 0, flowSize: n.flowSize, crossSize: n.crossSize };
  });
  const minFlow = Math.min(...placed.map((p) => p.flow));
  const minCross = Math.min(...placed.map((p) => p.cross));
  const out = placed.map((p) => rectFromFC({ ...p, flow: Math.round(p.flow - minFlow + 20), cross: Math.round(p.cross - minCross + 20) }, direction));
  return { positions: out.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height })), layerOf };
}

/** Centro transversal original (coordenadas de ELK) de los nodos interiores de los boundaries activos, para decidir el lado de los exteriores. */
function centerOriginal(active: Array<{ min: number; max: number }>, nodes: LayerNode[], fallback: number): number {
  const inside = nodes.filter((n) => n.chain.length > 0);
  if (inside.length === 0 || active.length === 0) return fallback;
  return inside.reduce((s, n) => s + n.cross + n.crossSize / 2, 0) / inside.length;
}
