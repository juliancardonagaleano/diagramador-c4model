import { LINK_LABELS, listLinks, type DataLink } from '../links';
import { erSymbols, multiplicities } from '../relations';
import { KIND_LABELS, TERM_STATUS_LABELS, type Cardinality, type DataAsset, type DataDocument, type GlossaryTerm, type Pipeline, type Relation } from '../types';
import { findView } from '../views';
import { KIND_COLORS, TERM_FILL, TERM_STROKE, impactColumnLines } from './render';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

function aliasMap(assets: Array<{ id: string }>): Map<string, string> {
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

/** Clase de Mermaid de los tipos del catálogo y de los términos: el importador la usa para reconocerlos. */
export const CATALOG_CLASSES = { 'data-product': 'dataProduct', glossary: 'glossary', 'data-api': 'dataApi', term: 'term' } as const;

/** Línea de un producto o una API con lo que declaran: frescura y SLA, protocolo y dirección. */
function catalogDetails(a: DataAsset): string[] {
  if (a.kind === 'data-product') return [a.freshness ? `frescura ${a.freshness}` : '', a.sla ? `SLA: ${a.sla}` : ''].filter(Boolean);
  if (a.kind === 'data-api') return [a.protocol ? a.protocol.toUpperCase() : '', a.endpoint ?? ''].filter(Boolean);
  return [];
}

function flowNode(a: DataAsset, alias: string, columns: string[] = []): string {
  const text = `"${esc([a.name, ...catalogDetails(a), a.technology, ...columns].filter(Boolean).join('<br/>'))}"`;
  if (a.kind === 'database' || a.kind === 'warehouse' || a.kind === 'lake') return `${alias}[(${text})]`;
  if (a.kind === 'stream') return `${alias}([${text}])`;
  if (a.kind === 'data-product' || a.kind === 'data-api' || a.kind === 'glossary') return `${alias}[${text}]:::${CATALOG_CLASSES[a.kind]}`;
  return `${alias}[${text}]`;
}

/** Texto de un término en Mermaid: nombre, definición y, si los tiene, `estado · responsable`. */
function termNode(t: GlossaryTerm, alias: string): string {
  const meta = t.status || t.owner ? [TERM_STATUS_LABELS[t.status ?? 'draft'], t.owner].filter(Boolean).join(' · ') : '';
  return `${alias}["${esc([t.name, t.definition, meta].filter(Boolean).join('<br/>'))}"]:::${CATALOG_CLASSES.term}`;
}

/** Flecha de un enlace del catálogo: continua en los puertos de un producto, punteada en la exposición de una API y en los términos. */
function linkLine(l: DataLink, aliases: Map<string, string>): string {
  const text = l.kind === 'defines' && l.column ? `${LINK_LABELS.defines} · ${l.column}` : LINK_LABELS[l.kind];
  return `    ${aliases.get(l.source)} ${l.kind === 'exposes' || l.kind === 'defines' ? '-.->' : '-->'}|"${esc(text)}"| ${aliases.get(l.target)}`;
}

/** Flecha según el tipo de pipeline: continua = por lotes, punteada = streaming, gruesa = captura de cambios (CDC). */
function flowArrow(p: Pipeline): string {
  return p.kind === 'streaming' ? '-.->' : p.kind === 'cdc' ? '==>' : '-->';
}

/** Cardinalidad → extremos de una relación de `erDiagram` (sin opcionalidad declarada; con ella, ver `erEnds`). */
export const ER_ENDS: Record<Cardinality, string> = { '1:1': '||--||', '1:N': '||--o{', 'N:1': '}o--||', 'N:M': '}o--o{' };

/** Extremos de una relación de `erDiagram`: la cardinalidad y, si la relación la declara, su opcionalidad (`|o`, `}|`…). */
export function erEnds(r: Relation): string {
  const { left, right } = erSymbols(r);
  return `${left}--${right}`;
}

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
    out.push(`    ${aliases.get(r.sourceId)} ${erEnds(r)} ${aliases.get(r.targetId)} : "${esc(r.description ?? '')}"`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * El modelo entidad-relación en notación UML como `classDiagram`: cada entidad es una clase con sus columnas y cada relación
 * lleva su multiplicidad (`1`, `0..1`, `1..*`, `0..*`) junto a cada extremo. Mermaid no la reimporta como datos.
 */
function toUmlClasses(doc: DataDocument, assetIds: string[], relationIds: string[], title: string): string {
  const assets = doc.assets.filter((a) => assetIds.includes(a.id));
  const aliases = aliasMap(assets);
  const out = ['---', `title: ${esc(title)}`, '---', 'classDiagram'];
  for (const a of assets) {
    const alias = aliases.get(a.id)!;
    const head = a.name === alias ? `class ${alias}` : `class ${alias}["${esc(a.name)}"]`;
    const columns = a.columns ?? [];
    if (columns.length === 0) {
      out.push(`    ${head}`);
      continue;
    }
    out.push(`    ${head} {`);
    for (const c of columns) {
      const type = (c.type ?? 'string').replace(/[\s,()<>{}]+/g, '_').replace(/_+$/, '');
      const name = c.name.replace(/[^\w-]+/g, '_');
      const keys = (c.keys ?? []).map((k) => k.toUpperCase()).join(', ');
      out.push(`        +${type} ${name}${keys ? ` ${keys}` : ''}`);
    }
    out.push('    }');
  }
  for (const r of doc.relations.filter((x) => relationIds.includes(x.id))) {
    const m = multiplicities(r);
    out.push(`    ${aliases.get(r.sourceId)} "${m.source}" -- "${m.target}" ${aliases.get(r.targetId)}${r.description ? ` : ${esc(r.description)}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Exporta una vista a Mermaid: el modelo entidad-relación como `erDiagram` (pata de gallo) o, en notación UML (`erd:uml`),
 * como `classDiagram` con multiplicidades; el resto (linaje, dominio, trazas) como `flowchart`, con un pipeline por cada
 * grupo de entradas y salidas.
 */
export function toMermaid(doc: DataDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  if (view.type === 'erd') return view.notation === 'uml' ? toUmlClasses(doc, view.assetIds, view.relationIds, view.title) : toEr(doc, view.assetIds, view.relationIds, view.title);

  const assets = doc.assets.filter((a) => view.assetIds.includes(a.id));
  const terms = (doc.terms ?? []).filter((t) => view.termIds.includes(t.id));
  const flat = view.type === 'products' || view.type === 'glossary';
  const aliases = aliasMap([...assets, ...terms]);
  const out: string[] = ['flowchart LR'];
  // Un glosario con términos en la vista es un `subgraph` que los contiene; los términos sin glosario van sueltos.
  const termsOf = (glossary: DataAsset): GlossaryTerm[] => terms.filter((t) => t.glossaryId === glossary.id);
  const byParent = new Map<string | undefined, DataAsset[]>();
  for (const a of assets) {
    const parent = !flat && a.parentId && assets.some((p) => p.id === a.parentId) ? a.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), a]);
  }
  const emit = (a: DataAsset, depth: number): void => {
    const pad = '    '.repeat(depth + 1);
    const kids = byParent.get(a.id);
    if (a.kind === 'glossary' && termsOf(a).length > 0) {
      out.push(`${pad}subgraph ${aliases.get(a.id)}["${esc(`${KIND_LABELS[a.kind]}: ${a.name}`)}"]`);
      termsOf(a).forEach((t) => out.push(`${pad}    ${termNode(t, aliases.get(t.id)!)}`));
      out.push(`${pad}end`);
    } else if (kids?.length) {
      out.push(`${pad}subgraph ${aliases.get(a.id)}["${esc(`${KIND_LABELS[a.kind]}: ${a.name}`)}"]`);
      kids.forEach((k) => emit(k, depth + 1));
      out.push(`${pad}end`);
    } else out.push(`${pad}${flowNode(a, aliases.get(a.id)!, view.column?.byAsset[a.id] ? impactColumnLines(view, a) : [])}`);
  };
  (byParent.get(undefined) ?? []).forEach((a) => emit(a, 0));
  for (const t of terms) if (!assets.some((a) => a.id === t.glossaryId && a.kind === 'glossary')) out.push(`    ${termNode(t, aliases.get(t.id)!)}`);
  for (const p of doc.pipelines.filter((x) => view.pipelineIds.includes(x.id))) {
    const from = p.inputs.map((id) => aliases.get(id)).join(' & ');
    const to = p.outputs.map((id) => aliases.get(id)).join(' & ');
    out.push(`    ${from} ${flowArrow(p)}|"${esc(`${p.name} [${p.kind}]`)}"| ${to}`);
  }
  for (const l of listLinks(doc).filter((x) => view.linkIds.includes(x.id))) out.push(linkLine(l, aliases));
  const used = new Set([...assets.map((a) => a.kind), ...(terms.length > 0 ? ['term' as const] : [])].filter((k): k is keyof typeof CATALOG_CLASSES => k in CATALOG_CLASSES));
  for (const kind of used) {
    const [fill, stroke, color] = kind === 'term' ? [TERM_FILL, TERM_STROKE, '#0f172a'] : [KIND_COLORS[kind], KIND_COLORS[kind], '#ffffff'];
    out.push(`    classDef ${CATALOG_CLASSES[kind]} fill:${fill},stroke:${stroke},color:${color}`);
  }
  if (view.contextIds.length > 0) {
    out.push('    classDef context stroke-dasharray:5 5', `    class ${view.contextIds.map((id) => aliases.get(id)).join(',')} context`);
  }
  return `${out.join('\n')}\n`;
}
