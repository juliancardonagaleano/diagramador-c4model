import type { SecurityDocument } from '../types';
import { findView } from '../views';
import { ASSET_COLORS, CONTROL_COLOR, FLOW_NODE_COLOR, buildScene, type RenderedEdge, type SceneNode } from './render';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'class', 'style', 'click', 'default']);

function aliasMap(bases: Array<[key: string, base: string]>): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const [key, id] of bases) {
    const base = id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'n';
    let alias = base;
    for (let i = 2; used.has(alias) || RESERVED.has(alias.toLowerCase()); i += 1) alias = `${base}_${i}`;
    used.add(alias);
    map.set(key, alias);
  }
  return map;
}

const esc = (s: string): string => s.replace(/"/g, "'").replace(/\r?\n/g, ' ');

/** Cifrado en tránsito: `==>` (cifrado), `-->` (no se sabe) y `-.->` (sin cifrar). Las amenazas van punteadas y los controles, continuos. */
const ARROWS: Record<RenderedEdge['arrow'], string> = { thick: '==>', solid: '-->', dotted: '-.->' };
const CLASS_COLORS: Record<string, string> = { ...ASSET_COLORS, control: CONTROL_COLOR, flow: FLOW_NODE_COLOR };

/** Forma de cada tipo de nodo: los almacenes son cilindros `[( )]`, los actores y los flujos, estadios `([ ])`, y los procesos, `( )`. */
function flowNode(n: SceneNode, alias: string): string {
  const text = `"${esc(n.lines.join('<br/>'))}"`;
  const shape = n.cls === 'datastore' ? `[(${text})]` : n.cls === 'actor' || n.cls === 'flow' ? `([${text}])` : n.cls === 'process' ? `(${text})` : `[${text}]`;
  return `${alias}${shape}:::${n.cls}`;
}

/**
 * Exporta una vista a Mermaid como `flowchart`. Los flujos de datos anidan cada zona de confianza en un `subgraph` con el
 * prefijo `Zona <nivel>: …`; el tipo de cada activo va en su clase (`actor`, `external`, `process`, `datastore`) y el texto
 * incluye su tecnología, la clasificación de sus datos y el cifrado en reposo. La flecha dice si el flujo va cifrado
 * (`==>`), sin cifrar (`-.->`) o no se sabe (`-->`), y su etiqueta lleva `protocolo · descripción · datos … · autenticación …`.
 * El modelo de amenazas dibuja amenazas (`-.->` al activo o flujo que amenazan) y controles (`-->|"mitiga"|` a la amenaza).
 */
export function toMermaid(doc: SecurityDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  const scene = buildScene(doc, view);
  const aliases = aliasMap([...[...scene.groups].map(([id, g]) => [id, g.elementId] as [string, string]), ...[...scene.nodes].map(([id, n]) => [id, n.elementId] as [string, string])]);
  const alias = (id: string): string => aliases.get(id)!;
  const out: string[] = ['flowchart LR'];
  const pad = (depth: number): string => '    '.repeat(depth + 1);

  const emit = (parent: string | undefined, depth: number): void => {
    for (const [id, g] of [...scene.groups].filter(([, x]) => x.groupId === parent)) {
      // Mermaid no admite subgrafos vacíos (celdas sin amenazas de la matriz de calor).
      if (![...scene.nodes.values()].some((n) => n.groupId === id) && ![...scene.groups.values()].some((x) => x.groupId === id)) continue;
      out.push(`${pad(depth)}subgraph ${alias(id)}["${esc(g.label)}"]`);
      emit(id, depth + 1);
      out.push(`${pad(depth)}end`);
    }
    for (const [id, n] of [...scene.nodes].filter(([, x]) => x.groupId === parent)) out.push(`${pad(depth)}${flowNode(n, alias(id))}`);
  };
  emit(undefined, 0);

  const edges = [...scene.edges.values()];
  for (const e of edges) {
    const text = [e.label, ...e.details].filter(Boolean).join(' · ');
    out.push(`    ${alias(e.source)} ${ARROWS[e.arrow]}${text ? `|"${esc(text)}"|` : ''} ${alias(e.target)}`);
  }
  edges.forEach((e, i) => void out.push(`    linkStyle ${i} stroke:${e.stroke},stroke-width:${e.width}px`));

  for (const cls of new Set([...scene.nodes.values()].map((n) => n.cls))) {
    if (cls === 'threat') continue;
    const color = CLASS_COLORS[cls] ?? '#475569';
    out.push(`    classDef ${cls} fill:${color},stroke:${color},color:#ffffff`);
  }
  // El color de una amenaza depende de su riesgo: va en cada nodo.
  const threats = [...scene.nodes].filter(([, n]) => n.cls === 'threat');
  if (threats.length > 0) out.push('    classDef threat color:#ffffff');
  for (const [id, n] of threats) out.push(`    style ${alias(id)} fill:${n.fill},stroke:${n.fill},color:#ffffff`);
  return `${out.join('\n')}\n`;
}
