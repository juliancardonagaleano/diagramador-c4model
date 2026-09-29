import { layoutGraph, renderGraphSvg, type GraphEdgeInput, type GraphGroupInput, type GraphLayout, type GraphLayoutOptions, type GraphNodeInput, type SvgNodeStyle } from '@iark/kernel';
import { zoneChain } from '../graph';
import {
  ASSET_LABELS,
  AUTHENTICATION_LABELS,
  CONTROL_LABELS,
  DATA_LABELS,
  RATING_LABELS,
  STATUS_LABELS,
  STRIDE_LABELS,
  TRUST_LABELS,
  controlStatusOf,
  flowName,
  riskOf,
  sensitive,
  statusOf,
  trustOf,
  type Asset,
  type AssetKind,
  type Flow,
  type RiskRating,
  type SecurityDocument,
  type TrustLevel,
} from '../types';
import { findView, type SecurityView } from '../views';

export const ASSET_COLORS: Record<AssetKind, string> = { actor: '#5f3dc4', external: '#6b7280', process: '#1168bd', datastore: '#d9480f' };
export const RISK_COLORS: Record<RiskRating, string> = { low: '#2f9e44', medium: '#e67700', high: '#d9480f', critical: '#c92a2a' };
export const CONTROL_COLOR = '#2b8a3e';
export const FLOW_NODE_COLOR = '#475569';
/** Relleno y borde de cada zona según su nivel de confianza: del rojo (no confiable) al verde (restringida). */
export const ZONE_STYLES: Record<TrustLevel, { fill: string; stroke: string }> = {
  untrusted: { fill: '#fff5f5', stroke: '#fa5252' },
  dmz: { fill: '#fff9db', stroke: '#fab005' },
  internal: { fill: '#edf2ff', stroke: '#748ffc' },
  restricted: { fill: '#ebfbee', stroke: '#51cf66' },
};
const FOCUS_STROKE = '#f59f00';
const ALERT_STROKE = '#e03131';
const DEFAULT_STROKE = '#0f172a55';
const NODE_HEIGHT = 84;

/** Ancho que necesita un nodo para que su texto no se recorte, entre `min` y `max` px. */
function widthFor(lines: string[], min: number, max = 300): number {
  const [title = '', ...rest] = lines;
  const widest = Math.max(title.length * 7.2, ...rest.map((l) => l.length * 6.2));
  return Math.min(max, Math.max(min, Math.ceil(widest + 32)));
}

const join = (...parts: Array<string | undefined | false>): string => parts.filter(Boolean).join(' · ');

/** Texto de la flecha de un flujo: el protocolo y lo que hace. */
export const flowLabel = (f: Flow): string | undefined => join(f.protocol, f.description) || undefined;

/**
 * Datos extra de un flujo que solo llevan los formatos de texto (Mermaid) al final de la etiqueta: su clasificación y cómo
 * se autentica. En el SVG los transmiten el grosor y el color de la flecha.
 */
export function flowDetails(f: Flow): string[] {
  return [f.classification ? `datos ${DATA_LABELS[f.classification]}` : '', f.authentication ? (f.authentication === 'none' ? 'sin autenticación' : `autenticación ${AUTHENTICATION_LABELS[f.authentication]}`) : ''].filter(Boolean);
}

export const zoneLabel = (trust: TrustLevel, name: string): string => `Zona ${TRUST_LABELS[trust]}: ${name}`;

export interface RenderedEdge {
  /** Qué une la flecha: un flujo de datos, «amenaza a» (amenaza → activo o flujo) o «mitiga» (control → amenaza). */
  kind: 'flow' | 'threat' | 'mitigates';
  source: string;
  target: string;
  label?: string;
  /** Datos extra de la etiqueta que solo llevan los formatos de texto. */
  details: string[];
  stroke: string;
  dashed: boolean;
  width: number;
  /** Forma de la flecha en Mermaid: continua (no se sabe si va cifrado), gruesa (cifrado) o punteada (sin cifrar). */
  arrow: 'solid' | 'thick' | 'dotted';
}

/** Un nodo de la escena: su estilo, la zona que lo contiene y lo que hace falta para exportarlo a otros formatos. */
export interface SceneNode extends SvgNodeStyle {
  groupId?: string;
  /** Clase del nodo (`actor`, `process`, `threat`…): en Mermaid es la que manda al importar. */
  cls: string;
  /** Nota que solo se dibuja en el SVG (p. ej. las amenazas abiertas de un activo). */
  note?: string;
  /** Id del elemento del documento que representa. */
  elementId: string;
}

