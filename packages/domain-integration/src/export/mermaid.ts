import { KIND_LABELS, type IntegrationDocument, type IntegrationNode, type Interaction, type NodeKind } from '../types';
import { PATTERN_INFO } from '../patterns';
import { findView } from '../views';
import { zoneId, zonesOf } from '../zones';
import { interactionLabel } from './render';

export type IntegrationMermaidFormat = 'auto' | 'flowchart' | 'sequence';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

function aliasMap(nodes: IntegrationNode[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const n of nodes) {
    const base = n.id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'n';
    let alias = base;
    for (let i = 2; used.has(alias) || RESERVED.has(alias.toLowerCase()); i += 1) alias = `${base}_${i}`;
    used.add(alias);
    map.set(n.id, alias);
  }
  return map;
}

const esc = (s: string): string => s.replace(/"/g, "'").replace(/\r?\n/g, ' ');

/** Delimitadores de cada tipo, entre las formas de Mermaid que entiende `parseFlowchart`. */
const SHAPES: Record<NodeKind, [open: string, close: string]> = {
  system: ['[', ']'],
  api: ['{{', '}}'],
  gateway: ['>', ']'],
  broker: ['[[', ']]'],
  queue: ['([', '])'],
  topic: ['([', '])'],
  store: ['[(', ')]'],
  connector: ['(', ')'],
  scheduler: ['(((', ')))'],
  user: ['((', '))'],
  mcp: ['[/', '/]'],
  pattern: ['{', '}'],
};

/**
 * Tipo que `fromMermaid` deduce de la forma y del contenedor de un nodo, que es lo único que sobrevive al analizador: un
 * almacén, una cola o, dentro de un sistema, una API. Cualquier otro necesita la marca «Tipo» en su texto.
 */
function importedKind(n: IntegrationNode, parent: IntegrationNode | undefined): NodeKind {
  if (n.kind === 'store') return 'store';
  if (n.kind === 'queue' || n.kind === 'topic') return 'queue';
  return parent?.kind === 'system' ? 'api' : 'system';
}

function flowNode(n: IntegrationNode, alias: string, parent: IntegrationNode | undefined): string {
  const lines = n.kind === 'pattern' ? [n.name] : [n.name, n.technology];
  if (n.kind === 'pattern') lines.push(n.pattern ? `«${PATTERN_INFO[n.pattern].label}»` : `«${KIND_LABELS.pattern}»`);
  else if (importedKind(n, parent) !== n.kind) lines.push(`«${KIND_LABELS[n.kind]}»`);
  const [open, close] = SHAPES[n.kind];
  return `${alias}${open}"${esc(lines.filter(Boolean).join('<br/>'))}"${close}`;
}

/** Flecha de flowchart según el estilo: continua = síncrono, punteada = asíncrono o por lotes, gruesa = evento o flujo continuo. */
function flowArrow(it: Interaction): string {
  return it.style === 'request-response' ? '-->' : it.style === 'async-message' || it.style === 'batch' ? '-.->' : '==>';
}

function seqArrow(it: Interaction): string {
  return it.style === 'request-response' || it.style === 'batch' ? '->>' : '-)';
}

/**
 * Exporta una vista a Mermaid: el mapa como `flowchart` (con un `subgraph` por contenedor y por zona de dominio), un flujo
 * como `sequenceDiagram` (o el que se pida con `format`).
 */
export function toMermaid(doc: IntegrationDocument, options: { viewId?: string; format?: IntegrationMermaidFormat } = {}): string {
  const view = findView(doc, options.viewId);
  const nodes = doc.nodes.filter((n) => view.nodeIds.includes(n.id));
  const aliases = aliasMap(nodes);
  const format = options.format && options.format !== 'auto' ? options.format : view.type === 'flow' ? 'sequence' : 'flowchart';
  const out: string[] = [];

  if (format === 'sequence') {
    out.push('sequenceDiagram', `    title ${view.title}`);
    // Solo participan los extremos de las interacciones (los nodos padre se dibujan como notas de agrupación en flowchart).
    const used = new Set(view.interactions.flatMap(({ interaction }) => [interaction.sourceId, interaction.targetId]));
    for (const n of nodes.filter((x) => used.has(x.id))) out.push(`    ${n.kind === 'user' ? 'actor' : 'participant'} ${aliases.get(n.id)} as ${esc(n.name)}`);
    view.interactions.forEach(({ interaction: it, step }, index) => {
      out.push(`    ${aliases.get(it.sourceId)}${seqArrow(it)}${aliases.get(it.targetId)}: ${esc(interactionLabel(it, step ?? index + 1))}`);
    });
    return `${out.join('\n')}\n`;
  }

  out.push('flowchart LR');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byParent = new Map<string | undefined, IntegrationNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && byId.has(n.parentId) ? n.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
  }
  const emit = (n: IntegrationNode, depth: number): void => {
    const pad = '    '.repeat(depth + 1);
    const kids = byParent.get(n.id);
    if (kids?.length) {
      out.push(`${pad}subgraph ${aliases.get(n.id)}["${esc(`${KIND_LABELS[n.kind]}: ${n.name}`)}"]`);
      kids.forEach((k) => emit(k, depth + 1));
      out.push(`${pad}end`);
    } else out.push(`${pad}${flowNode(n, aliases.get(n.id)!, n.parentId ? byId.get(n.parentId) : undefined)}`);
  };

  const zones = zonesOf(doc.nodes, new Set(view.nodeIds));
  const taken = new Set(aliases.values());
  const zoned = new Set(zones.flatMap((z) => z.nodeIds));
  for (const zone of zones) {
    const base = zoneId(zone.name).replace(/[^A-Za-z0-9_]/g, '_');
    let alias = base;
    for (let i = 2; taken.has(alias); i += 1) alias = `${base}_${i}`;
    taken.add(alias);
    out.push(`    subgraph ${alias}["${esc(`Dominio: ${zone.name}`)}"]`);
    zone.nodeIds.forEach((id) => emit(byId.get(id)!, 1));
    out.push('    end');
  }
  (byParent.get(undefined) ?? []).filter((n) => !zoned.has(n.id)).forEach((n) => emit(n, 0));

  for (const { interaction: it, step } of view.interactions) {
    const label = interactionLabel(it, step);
    out.push(`    ${aliases.get(it.sourceId)} ${flowArrow(it)}${label ? `|"${esc(label)}"|` : ''} ${aliases.get(it.targetId)}`);
  }
  return `${out.join('\n')}\n`;
}
