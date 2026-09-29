import { deriveView, type DerivedNode } from '../../model/viewDerivation';
import type { C4Document, C4Element } from '../../model/types';

export type MermaidFormat = 'c4' | 'flowchart';

export interface MermaidOptions {
  /** Vista a exportar (Mermaid no tiene páginas: un diagrama por vista). Por defecto la primera. */
  viewId?: string;
  /** `c4`: diagrama C4 nativo de Mermaid (por defecto); `flowchart`: diagrama de flujo con subgraph por boundary. */
  format?: MermaidFormat;
}

export class MermaidExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MermaidExportError';
  }
}

const C4_HEADER = { systemContext: 'C4Context', container: 'C4Container', component: 'C4Component' } as const;

/** Convierte una vista del documento a texto de Mermaid (pegable en Markdown, GitHub, Confluence, mermaid.live…). */
export function toMermaid(doc: C4Document, options: MermaidOptions = {}): string {
  const viewId = options.viewId ?? doc.views[0]?.id;
  if (!viewId || !doc.views.some((v) => v.id === viewId)) {
    throw new MermaidExportError(options.viewId ? `No existe la vista «${options.viewId}».` : 'El documento no tiene vistas que exportar.');
  }
  const derived = deriveView(doc, viewId);
  const aliases = aliasMap([...derived.nodes.map((n) => n.element), ...derived.boundaries.map((b) => b.element)]);
  const nodesById = new Map(derived.nodes.map((n) => [n.id, n]));
  const boundariesById = new Map(derived.boundaries.map((b) => [b.id, b]));
  const roots = [...derived.boundaries.filter((b) => !b.boundaryId).map((b) => b.id), ...derived.nodes.filter((n) => !n.boundaryId).map((n) => n.id)];

  const seen = new Set<string>();
  const edges = derived.edges.filter((e) => {
    const key = `${e.sourceId}\u0000${e.targetId}\u0000${e.relationship.description ?? ''}\u0000${e.relationship.technology ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const title = derived.view.title ?? doc.workspace.name;
  const out: string[] = [];
  const format = options.format ?? 'c4';

  if (format === 'c4') {
    out.push(C4_HEADER[derived.view.type], `    title ${title}`);
    const emit = (id: string, depth: number): void => {
      const pad = '    '.repeat(depth + 1);
      const boundary = boundariesById.get(id);
      if (boundary) {
        out.push(`${pad}${c4Boundary(boundary.element, aliases)} {`);
        boundary.children.forEach((c) => emit(c, depth + 1));
        out.push(`${pad}}`);
      } else {
        const node = nodesById.get(id);
        if (node) out.push(`${pad}${c4Element(node.element, aliases)}`);
      }
    };
    roots.forEach((r) => emit(r, 0));
    for (const e of edges) {
      const args = [aliases.get(e.sourceId), aliases.get(e.targetId), q(e.relationship.description ?? ''), ...(e.relationship.technology ? [q(e.relationship.technology)] : [])];
      out.push(`    Rel(${args.join(', ')})`);
    }
  } else {
    out.push(`---`, `title: ${title}`, `---`, 'flowchart TB');
    const emit = (id: string, depth: number): void => {
      const pad = '    '.repeat(depth + 1);
      const boundary = boundariesById.get(id);
      if (boundary) {
        out.push(`${pad}subgraph ${aliases.get(id)}["${esc(boundary.element.name)}"]`);
        boundary.children.forEach((c) => emit(c, depth + 1));
        out.push(`${pad}end`);
      } else {
        const node = nodesById.get(id);
        if (node) out.push(`${pad}${flowNode(node, aliases)}`);
      }
    };
    roots.forEach((r) => emit(r, 0));
    for (const e of edges) {
      const label = [e.relationship.description, e.relationship.technology ? `[${e.relationship.technology}]` : undefined].filter(Boolean).join(' ');
      out.push(`    ${aliases.get(e.sourceId)} -->${label ? `|"${esc(label)}"|` : ''} ${aliases.get(e.targetId)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** Alias de Mermaid: solo letras, dígitos y guion bajo, únicos. */
function aliasMap(elements: C4Element[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const el of elements) {
    const base = el.id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'e';
    let alias = base;
    for (let i = 2; used.has(alias) || RESERVED.has(alias.toLowerCase()); i += 1) alias = `${base}_${i}`;
    used.add(alias);
    map.set(el.id, alias);
  }
  return map;
}

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

/** Texto entre comillas dobles: Mermaid no escapa las comillas, se sustituyen por comillas simples. */
function q(s: string): string {
  return `"${esc(s)}"`;
}

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/\r?\n/g, ' ');
}

function c4Element(el: C4Element, aliases: Map<string, string>): string {
  const alias = aliases.get(el.id);
  const ext = el.external ? '_Ext' : '';
  const variant = el.shape === 'database' ? 'Db' : el.shape === 'queue' ? 'Queue' : '';
  if (el.type === 'person') return `Person${ext}(${alias}, ${q(el.name)}${el.description ? `, ${q(el.description)}` : ''})`;
  if (el.type === 'softwareSystem') return `System${variant}${ext}(${alias}, ${q(el.name)}${el.description ? `, ${q(el.description)}` : ''})`;
  const kind = el.type === 'container' ? 'Container' : 'Component';
  const args = [alias, q(el.name), q(el.technology ?? ''), ...(el.description ? [q(el.description)] : [])];
  return `${kind}${variant}${ext}(${args.join(', ')})`;
}

function c4Boundary(el: C4Element, aliases: Map<string, string>): string {
  const fn = el.type === 'softwareSystem' ? 'System_Boundary' : el.type === 'container' ? 'Container_Boundary' : 'Boundary';
  return `${fn}(${aliases.get(el.id)}, ${q(el.name)})`;
}

function flowNode(node: DerivedNode, aliases: Map<string, string>): string {
  const el = node.element;
  const text = [el.name, el.technology ? `[${el.technology}]` : undefined].filter(Boolean).join('<br/>');
  const label = `"${esc(text)}"`;
  const alias = aliases.get(el.id);
  if (el.shape === 'database') return `${alias}[(${label})]`;
  if (el.shape === 'queue') return `${alias}([${label}])`;
  if (el.type === 'person') return `${alias}(${label})`;
  return `${alias}[${label}]`;
}

