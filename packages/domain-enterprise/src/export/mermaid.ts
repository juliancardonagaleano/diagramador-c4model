import { capabilityChildren } from '../graph';
import { drawnEnds, indexElements, type Application, type Capability, type Element, type ElementKind, type EnterpriseDocument, type Technology } from '../types';
import { findView } from '../views';
import { KIND_COLORS } from './render';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

function aliasMap(ids: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const id of ids) {
    const base = id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'n';
    let alias = base;
    for (let i = 2; used.has(alias) || RESERVED.has(alias.toLowerCase()); i += 1) alias = `${base}_${i}`;
    used.add(alias);
    map.set(id, alias);
  }
  return map;
}

const esc = (s: string): string => s.replace(/"/g, "'").replace(/\r?\n/g, ' ');

/** Segunda línea del nodo: la pila de una aplicación o la versión de una tecnología. */
function detail(e: Element): string | undefined {
  if (e.kind === 'application') return (e.item as Application).technology;
  if (e.kind === 'technology') return (e.item as Technology).version;
  return undefined;
}

/** Forma de cada tipo: capacidad `( )`, proceso `([ ])`, aplicación `[ ]` y tecnología `[( )]`. La clase (`:::tipo`) es la que manda al importar. */
function flowNode(e: Element, alias: string): string {
  const text = `"${esc([e.name, detail(e)].filter(Boolean).join('<br/>'))}"`;
  const shape = e.kind === 'capability' ? `(${text})` : e.kind === 'process' ? `([${text}])` : e.kind === 'technology' ? `[(${text})]` : `[${text}]`;
  return `${alias}${shape}:::${e.kind}`;
}

function classDefs(kinds: Set<ElementKind>): string[] {
  return [...kinds].map((k) => `    classDef ${k} fill:${KIND_COLORS[k]},stroke:${KIND_COLORS[k]},color:#ffffff`);
}

/**
 * Exporta una vista a Mermaid como `flowchart`. El mapa de capacidades anida cada capacidad con hijas en un `subgraph`; el
 * resto de vistas dibujan cada relación de quien se apoya a aquello en lo que se apoya (capacidad → aplicación →
 * tecnología), con línea discontinua para «depende de». El tipo de cada nodo va en su clase.
 */
export function toMermaid(doc: EnterpriseDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  const elements = indexElements(doc);
  const aliases = aliasMap(view.elementIds);
  const out: string[] = [];

  if (view.type === 'capabilities') {
    out.push('flowchart TB');
    const children = capabilityChildren(doc);
    const emit = (c: Capability, depth: number): void => {
      const pad = '    '.repeat(depth + 1);
      const kids = children.get(c.id);
      if (kids?.length) {
        out.push(`${pad}subgraph ${aliases.get(c.id)}["${esc(c.name)}"]`);
        kids.forEach((k) => emit(k, depth + 1));
        out.push(`${pad}end`);
      } else out.push(`${pad}${flowNode(elements.get(c.id)!, aliases.get(c.id)!)}`);
    };
    (children.get(undefined) ?? []).forEach((c) => emit(c, 0));
    out.push(...classDefs(new Set<ElementKind>(['capability'])));
    return `${out.join('\n')}\n`;
  }

  out.push('flowchart LR');
  const kinds = new Set<ElementKind>();
  for (const id of view.elementIds) {
    const e = elements.get(id)!;
    kinds.add(e.kind);
    out.push(`    ${flowNode(e, aliases.get(id)!)}`);
  }
  for (const r of doc.relations.filter((x) => view.relationIds.includes(x.id))) {
    const { from, to } = drawnEnds(r);
    const arrow = r.kind === 'depends-on' ? '-.->' : '-->';
    out.push(`    ${aliases.get(from)} ${arrow}${r.description ? `|"${esc(r.description)}"|` : ''} ${aliases.get(to)}`);
  }
  out.push(...classDefs(kinds));
  if (view.contextIds.length > 0) out.push('    classDef context stroke-dasharray:5 5', `    class ${view.contextIds.map((id) => aliases.get(id)).join(',')} context`);
  return `${out.join('\n')}\n`;
}
