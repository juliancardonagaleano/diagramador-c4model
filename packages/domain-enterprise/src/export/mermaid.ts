import { capabilityChildren, streamStages } from '../graph';
import { drawnEnds, indexElements, type Application, type BusinessService, type Capability, type Element, type ElementKind, type EnterpriseDocument, type Technology, type ValueStage } from '../types';
import { findView, roadmapColumns } from '../views';
import { INK, KIND_COLORS, KIND_STROKES } from './render';

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
  if (e.kind === 'stage') return (e.item as ValueStage).value;
  if (e.kind === 'service') return (e.item as BusinessService).audience;
  return undefined;
}

/** Forma de cada tipo: capacidad `( )`, proceso `([ ])`, etapa `{{ }}`, servicio `[[ ]]`, aplicación `[ ]` y tecnología `[( )]`. La clase (`:::tipo`) es la que manda al importar. */
function flowNode(e: Element, alias: string): string {
  const text = `"${esc([e.name, detail(e)].filter(Boolean).join('<br/>'))}"`;
  const shape =
    e.kind === 'capability' ? `(${text})` : e.kind === 'process' ? `([${text}])` : e.kind === 'technology' ? `[(${text})]` : e.kind === 'stage' ? `{{${text}}}` : e.kind === 'service' ? `[[${text}]]` : `[${text}]`;
  return `${alias}${shape}:::${e.kind}`;
}

function classDefs(kinds: Set<ElementKind>): string[] {
  return [...kinds].map((k) => `    classDef ${k} fill:${KIND_COLORS[k]},stroke:${KIND_STROKES[k]},color:${INK}`);
}

/**
 * Exporta una vista a Mermaid como `flowchart`. El mapa de capacidades anida cada capacidad con hijas en un `subgraph`; el
 * resto de vistas dibujan cada relación de quien se apoya a aquello en lo que se apoya (capacidad → aplicación →
 * tecnología), con línea discontinua para «depende de». El tipo de cada nodo va en su clase.
 */
export function toMermaid(doc: EnterpriseDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  const elements = indexElements(doc);
  // Las unidades y sus asignaciones no tienen forma en Mermaid (el importador no las lee): se omiten.
  const elementIds = view.elementIds.filter((id) => elements.get(id)?.kind !== 'unit');
  const aliases = aliasMap(elementIds);
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

  if (view.type === 'value-stream') {
    // Cada flujo es un subgraph con sus etapas unidas en orden (`==>`); las capacidades que las habilitan cuelgan de ellas.
    out.push('flowchart LR');
    const kinds = new Set<ElementKind>(['capability']);
    const stages = streamStages(doc);
    for (const stream of doc.valueStreams) {
      const list = stages.get(stream.id) ?? [];
      out.push(`    subgraph ${aliases.get(stream.id)}["${esc(stream.name)}"]`);
      for (const stage of list) {
        kinds.add('stage');
        out.push(`        ${flowNode(elements.get(stage.id)!, aliases.get(stage.id)!)}`);
      }
      list.slice(1).forEach((stage, i) => out.push(`        ${aliases.get(list[i].id)} ==> ${aliases.get(stage.id)}`));
      out.push('    end');
    }
    for (const id of elementIds) if (elements.get(id)!.kind === 'capability') out.push(`    ${flowNode(elements.get(id)!, aliases.get(id)!)}`);
    for (const r of doc.relations.filter((x) => view.relationIds.includes(x.id) && aliases.has(x.sourceId) && aliases.has(x.targetId))) {
      const { from, to } = drawnEnds(r);
      out.push(`    ${aliases.get(from)} -.-> ${aliases.get(to)}`);
    }
    out.push(...classDefs(kinds));
    return `${out.join('\n')}\n`;
  }

  if (view.type === 'roadmap') {
    out.push('flowchart LR');
    const kinds = new Set<ElementKind>();
    for (const column of roadmapColumns(doc)) {
      out.push(`    subgraph ${column.id.replace(/[^A-Za-z0-9_]/g, '_')}["${esc(column.title)}"]`);
      for (const id of column.elementIds) {
        kinds.add(elements.get(id)!.kind);
        out.push(`        ${flowNode(elements.get(id)!, aliases.get(id)!)}`);
      }
      out.push('    end');
    }
    out.push(...classDefs(kinds));
    return `${out.join('\n')}\n`;
  }

  out.push('flowchart LR');
  const kinds = new Set<ElementKind>();
  for (const id of elementIds) {
    const e = elements.get(id)!;
    kinds.add(e.kind);
    out.push(`    ${flowNode(e, aliases.get(id)!)}`);
  }
  for (const r of doc.relations.filter((x) => view.relationIds.includes(x.id) && aliases.has(x.sourceId) && aliases.has(x.targetId))) {
    const { from, to } = drawnEnds(r);
    const arrow = r.kind === 'depends-on' || r.kind === 'flows-to' ? '-.->' : r.kind === 'triggers' ? '==>' : r.kind === 'composes' ? '---' : '-->';
    out.push(`    ${aliases.get(from)} ${arrow}${r.description ? `|"${esc(r.description)}"|` : ''} ${aliases.get(to)}`);
  }
  out.push(...classDefs(kinds));
  const context = view.contextIds.filter((id) => aliases.has(id));
  if (context.length > 0) out.push('    classDef context stroke-dasharray:5 5', `    class ${context.map((id) => aliases.get(id)).join(',')} context`);
  return `${out.join('\n')}\n`;
}
