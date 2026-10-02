import { layoutGraph, renderGraphSvg, type GraphEdgeInput, type GraphGroupInput, type GraphLayout, type GraphLayoutOptions, type GraphNodeInput, type ShapeKind, type SvgLegend, type SvgNodeStyle } from '@iark/kernel';
import {
  CRITICALITY_LABELS,
  EXPOSURE_LABELS,
  PIPELINE_LABELS,
  RESOURCE_LABELS,
  SERVICE_LABELS,
  STATUS_LABELS,
  exposureOf,
  isHost,
  serviceKindOf,
  statusOf,
  type Dependency,
  type DependencyKind,
  type EnvironmentKind,
  type Exposure,
  type Network,
  type Pipeline,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type ResourceStatus,
  type Service,
  type ServiceKind,
} from '../types';
import { compareEnvironments, MATCH_NOTES, versionText, type DiffKind, type Presence } from '../compare';
import { costsByEnvironment, formatCost } from '../costs';
import { findView, type PlatformView } from '../views';
import { drawMatrix, matrixIsDrawn } from './matrix';

export const SERVICE_COLORS: Record<ServiceKind, string> = { service: '#1168bd', worker: '#3b5bdb', job: '#7048e8', frontend: '#0b7285' };
export const EXTERNAL_COLOR = '#6b7280';
export const RESOURCE_COLORS: Record<ResourceKind, string> = {
  cluster: '#2b8a3e',
  vm: '#2b8a3e',
  database: '#d9480f',
  cache: '#e67700',
  queue: '#c2255c',
  storage: '#a61e4d',
  'load-balancer': '#0c8599',
  gateway: '#0c8599',
  dns: '#495057',
  'secret-store': '#862e9c',
  registry: '#495057',
  region: '#0b7285',
  namespace: '#5c7cfa',
  certificate: '#9c36b5',
  monitoring: '#2f9e44',
  other: '#495057',
};
/** Figuras de servicios y recursos (diagrama de despliegue): las mismas en el lienzo y en el SVG. */
export const SERVICE_SHAPES: Record<ServiceKind, ShapeKind> = { service: 'rect', worker: 'rounded', job: 'hexagon', frontend: 'card' };
export const RESOURCE_SHAPES: Record<ResourceKind, ShapeKind> = {
  cluster: 'cube',
  vm: 'monitor',
  database: 'cylinder',
  cache: 'cylinder',
  storage: 'cylinder',
  queue: 'pipe',
  'load-balancer': 'diamond',
  gateway: 'chevron',
  dns: 'circle',
  'secret-store': 'hexagon',
  registry: 'card',
  region: 'rounded',
  namespace: 'rect',
  certificate: 'card',
  monitoring: 'circle',
  other: 'rect',
};
/** Zonas de red según su exposición: pública, borde rojo continuo; privada, azul discontinuo; aislada, gris punteado. */
export interface GroupStyle {
  fill: string;
  stroke: string;
  border: 'solid' | 'dashed' | 'dotted';
}
export const EXPOSURE_ZONES: Record<Exposure, GroupStyle> = {
  public: { fill: '#fff5f5', stroke: '#e03131', border: 'solid' },
  private: { fill: '#f1f7fd', stroke: '#1c7ed6', border: 'dashed' },
  isolated: { fill: '#f1f3f5', stroke: '#495057', border: 'dotted' },
};
const STAGE_COLORS: Record<EnvironmentKind, string> = { dev: '#2f9e44', test: '#e67700', staging: '#7048e8', prod: '#c92a2a', dr: '#495057' };
const STEP_COLOR = '#475569';
const FOCUS_STROKE = '#f59f00';
const DEFAULT_STROKE = '#0f172a55';

export const DEPENDENCY_STYLES: Record<DependencyKind, { stroke: string; dashed: boolean; width: number }> = {
  calls: { stroke: '#475569', dashed: false, width: 1.5 },
  messages: { stroke: '#7048e8', dashed: true, width: 1.5 },
  data: { stroke: '#e8590c', dashed: false, width: 2.5 },
};
const RUNS_ON_STYLE = { stroke: '#94a3b8', dashed: true, width: 1.5 };

const NODE_HEIGHT = 76;

/** Ancho que necesita un nodo para que su texto no se recorte, entre `min` y 300 px. */
function widthFor(lines: string[], min: number): number {
  const [title = '', ...rest] = lines;
  const widest = Math.max(title.length * 7.2, ...rest.map((l) => l.length * 6.2));
  return Math.min(300, Math.max(min, Math.ceil(widest + 32)));
}

