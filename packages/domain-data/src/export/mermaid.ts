import { KIND_LABELS, type Cardinality, type DataAsset, type DataDocument, type Pipeline } from '../types';
import { findView } from '../views';
import { impactColumnLines } from './render';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

function aliasMap(assets: DataAsset[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const a of assets) {
    const base = a.id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'n';
    let alias = base;
    for (let i = 2; used.has(alias) || RESERVED.has(alias.toLowerCase()); i += 1) alias = `${base}_${i}`;
    used.add(alias);
    map.set(a.id, alias);
  }
  return map;
}

const esc = (s: string): string => s.replace(/"/g, "'").replace(/\r?\n/g, ' ');

function flowNode(a: DataAsset, alias: string, columns: string[] = []): string {
  const text = `"${esc([a.name, a.technology, ...columns].filter(Boolean).join('<br/>'))}"`;
  if (a.kind === 'database' || a.kind === 'warehouse' || a.kind === 'lake') return `${alias}[(${text})]`;
  if (a.kind === 'stream') return `${alias}([${text}])`;
  return `${alias}[${text}]`;
}

/** Flecha según el tipo de pipeline: continua = por lotes, punteada = streaming, gruesa = captura de cambios (CDC). */
function flowArrow(p: Pipeline): string {
  return p.kind === 'streaming' ? '-.->' : p.kind === 'cdc' ? '==>' : '-->';
}

/** Cardinalidad → extremos de una relación de `erDiagram`. */
export const ER_ENDS: Record<Cardinality, string> = { '1:1': '||--||', '1:N': '||--o{', 'N:1': '}o--||', 'N:M': '}o--o{' };

const erName = (a: DataAsset, aliases: Map<string, string>): string => {
  const alias = aliases.get(a.id)!;
  return a.name === alias ? alias : `${alias}["${esc(a.name)}"]`;
};

function toEr(doc: DataDocument, assetIds: string[], relationIds: string[], title: string): string {
  const assets = doc.assets.filter((a) => assetIds.includes(a.id));
  const aliases = aliasMap(assets);
  const out = ['---', `title: ${esc(title)}`, '---', 'erDiagram'];
  for (const a of assets) {
    const columns = a.columns ?? [];
    out.push(columns.length > 0 ? `    ${erName(a, aliases)} {` : `    ${erName(a, aliases)}`);
    if (columns.length === 0) continue;
    for (const c of columns) {
      const type = (c.type ?? 'string').replace(/[\s,]+/g, '_');
      const name = c.name.replace(/[^\w-]+/g, '_');
      const keys = (c.keys ?? []).map((k) => k.toUpperCase()).join(', ');
      const comment = [c.description, c.pii ? 'PII' : ''].filter(Boolean).join(' · ');
      out.push(`        ${[type, name, keys, comment ? `"${esc(comment)}"` : ''].filter(Boolean).join(' ')}`);
    }
    out.push('    }');
  }
  for (const r of doc.relations.filter((x) => relationIds.includes(x.id))) {
    out.push(`    ${aliases.get(r.sourceId)} ${ER_ENDS[r.cardinality]} ${aliases.get(r.targetId)} : "${esc(r.description ?? '')}"`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Exporta una vista a Mermaid: el modelo entidad-relación como `erDiagram` y el resto (linaje, dominio, trazas) como
 * `flowchart`, con un pipeline por cada grupo de entradas y salidas.
 */
export function toMermaid(doc: DataDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  if (view.type === 'erd') return toEr(doc, view.assetIds, view.relationIds, view.title);

  const assets = doc.assets.filter((a) => view.assetIds.includes(a.id));
  const aliases = aliasMap(assets);
  const out: string[] = ['flowchart LR'];
  const byParent = new Map<string | undefined, DataAsset[]>();
  for (const a of assets) {
    const parent = a.parentId && assets.some((p) => p.id === a.parentId) ? a.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), a]);
  }
  const emit = (a: DataAsset, depth: number): void => {
    const pad = '    '.repeat(depth + 1);
    const kids = byParent.get(a.id);
    if (kids?.length) {
      out.push(`${pad}subgraph ${aliases.get(a.id)}["${esc(`${KIND_LABELS[a.kind]}: ${a.name}`)}"]`);
      kids.forEach((k) => emit(k, depth + 1));
      out.push(`${pad}end`);
    } else out.push(`${pad}${flowNode(a, aliases.get(a.id)!, view.column?.byAsset[a.id] ? impactColumnLines(view, a) : [])}`);
  };
  (byParent.get(undefined) ?? []).forEach((a) => emit(a, 0));
  for (const p of doc.pipelines.filter((x) => view.pipelineIds.includes(x.id))) {
    const from = p.inputs.map((id) => aliases.get(id)).join(' & ');
    const to = p.outputs.map((id) => aliases.get(id)).join(' & ');
    out.push(`    ${from} ${flowArrow(p)}|"${esc(`${p.name} [${p.kind}]`)}"| ${to}`);
  }
  if (view.contextIds.length > 0) {
    out.push('    classDef context stroke-dasharray:5 5', `    class ${view.contextIds.map((id) => aliases.get(id)).join(',')} context`);
  }
  return `${out.join('\n')}\n`;
}