export interface SceneGroup {
  label: string;
  /** Título más corto, para cuando el grupo es demasiado estrecho para el completo. */
  short: string;
  groupId?: string;
  trust: TrustLevel;
  elementId: string;
}

/** Lo que se dibuja de una vista, antes de colocarlo. */
export interface Scene {
  nodes: Map<string, SceneNode>;
  groups: Map<string, SceneGroup>;
  edges: Map<string, RenderedEdge>;
}

/** Líneas de un activo tal como las importa Mermaid: nombre, tecnología, clasificación y, en los almacenes, el cifrado en reposo. */
export function assetLines(a: Asset): string[] {
  return [
    a.name,
    a.technology ?? '',
    a.classification ? `datos ${DATA_LABELS[a.classification]}` : '',
    a.kind === 'datastore' && a.encryptedAtRest !== undefined ? (a.encryptedAtRest ? 'cifrado en reposo' : 'sin cifrar en reposo') : '',
  ].filter(Boolean);
}

function assetNode(doc: SecurityDocument, a: Asset, focus?: string): SceneNode {
  const open = doc.threats.filter((t) => t.targetId === a.id && statusOf(t) === 'open');
  const serious = open.some((t) => ['high', 'critical'].includes(riskOf(t).rating));
  return {
    fill: ASSET_COLORS[a.kind],
    stroke: a.id === focus ? FOCUS_STROKE : serious ? ALERT_STROKE : DEFAULT_STROKE,
    badge: ASSET_LABELS[a.kind],
    lines: assetLines(a),
    shape: a.kind === 'datastore' ? 'cylinder' : a.kind === 'actor' ? 'pill' : 'rect',
    dashed: a.kind === 'external',
    cls: a.kind,
    elementId: a.id,
    ...(open.length > 0 ? { note: `${open.length} ${open.length === 1 ? 'amenaza abierta' : 'amenazas abiertas'}` } : {}),
  };
}

function flowEdge(f: Flow): RenderedEdge {
  const width = sensitive(f.classification) ? 2.5 : 1.5;
  const common = { kind: 'flow' as const, source: f.sourceId, target: f.targetId, label: flowLabel(f), details: flowDetails(f), width };
  if (f.encrypted === true) return { ...common, stroke: '#2b8a3e', dashed: false, arrow: 'thick' };
  if (f.encrypted === false) return { ...common, stroke: '#c92a2a', dashed: true, arrow: 'dotted' };
  return { ...common, stroke: '#64748b', dashed: false, arrow: 'solid' };
}

/** Flujos de datos con sus zonas de confianza (y, en las vistas de traza, resaltando el activo de partida). */
function flowScene(doc: SecurityDocument, view: SecurityView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const shown = doc.assets.filter((a) => view.assetIds.includes(a.id));
  // Se dibuja cada zona que contiene algo, con sus ancestros.
  for (const a of shown) {
    for (const z of zoneChain(doc, a.zoneId)) {
      if (scene.groups.has(z.id)) continue;
      scene.groups.set(z.id, { label: zoneLabel(trustOf(z), z.name), short: z.name, trust: trustOf(z), elementId: z.id, ...(z.parentId ? { groupId: z.parentId } : {}) });
    }
  }
  for (const a of shown) scene.nodes.set(a.id, { ...assetNode(doc, a, view.focusId), groupId: a.zoneId });
  for (const f of doc.flows.filter((x) => view.flowIds.includes(x.id))) scene.edges.set(f.id, flowEdge(f));
  return scene;
}