const join = (...parts: Array<string | undefined | false>): string => parts.filter(Boolean).join(' · ');
const replicasText = (n: number): string => `${n} ${n === 1 ? 'réplica' : 'réplicas'}`;

/** Texto de la flecha de una dependencia: el protocolo y lo que hace. */
export const dependencyLabel = (d: Dependency): string | undefined => join(d.protocol, d.description) || undefined;

export const networkLabel = (n: Network, withCidr = true): string => `Red ${EXPOSURE_LABELS[exposureOf(n)]}: ${n.name}${withCidr && n.cidr ? ` (${n.cidr})` : ''}`;
export const hostLabel = (r: Resource): string => `${RESOURCE_LABELS[r.kind]}: ${r.name}`;
export const pipelineLabel = (p: Pipeline): string => `${PIPELINE_LABELS[p.kind]}: ${p.name}${p.tool ? ` (${p.tool})` : ''}`;

export function serviceStyle(s: Service, extra: string[] = []): SvgNodeStyle {
  return {
    fill: s.external ? EXTERNAL_COLOR : SERVICE_COLORS[serviceKindOf(s)],
    stroke: DEFAULT_STROKE,
    badge: s.external ? 'Servicio externo' : SERVICE_LABELS[serviceKindOf(s)],
    lines: [s.name, s.technology ?? '', ...extra].filter(Boolean),
    shape: s.external ? 'rect' : SERVICE_SHAPES[serviceKindOf(s)],
    dashed: s.external === true,
  };
}

export function resourceStyle(r: Resource, extra: string[] = []): SvgNodeStyle {
  const status = statusOf(r);
  return {
    fill: RESOURCE_COLORS[r.kind],
    stroke: status === 'decommissioned' ? '#c92a2a' : DEFAULT_STROKE,
    badge: RESOURCE_LABELS[r.kind],
    lines: [r.name, join(r.technology, r.version), status === 'provisioned' ? '' : STATUS_LABELS[status], ...extra].filter(Boolean),
    shape: RESOURCE_SHAPES[r.kind],
    dashed: status !== 'provisioned',
  };
}

export interface RenderedEdge {
  /** Qué une la flecha: una dependencia, «corre en» (servicio → anfitrión) o el flujo de un pipeline. */
  kind: DependencyKind | 'runs-on' | 'flow';
  source: string;
  target: string;
  label?: string;
  stroke: string;
  dashed: boolean;
  width: number;
}

export interface RenderedView {
  view: PlatformView;
  layout: GraphLayout;
  /** Estilo de cada nodo dibujado, por su id en el layout. */
  nodes: Map<string, SceneNode>;
  /** Título de cada grupo (red, clúster, pipeline). */
  groups: Map<string, string>;
  /** El mismo título, recortado si el grupo es demasiado estrecho (para el SVG, que no ajusta el texto). */
  fittedGroups: Map<string, string>;
  edges: Map<string, RenderedEdge>;
  /** Relleno y borde de los grupos que los tienen propios (las redes). */
  groupStyles: Map<string, GroupStyle>;
  /** Leyenda de colores de la vista, si la tiene (la matriz de comparación de varios entornos). */
  legend?: SvgLegend;
}

/** Un nodo de la escena: su estilo, el grupo que lo contiene y lo que hace falta para exportarlo a otros formatos. */
export interface SceneNode extends SvgNodeStyle {
  groupId?: string;
  /** Clase del nodo (`service`, `database`…): en Mermaid es la que manda al importar. */
  cls: string;
  /** Estado del recurso, si no es el normal. */
  status?: ResourceStatus;
  /** Id del servicio o recurso que representa (una instancia de servicio no tiene el suyo). */
  elementId?: string;
  /** En la comparación de entornos: en qué se distingue del otro lado (`same` si en nada). */
  diff?: DiffMark;
}

/** Marca de diferencia de un nodo de la comparación: una clase de diferencia, varias a la vez (`mixed`) o ninguna (`same`). */
export type DiffMark = DiffKind | 'mixed' | 'same';

export const DIFF_COLORS: Record<Exclude<DiffMark, 'same'>, string> = { 'only-a': '#c2410c', 'only-b': '#1971c2', version: '#7048e8', replicas: '#b45309', mixed: '#a61e4d' };
export const DIFF_LABELS: Record<DiffMark, (a: string, b: string) => string> = {
  'only-a': (a) => `Solo en ${a}`,
  'only-b': (_a, b) => `Solo en ${b}`,
  version: () => 'Versión distinta',
  replicas: () => 'Réplicas distintas',
  mixed: () => 'Versión + réplicas',
  same: () => 'Igual en ambos',
};
const markOf = (kinds: DiffKind[]): DiffMark => (kinds.length === 0 ? 'same' : kinds.length > 1 ? 'mixed' : kinds[0]);

