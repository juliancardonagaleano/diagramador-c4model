import { layoutGraph, readableTextColor, renderGraphSvg, type EdgeMark, type GraphLayout, type GraphLayoutOptions } from '@iark/kernel';
import { KIND_LABELS, type IntegrationDocument, type IntegrationNode, type Interaction } from '../types';
import { KIND_COLORS, NODE_SHAPES, NODE_SIZES } from '../notation';
import { PATTERN_INFO } from '../patterns';
import { findView, type IntegrationView } from '../views';
import { zonesOf, type Zone } from '../zones';

export { KIND_COLORS, NODE_SHAPES };

const EXTERNAL_COLOR = '#6b6b6b';
const STEP_COLOR = '#1e293b';
const MARK_WIDTH = 22;

/** Texto de una interacción sin adornos: descripción y protocolo. */
export function interactionText(it: Interaction): string {
  return [it.description, it.protocol ? `[${it.protocol}]` : undefined].filter(Boolean).join(' ');
}

/** Etiqueta para los formatos de texto (Mermaid, draw.io): número de paso, descripción, protocolo y patrón entre «». */
export function interactionLabel(it: Interaction, step?: number): string {
  return [step !== undefined ? `${step}.` : undefined, interactionText(it), it.pattern ? `«${PATTERN_INFO[it.pattern].label}»` : undefined].filter(Boolean).join(' ');
}

export function colorOf(node: IntegrationNode): string {
  return node.external ? EXTERNAL_COLOR : KIND_COLORS[node.kind];
}

/** `<formato> <versión>` del contrato que describe al nodo. */
export function contractLine(doc: IntegrationDocument, node: IntegrationNode): string | undefined {
  const contract = node.contractId ? doc.contracts.find((c) => c.id === node.contractId) : undefined;
  return contract ? `${contract.format}${contract.version ? ` ${contract.version}` : ''}` : undefined;
}

/** Cuántas líneas caben en las figuras de texto estrecho (el reloj y la figura humana); en el resto caben tres. */
const MAX_LINES: Partial<Record<IntegrationNode['kind'], number>> = { scheduler: 2, user: 2 };

/** Líneas de texto de un nodo, de la más a la menos importante: nombre, tecnología, contrato y responsable. */
export function nodeLines(doc: IntegrationDocument, node: IntegrationNode): string[] {
  if (node.kind === 'pattern') return [...new Set([node.name, node.pattern ? PATTERN_INFO[node.pattern].label : ''].filter(Boolean))];
  return [node.name, node.technology, contractLine(doc, node), node.owner ? `Responsable: ${node.owner}` : undefined].filter((line): line is string => !!line).slice(0, MAX_LINES[node.kind] ?? 3);
}

/** Insignias de una línea: el número de paso y, si lo tiene, el icono de su patrón. */
export function interactionMarks(it: Interaction, step?: number): EdgeMark[] {
  const marks: EdgeMark[] = [];
  if (step !== undefined) marks.push({ text: String(step), color: STEP_COLOR, title: `Paso ${step}` });
  if (it.pattern) marks.push({ icon: PATTERN_INFO[it.pattern].icon, color: KIND_COLORS.pattern, title: PATTERN_INFO[it.pattern].label });
  return marks;
}

export interface RenderedView {
  view: IntegrationView;
  layout: GraphLayout;
  nodes: Map<string, IntegrationNode>;
  interactions: Map<string, Interaction>;
  /** Etiqueta de texto completa de cada interacción (con paso y patrón), para los formatos sin insignias. */
  labels: Map<string, string>;
  /** Número de paso de las interacciones numeradas. */
  steps: Map<string, number>;
  /** Zonas de dominio de la vista; en `layout.groups` van con su `id`, por encima de los contenedores. */
  zones: Zone[];
  /** Grupo que contiene a cada nodo o grupo: su contenedor por `parentId` o, si no lo tiene, su zona. */
  parents: Map<string, string>;
}

/**
 * Coloca una vista con el autolayout genérico del kernel. Los nodos con hijos en la vista se dibujan como agrupaciones y
 * los de un mismo dominio quedan dentro de su zona (zona ⊃ contenedor ⊃ hijo).
 */
export async function layoutView(doc: IntegrationDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const visible = new Set(view.nodeIds);
  const nodes = new Map(doc.nodes.filter((n) => visible.has(n.id)).map((n) => [n.id, n]));
  const zones = zonesOf(doc.nodes, visible);
  const zoneOf = new Map(zones.flatMap((z) => z.nodeIds.map((id) => [id, z.id] as const)));
  const containerIds = new Set([...nodes.values()].filter((n) => n.parentId && nodes.has(n.parentId)).map((n) => n.parentId as string));
  const groupOf = (id: string): string | undefined => {
    const parent = nodes.get(id)?.parentId;
    return parent && nodes.has(parent) ? parent : zoneOf.get(id);
  };
  const parents = new Map<string, string>();
  for (const id of [...nodes.keys(), ...zones.map((z) => z.id)]) {
    const group = groupOf(id);
    if (group) parents.set(id, group);
  }

  const interactions = new Map(view.interactions.map(({ interaction }) => [interaction.id, interaction]));
  const steps = new Map(view.interactions.flatMap(({ interaction, step }) => (step === undefined ? [] : [[interaction.id, step] as const])));
  const labels = new Map(view.interactions.map(({ interaction, step }) => [interaction.id, interactionLabel(interaction, step)]));

  const graphNodes = [...nodes.values()].filter((n) => !containerIds.has(n.id)).map((n) => ({ id: n.id, ...NODE_SIZES[n.kind], groupId: parents.get(n.id) }));
  const groups = [...zones.map((z) => ({ id: z.id })), ...[...containerIds].map((id) => ({ id, groupId: parents.get(id) }))];
  // ELK solo reserva el hueco del texto de la etiqueta: se le suma el de las insignias que van a su izquierda.
  const edges = view.interactions.map(({ interaction, step }) => {
    const reserved = ' '.repeat(Math.ceil((interactionMarks(interaction, step).length * MARK_WIDTH) / 6.6));
    return { id: interaction.id, source: interaction.sourceId, target: interaction.targetId, label: `${reserved}${interactionText(interaction)}` || undefined };
  });

  const layout = await layoutGraph(graphNodes, edges, groups, { direction: 'RIGHT', ...options });
  return { view, layout, nodes, interactions, labels, steps, zones, parents };
}

export async function toSvg(doc: IntegrationDocument, viewId?: string): Promise<string> {
  const { view, layout, nodes, interactions, steps, zones } = await layoutView(doc, viewId);
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => {
      const n = nodes.get(id)!;
      const fill = colorOf(n);
      return {
        fill,
        stroke: '#0f172a55',
        badge: n.kind === 'pattern' ? undefined : KIND_LABELS[n.kind],
        lines: nodeLines(doc, n),
        shape: NODE_SHAPES[n.kind],
        dashed: n.external,
        textColor: readableTextColor(fill),
      };
    },
    edge: (id) => {
      const it = interactions.get(id)!;
      return {
        stroke: '#475569',
        dashed: it.style !== 'request-response',
        width: it.style === 'event' || it.style === 'stream' ? 2.5 : it.criticality === 'high' ? 2.25 : 1.5,
        label: interactionText(it),
        marks: interactionMarks(it, steps.get(id)),
      };
    },
    group: (id) => {
      const zone = zoneById.get(id);
      if (zone) return { label: `Dominio: ${zone.name}`, fill: zone.fill, stroke: zone.stroke };
      return { label: `${KIND_LABELS[nodes.get(id)!.kind]}: ${nodes.get(id)!.name}` };
    },
  });
}