/** Modelo de amenazas: los controles mitigan amenazas y las amenazas recaen sobre activos o flujos. */
function threatScene(doc: SecurityDocument, view: SecurityView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  for (const a of doc.assets.filter((x) => view.assetIds.includes(x.id))) scene.nodes.set(a.id, { ...assetNode(doc, a), note: undefined });
  for (const f of doc.flows.filter((x) => view.flowIds.includes(x.id))) {
    scene.nodes.set(f.id, {
      fill: FLOW_NODE_COLOR,
      stroke: DEFAULT_STROKE,
      badge: 'Flujo de datos',
      lines: [flowName(doc, f), f.protocol ?? ''].filter(Boolean),
      shape: 'pill',
      cls: 'flow',
      elementId: f.id,
    });
  }
  for (const c of doc.controls.filter((x) => view.controlIds.includes(x.id))) {
    const planned = controlStatusOf(c) === 'planned';
    scene.nodes.set(c.id, {
      fill: CONTROL_COLOR,
      stroke: DEFAULT_STROKE,
      badge: CONTROL_LABELS[c.kind],
      lines: [c.name, planned ? 'prevista' : ''].filter(Boolean),
      dashed: planned,
      cls: 'control',
      elementId: c.id,
    });
  }
  for (const t of doc.threats.filter((x) => view.threatIds.includes(x.id))) {
    const risk = riskOf(t);
    const status = statusOf(t);
    scene.nodes.set(t.id, {
      fill: RISK_COLORS[risk.rating],
      stroke: DEFAULT_STROKE,
      badge: `Amenaza · ${STRIDE_LABELS[t.category]}`,
      lines: [t.title, `riesgo ${RATING_LABELS[risk.rating]} (${risk.score}) · ${STATUS_LABELS[status]}`],
      dashed: status !== 'open',
      cls: 'threat',
      elementId: t.id,
    });
    if (scene.nodes.has(t.targetId)) scene.edges.set(`t:${t.id}`, { kind: 'threat', source: t.id, target: t.targetId, details: [], stroke: '#c92a2a', dashed: true, width: 1.5, arrow: 'dotted' });
    for (const id of t.controlIds ?? []) {
      if (scene.nodes.has(id)) scene.edges.set(`m:${id}:${t.id}`, { kind: 'mitigates', source: id, target: t.id, label: 'mitiga', details: [], stroke: CONTROL_COLOR, dashed: false, width: 1.5, arrow: 'solid' });
    }
  }
  return scene;
}

/** Las amenazas y los controles tienen títulos largos: se les deja más ancho. */
const sizeOf = (style: SceneNode): { width: number; height: number } => ({
  width: widthFor([...svgStyle(style).lines, ...(style.badge ? [style.badge] : [])], style.shape === 'pill' ? 170 : 190, style.cls === 'threat' || style.cls === 'control' ? 400 : 300),
  height: NODE_HEIGHT,
});

/** Lo que hay que dibujar en una vista (nodos, zonas y flechas), sin coordenadas. */
export function buildScene(doc: SecurityDocument, view: SecurityView): Scene {
  return view.type === 'threats' ? threatScene(doc, view) : flowScene(doc, view);
}

export interface RenderedView {
  view: SecurityView;
  layout: GraphLayout;
  /** Estilo de cada nodo dibujado, por su id en el layout (con las notas ya añadidas al texto). */
  nodes: Map<string, SceneNode>;
  /** Título de cada zona. */
  groups: Map<string, string>;
  /** El mismo título, recortado si la zona es demasiado estrecha (para el SVG, que no ajusta el texto). */
  fittedGroups: Map<string, string>;
  scene: Scene;
  edges: Map<string, RenderedEdge>;
}

/** Estilo de un nodo para el SVG: el de la escena más su nota (por ejemplo, las amenazas abiertas). */
const svgStyle = (n: SceneNode): SvgNodeStyle => ({ ...n, lines: n.note ? [...n.lines, n.note] : n.lines, maxLines: 4 });

/** Coloca una vista con el autolayout genérico del kernel. */
export async function layoutView(doc: SecurityDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  const scene = buildScene(doc, view);
  const nodes: GraphNodeInput[] = [...scene.nodes].map(([id, style]) => ({ id, ...sizeOf(style), ...(style.groupId ? { groupId: style.groupId } : {}) }));
  const groups: GraphGroupInput[] = [...scene.groups].map(([id, g]) => ({ id, ...(g.groupId ? { groupId: g.groupId } : {}) }));
  const edges: GraphEdgeInput[] = [...scene.edges].map(([id, e]) => ({ id, source: e.source, target: e.target, label: e.label }));
  const layout = await layoutGraph(nodes, edges, groups, { direction: 'RIGHT', ...options });
  const widths = new Map(layout.groups.map((g) => [g.id, g.width]));
  const fitted = new Map([...scene.groups].map(([id, g]) => [id, g.label.length * 6.4 + 16 > (widths.get(id) ?? Infinity) ? g.short : g.label]));
  return { view, layout, nodes: scene.nodes, groups: new Map([...scene.groups].map(([id, g]) => [id, g.label])), fittedGroups: fitted, scene, edges: scene.edges };
}

export async function toSvg(doc: SecurityDocument, viewId?: string): Promise<string> {
  const { view, layout, nodes, scene, fittedGroups, edges } = await layoutView(doc, viewId);
  return renderGraphSvg(layout, {
    title: view.title,
    node: (id) => svgStyle(nodes.get(id)!),
    edge: (id) => {
      const e = edges.get(id)!;
      return { stroke: e.stroke, dashed: e.dashed, label: e.label, width: e.width };
    },
    group: (id) => ({ label: fittedGroups.get(id) ?? id, ...ZONE_STYLES[scene.groups.get(id)?.trust ?? 'internal'] }),
  });
}