/** Lo que se dibuja de una vista, antes de colocarlo. */
export interface Scene {
  nodes: Map<string, SceneNode>;
  groups: Map<string, { label: string; /** Título más corto, para cuando el grupo es demasiado estrecho para el completo. */ short?: string; groupId?: string; /** Recurso (anfitrión), red o pipeline que representa. */ elementId: string; /** Relleno y borde propios (las redes, según su exposición). */ style?: GroupStyle }>;
  edges: Map<string, RenderedEdge>;
}

const serviceNode = (s: Service, extra: string[] = []): SceneNode => ({ ...serviceStyle(s, extra), cls: s.external ? 'external' : serviceKindOf(s), elementId: s.id });
const resourceNode = (r: Resource, extra: string[] = []): SceneNode => ({ ...resourceStyle(r, extra), cls: r.kind, elementId: r.id, ...(statusOf(r) !== 'provisioned' ? { status: statusOf(r) } : {}) });

const dependencyEdge = (d: Dependency, source: string, target: string): RenderedEdge => ({ kind: d.kind, source, target, label: dependencyLabel(d), ...DEPENDENCY_STYLES[d.kind] });

/** Servicios y recursos de la topología y de las vistas de traza: un grafo plano, sin grupos. */
function flatScene(doc: PlatformDocument, view: PlatformView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const services = new Map(doc.services.map((s) => [s.id, s]));
  const resources = new Map(doc.resources.map((r) => [r.id, r]));
  const environments = new Map(doc.environments.map((e) => [e.id, e.name]));
  const multipleEnvironments = doc.environments.length > 1 && view.environmentId === undefined;
  for (const id of view.elementIds) {
    const service = services.get(id);
    const resource = resources.get(id);
    const style = service
      ? serviceNode(service, [service.criticality ? `criticidad ${CRITICALITY_LABELS[service.criticality]}` : ''])
      : resourceNode(resource!, multipleEnvironments ? [`entorno ${environments.get(resource!.environmentId) ?? resource!.environmentId}`] : []);
    scene.nodes.set(id, id === view.focusId ? { ...style, stroke: FOCUS_STROKE } : style);
  }
  for (const d of doc.dependencies.filter((x) => view.dependencyIds.includes(x.id))) scene.edges.set(`d:${d.id}`, dependencyEdge(d, d.sourceId, d.targetId));
  for (const d of doc.deployments.filter((x) => view.deploymentIds.includes(x.id))) {
    scene.edges.set(`x:${d.id}`, { kind: 'runs-on', source: d.serviceId, target: d.hostId, label: d.environmentId === view.environmentId ? undefined : environments.get(d.environmentId), ...RUNS_ON_STYLE });
  }
  return scene;
}

/**
 * Vista de un entorno: las redes (anidadas) y los anfitriones (clústeres, máquinas) son grupos que contienen, respectivamente,
 * los recursos y las instancias de los servicios desplegados. Un anfitrión sin servicios se dibuja como un nodo.
 */
