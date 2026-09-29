import { KIND_LABELS, type IntegrationDocument, type IntegrationNode, type Interaction } from '../types';
import { findView } from '../views';

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

function flowNode(n: IntegrationNode, alias: string): string {
  const text = `"${esc([n.name, n.technology].filter(Boolean).join('<br/>'))}"`;
  if (n.kind === 'store') return `${alias}[(${text})]`;
  if (n.kind === 'queue' || n.kind === 'topic') return `${alias}([${text}])`;
  return `${alias}[${text}]`;
}

/** Flecha de flowchart según el estilo: continua = síncrono, punteada = asíncrono o por lotes, gruesa = evento o flujo continuo. */
function flowArrow(it: Interaction): string {
  return it.style === 'request-response' ? '-->' : it.style === 'async-message' || it.style === 'batch' ? '-.->' : '==>';
}

function seqArrow(it: Interaction): string {
  return it.style === 'request-response' || it.style === 'batch' ? '->>' : '-)';
}

/** Exporta una vista a Mermaid: el mapa como `flowchart`, un flujo como `sequenceDiagram` (o el que se pida con `format`). */
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
    for (const n of nodes.filter((x) => used.has(x.id))) out.push(`    participant ${aliases.get(n.id)} as ${esc(n.name)}`);
    view.interactions.forEach(({ interaction: it, step }, index) => {
      const text = [step !== undefined ? `${step}.` : `${index + 1}.`, it.description, it.protocol ? `[${it.protocol}]` : undefined].filter(Boolean).join(' ');
      out.push(`    ${aliases.get(it.sourceId)}${seqArrow(it)}${aliases.get(it.targetId)}: ${esc(text)}`);
    });
    return `${out.join('\n')}\n`;
  }

  out.push('flowchart LR');
  const byParent = new Map<string | undefined, IntegrationNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && nodes.some((p) => p.id === n.parentId) ? n.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
  }
  const emit = (n: IntegrationNode, depth: number): void => {
    const pad = '    '.repeat(depth + 1);
    const kids = byParent.get(n.id);
    if (kids?.length) {
      out.push(`${pad}subgraph ${aliases.get(n.id)}["${esc(`${KIND_LABELS[n.kind]}: ${n.name}`)}"]`);
      kids.forEach((k) => emit(k, depth + 1));
      out.push(`${pad}end`);
    } else out.push(`${pad}${flowNode(n, aliases.get(n.id)!)}`);
  };
  (byParent.get(undefined) ?? []).forEach((n) => emit(n, 0));
  for (const { interaction: it, step } of view.interactions) {
    const label = [step !== undefined ? `${step}.` : '', it.description ?? '', it.protocol ? `[${it.protocol}]` : ''].filter(Boolean).join(' ');
    out.push(`    ${aliases.get(it.sourceId)} ${flowArrow(it)}${label ? `|"${esc(label)}"|` : ''} ${aliases.get(it.targetId)}`);
  }
  return `${out.join('\n')}\n`;
}
