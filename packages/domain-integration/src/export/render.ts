import { layoutGraph, renderGraphSvg, type GraphLayout, type GraphLayoutOptions, type ShapeKind } from '@iark/kernel';
import { KIND_LABELS, type IntegrationDocument, type IntegrationNode, type Interaction, type NodeKind } from '../types';
import { findView, type IntegrationView } from '../views';

/** Figura de cada tipo de nodo: la misma en el lienzo interactivo y en el SVG exportado. */
export const NODE_SHAPES: Record<NodeKind, ShapeKind> = { system: 'rect', api: 'rect', gateway: 'rect', broker: 'rect', queue: 'pill', topic: 'pill', store: 'cylinder' };

export const KIND_COLORS: Record<NodeKind, string> = {
  system: '#1168bd',
  api: '#0b7285',
  gateway: '#7048e8',
  broker: '#c2410c',
  queue: '#d9480f',
  topic: '#b45309',
  store: '#2b8a3e',
};

const EXTERNAL_COLOR = '#6b6b6b';

const SIZES: Record<NodeKind, { width: number; height: number }> = {
  system: { width: 200, height: 88 },
  api: { width: 180, height: 76 },
  gateway: { width: 180, height: 76 },
  broker: { width: 180, height: 76 },
  queue: { width: 170, height: 64 },
  topic: { width: 170, height: 64 },
  store: { width: 170, height: 84 },
};

/** Texto de la etiqueta de una interacción: número de paso, descripción y protocolo. */
export function interactionLabel(it: Interaction, step?: number): string {
  const text = [it.description, it.protocol ? `[${it.protocol}]` : undefined].filter(Boolean).join(' ');
  return step !== undefined ? `${step}. ${text}`.trim() : text;
}

export function colorOf(node: IntegrationNode): string {
  return node.external ? EXTERNAL_COLOR : KIND_COLORS[node.kind];
}

export interface RenderedView {
  view: IntegrationView;
  layout: GraphLayout;
  nodes: Map<string, IntegrationNode>;
  interactions: Map<string, Interaction>;
  labels: Map<string, string>;
}

/** Coloca una vista con el autolayout genérico del kernel. Los nodos con hijos en la vista se dibujan como agrupaciones. */
export async function layoutView(doc: IntegrationDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const nodes = new Map(doc.nodes.filter((n) => view.nodeIds.includes(n.id)).map((n) => [n.id, n]));
  const groupIds = new Set([...nodes.values()].filter((n) => n.parentId && nodes.has(n.parentId)).map((n) => n.parentId as string));
  const interactions = new Map(view.interactions.map(({ interaction }) => [interaction.id, interaction]));
  const labels = new Map(view.interactions.map(({ interaction, step }) => [interaction.id, interactionLabel(interaction, step)]));

  const graphNodes = [...nodes.values()]
    .filter((n) => !groupIds.has(n.id))
    .map((n) => ({ id: n.id, ...SIZES[n.kind], groupId: n.parentId && nodes.has(n.parentId) ? n.parentId : undefined }));
  const groups = [...groupIds].map((id) => ({ id, groupId: nodes.get(id)?.parentId && nodes.has(nodes.get(id)!.parentId!) ? nodes.get(id)!.parentId : undefined }));
  const edges = view.interactions.map(({ interaction }) => ({ id: interaction.id, source: interaction.sourceId, target: interaction.targetId, label: labels.get(interaction.id) || undefined }));

  const layout = await layoutGraph(graphNodes, edges, groups, { direction: 'RIGHT', ...options });
  return { view, layout, nodes, interactions, labels };
}

export async function toSvg(doc: IntegrationDocument, viewId?: string): Promise<string> {
  const { view, layout, nodes, interactions, labels } = await layoutView(doc, viewId);
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => {
      const n = nodes.get(id)!;
      return {
        fill: colorOf(n),
        stroke: '#0f172a55',
        badge: KIND_LABELS[n.kind],
        lines: [n.name, n.technology ?? '', n.owner ? `Responsable: ${n.owner}` : ''].filter(Boolean),
        shape: NODE_SHAPES[n.kind],
        dashed: n.external,
      };
    },
    edge: (id) => {
      const it = interactions.get(id)!;
      return {
        stroke: '#475569',
        dashed: it.style !== 'request-response',
        width: it.style === 'event' || it.style === 'stream' ? 2.5 : it.criticality === 'high' ? 2.25 : 1.5,
        label: labels.get(id),
      };
    },
    group: (id) => ({ label: `${KIND_LABELS[nodes.get(id)!.kind]}: ${nodes.get(id)!.name}` }),
  });
}