function environmentScene(doc: PlatformDocument, view: PlatformView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const shown = new Set(view.elementIds);
  const services = new Map(doc.services.map((s) => [s.id, s]));
  const networks = new Map(doc.networks.map((n) => [n.id, n]));
  const deployments = doc.deployments.filter((d) => view.deploymentIds.includes(d.id));
  const resources = doc.resources.filter((r) => shown.has(r.id));
  const hostsWithServices = new Set(deployments.map((d) => d.hostId));

  // Una red se dibuja si contiene algo (directamente o en una red hija).
  const drawnNetworks = new Set<string>();
  for (const r of resources) {
    for (let id = r.networkId; id !== undefined && !drawnNetworks.has(id); id = networks.get(id)?.parentId) drawnNetworks.add(id);
  }
  for (const n of doc.networks.filter((x) => drawnNetworks.has(x.id))) {
    scene.groups.set(n.id, { label: networkLabel(n), short: networkLabel(n, false), elementId: n.id, style: EXPOSURE_ZONES[exposureOf(n)], ...(n.parentId ? { groupId: n.parentId } : {}) });
  }
  for (const r of resources) {
    const groupId = r.networkId;
    if (isHost(r) && hostsWithServices.has(r.id)) scene.groups.set(r.id, { label: hostLabel(r), elementId: r.id, ...(groupId ? { groupId } : {}) });
    else scene.nodes.set(r.id, { ...resourceNode(r), ...(groupId ? { groupId } : {}) });
  }
  const instances = new Map<string, string[]>();
  for (const d of deployments) {
    const service = services.get(d.serviceId)!;
    const id = `i:${d.id}`;
    scene.nodes.set(id, { ...serviceNode(service, [join(d.replicas !== undefined && replicasText(d.replicas), d.version && `v${d.version}`)]), groupId: d.hostId });
    instances.set(service.id, [...(instances.get(service.id) ?? []), id]);
  }
  for (const id of view.elementIds) {
    const service = services.get(id);
    if (service?.external) scene.nodes.set(id, serviceNode(service));
  }

  const ends = (id: string): string[] => instances.get(id) ?? (scene.nodes.has(id) || scene.groups.has(id) ? [id] : []);
  for (const d of doc.dependencies.filter((x) => view.dependencyIds.includes(x.id))) {
    const [from, to] = [ends(d.sourceId), ends(d.targetId)];
    from.forEach((a) =>
      to.forEach((b) => {
        // Una instancia y el anfitrión donde corre no se unen con una flecha: ya está dentro.
        if (scene.nodes.get(a)?.groupId === b || scene.nodes.get(b)?.groupId === a) return;
        const id = from.length * to.length === 1 ? `d:${d.id}` : `d:${d.id}:${a}:${b}`;
        scene.edges.set(id, dependencyEdge(d, a, b));
      }),
    );
  }
  return scene;
}

/** Costes: un grupo por entorno (con su total mensual) que contiene los recursos y las instancias con coste, cada uno con su importe. */
function costScene(doc: PlatformDocument, view: PlatformView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const services = new Map(doc.services.map((s) => [s.id, s]));
  const shown = new Set(view.deploymentIds);
  for (const cost of costsByEnvironment(doc)) {
    const environment = doc.environments.find((e) => e.id === cost.environmentId)!;
    const group = `c:${environment.id}`;
    scene.groups.set(group, { label: `${environment.name} · ${formatCost(cost.total, doc)}`, elementId: environment.id });
    const share = (amount: number): string => (cost.total > 0 ? ` (${Math.round((amount / cost.total) * 100)} %)` : '');
    for (const r of doc.resources.filter((x) => x.environmentId === environment.id && x.monthlyCost !== undefined)) {
      scene.nodes.set(r.id, { ...resourceNode(r, [`${formatCost(r.monthlyCost!, doc)}${share(r.monthlyCost!)}`]), groupId: group });
    }
    for (const d of doc.deployments.filter((x) => x.environmentId === environment.id && shown.has(x.id))) {
      scene.nodes.set(`i:${d.id}`, { ...serviceNode(services.get(d.serviceId)!, [`${formatCost(d.monthlyCost!, doc)}${share(d.monthlyCost!)}`]), groupId: group });
    }
  }
  return scene;
}

