import type { PlatformDocument, ResourceStatus } from '../types';
import { findView } from '../views';
import { matrixIsDrawn } from './matrix';
import { DIFF_COLORS, EXTERNAL_COLOR, RESOURCE_COLORS, SERVICE_COLORS, buildScene, type RenderedEdge, type SceneNode } from './render';

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

/** `calls` es continua, `messages` punteada y `data` gruesa; «corre en» va punteada y el flujo de un pipeline, continua. */
const ARROWS: Record<RenderedEdge['kind'], string> = { calls: '-->', messages: '-.->', data: '==>', 'runs-on': '-.->', flow: '-->' };
const CLASS_COLORS: Record<string, string> = { ...SERVICE_COLORS, ...RESOURCE_COLORS, external: EXTERNAL_COLOR, step: '#475569' };
const STATUS_DEFS: Record<Exclude<ResourceStatus, 'provisioned'>, string> = { planned: 'stroke-dasharray:5 5', decommissioned: 'stroke:#c92a2a,stroke-dasharray:5 5' };

/** Forma de cada tipo de recurso: los que guardan datos son cilindros `[( )]` y las colas, estadios `([ ])`. */
function flowNode(n: SceneNode, alias: string): string {
  const [title, ...rest] = n.lines;
  // Del estado (previsto, dado de baja) se ocupa la clase; no va en el texto.
  // En una comparación, la insignia de la diferencia va en el texto (Mermaid no tiene otra forma de mostrarla).
  const text = `"${esc([title, ...(n.status ? rest.filter((l) => l !== 'previsto' && l !== 'dado de baja') : rest), ...(n.diff && n.badge ? [n.badge] : [])].join('<br/>'))}"`;
  const shape = n.shape === 'cylinder' ? `[(${text})]` : n.cls === 'queue' ? `([${text}])` : `[${text}]`;
  return `${alias}${shape}:::${n.cls}`;
}

/**
 * Exporta una vista a Mermaid como `flowchart`. La topología y las vistas de impacto son un grafo plano; la de un entorno
 * anida `Entorno` › `Red` › `Clúster` en `subgraph` (con las instancias de los servicios dentro de su anfitrión); la de
 * entrega continua, un `subgraph` por pipeline. Las dependencias usan `-->` (llama), `-.->` (mensajes) y `==>` (datos), y
 * el tipo de cada nodo va en su clase.
 */
export function toMermaid(doc: PlatformDocument, options: { viewId?: string } = {}): string {
  const view = findView(doc, options.viewId);
  const scene = buildScene(doc, view);
  const inEnvironment = view.type === 'environment';
  // Las instancias se llaman como su servicio; los grupos, como el recurso o la red que representan; el resto, como su id.
  const aliases = aliasMap([
    ...(inEnvironment ? ([['#environment', `env_${view.environmentId}`]] as Array<[string, string]>) : []),
    ...[...scene.groups].map(([id, g]) => [id, g.elementId] as [string, string]),
    ...[...scene.nodes].map(([id, n]) => [id, n.elementId ?? id] as [string, string]),
  ]);
  const alias = (id: string): string => aliases.get(id)!;
  const out: string[] = ['flowchart LR'];
  const pad = (depth: number): string => '    '.repeat(depth + 1);
  /** Los servicios externos de un entorno se dibujan fuera de él. */
  const outside = (n: SceneNode): boolean => inEnvironment && n.cls === 'external';

  const emit = (parent: string | undefined, depth: number): void => {
    for (const [id, g] of [...scene.groups].filter(([, x]) => x.groupId === parent)) {
      out.push(`${pad(depth)}subgraph ${alias(id)}["${esc(g.label)}"]`);
      emit(id, depth + 1);
      out.push(`${pad(depth)}end`);
    }
    for (const [id, n] of [...scene.nodes].filter(([, x]) => x.groupId === parent && !outside(x))) out.push(`${pad(depth)}${flowNode(n, alias(id))}`);
  };
  if (inEnvironment) {
    const environment = doc.environments.find((e) => e.id === view.environmentId)!;
    out.push(`    subgraph ${alias('#environment')}["Entorno: ${esc(environment.name)}"]`);
    emit(undefined, 1);
    out.push('    end');
    for (const [id, n] of [...scene.nodes].filter(([, x]) => outside(x))) out.push(`    ${flowNode(n, alias(id))}`);
  } else emit(undefined, 0);

  for (const e of scene.edges.values()) out.push(`    ${alias(e.source)} ${ARROWS[e.kind]}${e.label ? `|"${esc(e.label)}"|` : ''} ${alias(e.target)}`);

  for (const cls of new Set([...scene.nodes.values()].map((n) => n.cls))) {
    const color = CLASS_COLORS[cls] ?? '#475569';
    out.push(`    classDef ${cls} fill:${color},stroke:${color},color:#ffffff`);
  }
  for (const status of ['planned', 'decommissioned'] as const) {
    const ids = [...scene.nodes].filter(([, n]) => n.status === status).map(([id]) => alias(id));
    if (ids.length > 0) out.push(`    classDef ${status} ${STATUS_DEFS[status]}`, `    class ${ids.join(',')} ${status}`);
  }
  // Comparación de entornos: las diferencias se colorean con una clase por clase de diferencia.
  for (const [mark, color] of Object.entries(DIFF_COLORS)) {
    const ids = [...scene.nodes].filter(([, n]) => n.diff === mark).map(([id]) => alias(id));
    if (ids.length > 0) out.push(`    classDef diff_${mark.replace('-', '_')} fill:${color},stroke:#0f172a,color:#ffffff`, `    class ${ids.join(',')} diff_${mark.replace('-', '_')}`);
  }
  // Matriz de varios entornos: la referencia y lo que es igual a ella van en gris, como en el lienzo, y no en el color de su tipo.
  if (matrixIsDrawn(view)) {
    for (const fill of new Set([...scene.nodes.values()].filter((n) => n.diff === 'same' && n.fill).map((n) => n.fill))) {
      const ids = [...scene.nodes].filter(([, n]) => n.diff === 'same' && n.fill === fill).map(([id]) => alias(id));
      out.push(`    classDef matrix_${fill.slice(1)} fill:${fill},stroke:${fill},color:#ffffff`, `    class ${ids.join(',')} matrix_${fill.slice(1)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