/** Pipelines: una cadena de pasos por pipeline (construir, y un paso por entorno), con los servicios que entran y los recursos que salen. */
function deliveryScene(doc: PlatformDocument, view: PlatformView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const services = new Map(doc.services.map((s) => [s.id, s]));
  const resources = new Map(doc.resources.map((r) => [r.id, r]));
  const environments = new Map(doc.environments.map((e) => [e.id, e]));
  for (const id of view.elementIds) {
    if (services.has(id)) scene.nodes.set(id, serviceNode(services.get(id)!));
    else scene.nodes.set(id, resourceNode(resources.get(id)!));
  }
  const edge = (id: string, source: string, target: string, label?: string): void =>
    void scene.edges.set(id, { kind: 'flow', source, target, label, stroke: STEP_COLOR, dashed: false, width: 1.5 });
  for (const p of doc.pipelines.filter((x) => view.pipelineIds.includes(x.id))) {
    const group = `p:${p.id}`;
    scene.groups.set(group, { label: pipelineLabel(p), elementId: p.id });
    const steps: string[] = [];
    const step = (id: string, style: SvgNodeStyle): void => {
      scene.nodes.set(id, { ...style, groupId: group, cls: 'step' });
      steps.push(id);
    };
    if (p.kind === 'ci' || p.kind === 'ci-cd') step(`${group}:build`, { fill: STEP_COLOR, stroke: DEFAULT_STROKE, badge: 'CI', lines: ['Construir y probar'] });
    if (p.kind === 'iac') step(`${group}:apply`, { fill: STEP_COLOR, stroke: DEFAULT_STROKE, badge: 'IaC', lines: ['Planificar y aplicar'] });
    const versionIn = (serviceId: string, environmentId: string): string | undefined => doc.deployments.find((d) => d.serviceId === serviceId && d.environmentId === environmentId)?.version;
    p.stages.forEach((s, i) => {
      const environment = environments.get(s.environmentId);
      // Versión promocionada: cuántos servicios del pipeline llevan en esta etapa otra versión que en la anterior (están por promover).
      const previous = i > 0 ? environments.get(p.stages[i - 1].environmentId) : undefined;
      const pending = previous ? p.serviceIds.filter((id) => { const [from, to] = [versionIn(id, previous.id), versionIn(id, s.environmentId)]; return from !== undefined && to !== undefined && from !== to; }).length : 0;
      step(`${group}:s${i}`, {
        fill: environment?.kind ? STAGE_COLORS[environment.kind] : '#1168bd',
        stroke: DEFAULT_STROKE,
        badge: p.kind === 'iac' ? 'Aplica en' : 'Despliega en',
        lines: [environment?.name ?? s.environmentId, s.approval ? 'aprobación manual' : '', pending > 0 && previous ? `${pending} con versión distinta de ${previous.name}` : ''].filter(Boolean),
      });
    });
    if (steps.length === 0) step(`${group}:run`, { fill: STEP_COLOR, stroke: DEFAULT_STROKE, lines: ['Ejecución'] });
    steps.slice(1).forEach((id, i) => edge(`${group}:e${i}`, steps[i], id));
    for (const id of p.serviceIds) if (scene.nodes.has(id)) edge(`${group}:in:${id}`, id, steps[0]);
    for (const id of p.provisions ?? []) if (scene.nodes.has(id)) edge(`${group}:out:${id}`, steps[steps.length - 1], id);
  }
  return scene;
}

/**
 * Comparación de dos entornos: un grupo por entorno (A a la izquierda, B a la derecha) con sus servicios (instancias) y recursos, y
 * una línea entre cada par que se corresponde. Lo que difiere se marca con color e insignia: solo en A, solo en B, versión distinta
 * o réplicas distintas. La línea de un par de recursos que no se emparejó por nombre idéntico lo dice en su etiqueta.
 */
function compareScene(doc: PlatformDocument, view: PlatformView): Scene {
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  const comparison = compareEnvironments(doc, view.compareIds![0], view.compareIds![1]);
  const names = [comparison.a.name, comparison.b.name] as const;
  const groupOf = (side: 0 | 1): string => `c:${side === 0 ? comparison.a.id : comparison.b.id}`;
  scene.groups.set(groupOf(0), { label: `A · ${names[0]}`, elementId: comparison.a.id });
  scene.groups.set(groupOf(1), { label: `B · ${names[1]}`, elementId: comparison.b.id });
  const paint = (style: SceneNode, mark: DiffMark): SceneNode =>
    mark === 'same' ? { ...style, diff: mark, badge: DIFF_LABELS.same(...names) } : { ...style, diff: mark, fill: DIFF_COLORS[mark], stroke: '#0f172a', badge: DIFF_LABELS[mark](...names), dashed: mark === 'only-a' || mark === 'only-b' };
  const detail = (p: Presence): string => join(`${p.replicas} ${p.replicas === 1 ? 'réplica' : 'réplicas'}`, p.versions.length > 0 && versionText(p.versions));
  const edge = (id: string, source: string, target: string, mark: DiffMark, label?: string): void =>
    void scene.edges.set(id, { kind: 'flow', source, target, label, stroke: mark === 'same' ? '#94a3b8' : DIFF_COLORS[mark], dashed: mark === 'same', width: mark === 'same' ? 1.5 : 2.5 });
  for (const d of comparison.services) {
    const mark = markOf(d.kinds);
    const ids = ([d.a, d.b] as const).map((p) => (p ? `i:${p.deploymentIds[0]}` : undefined));
    ([d.a, d.b] as const).forEach((p, side) => {
      if (p) scene.nodes.set(ids[side]!, { ...paint({ ...serviceNode(d.service, [detail(p)]) }, mark), groupId: groupOf(side as 0 | 1) });
    });
    if (ids[0] && ids[1]) {
      const changes = [d.kinds.includes('version') && `${versionText(d.a!.versions)} → ${versionText(d.b!.versions)}`, d.kinds.includes('replicas') && `${d.a!.replicas} → ${d.b!.replicas} réplicas`].filter(Boolean).join(' · ');
      edge(`k:${d.service.id}`, ids[0], ids[1], mark, changes || undefined);
    }
  }
  comparison.resources.forEach((r, i) => {
    const mark = markOf(r.kinds);
    ([r.a, r.b] as const).forEach((res, side) => {
      if (res) scene.nodes.set(res.id, { ...paint(resourceNode(res), mark), groupId: groupOf(side as 0 | 1) });
    });
    // Lo que difiere y, si el par no se emparejó por nombre idéntico, cómo se emparejó (para que se pueda dudar de la diferencia).
    if (r.a && r.b) edge(`k:r${i}`, r.a.id, r.b.id, mark, [r.kinds.includes('version') && `v${r.a.version ?? '?'} → v${r.b.version ?? '?'}`, r.matchedBy && r.matchedBy !== 'name' && MATCH_NOTES[r.matchedBy]].filter(Boolean).join(' · ') || undefined);
  });
  return scene;
}

const sizeOf = (style: SvgNodeStyle): { width: number; height: number } => ({ width: widthFor(style.lines, style.shape === 'pill' || style.shape === 'pipe' ? 170 : 180), height: NODE_HEIGHT });

/** Lo que hay que dibujar en una vista (nodos, grupos y flechas), sin coordenadas. */
export function buildScene(doc: PlatformDocument, view: PlatformView): Scene {
  if (matrixIsDrawn(view)) return drawMatrix(doc, view).scene;
  return view.type === 'environment' ? environmentScene(doc, view) : view.type === 'delivery' ? deliveryScene(doc, view) : view.type === 'costs' ? costScene(doc, view) : view.type === 'compare' ? compareScene(doc, view) : flatScene(doc, view);
}

/** Coloca una vista con el autolayout genérico del kernel. */
export async function layoutView(doc: PlatformDocument, viewId?: string, options: GraphLayoutOptions = {}): Promise<RenderedView> {
  const view = findView(doc, viewId);
  // La matriz de comparación de varios entornos es una cuadrícula que se coloca sola, sin el autolayout por capas.
  if (matrixIsDrawn(view)) {
    const { scene, layout, legend } = drawMatrix(doc, view);
    const titles = new Map([...scene.groups].map(([id, g]) => [id, g.label] as const));
    return { view, layout, nodes: scene.nodes, groups: titles, fittedGroups: titles, edges: scene.edges, groupStyles: new Map(), legend };
  }
  const scene = buildScene(doc, view);
  const nodes: GraphNodeInput[] = [...scene.nodes].map(([id, style]) => ({ id, ...sizeOf(style), ...(style.groupId ? { groupId: style.groupId } : {}) }));
  const groups: GraphGroupInput[] = [...scene.groups].map(([id, g]) => ({ id, ...(g.groupId ? { groupId: g.groupId } : {}) }));
  const edges: GraphEdgeInput[] = [...scene.edges].map(([id, e]) => ({ id, source: e.source, target: e.target, label: e.label }));
  const layout = await layoutGraph(nodes, edges, groups, { direction: 'RIGHT', ...options });
  const widths = new Map(layout.groups.map((g) => [g.id, g.width]));
  const fitted = new Map([...scene.groups].map(([id, g]) => [id, g.short && g.label.length * 6.4 + 16 > (widths.get(id) ?? Infinity) ? g.short : g.label]));
  return { view, layout, nodes: scene.nodes, groups: new Map([...scene.groups].map(([id, g]) => [id, g.label])), fittedGroups: fitted, edges: scene.edges, groupStyles: new Map([...scene.groups].flatMap(([id, g]) => (g.style ? [[id, g.style] as const] : []))) };
}

export async function toSvg(doc: PlatformDocument, viewId?: string): Promise<string> {
  const { view, layout, nodes, fittedGroups, edges, groupStyles, legend } = await layoutView(doc, viewId);
  return renderGraphSvg(layout, {
    title: view.title,
    ...(legend ? { legend } : {}),
    node: (id) => nodes.get(id)!,
    edge: (id) => {
      const e = edges.get(id)!;
      return { stroke: e.stroke, dashed: e.dashed, label: e.label, width: e.width };
    },
    group: (id) => ({ label: fittedGroups.get(id) ?? id, ...groupStyles.get(id) }),
  });
}
