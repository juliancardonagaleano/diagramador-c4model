import { uniqueId, type EdgeNotation, type EditResult, type EditorGraph, type EditorNode, type EditorSpec, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { DEPENDENCY_STYLES, EXTERNAL_COLOR, RESOURCE_COLORS, SERVICE_COLORS, buildScene } from './export/render';
import {
  CRITICALITIES,
  CRITICALITY_LABELS,
  DEPENDENCY_KINDS,
  DEPENDENCY_LABELS,
  EXPOSURES,
  EXPOSURE_LABELS,
  HOST_KINDS,
  PIPELINE_KINDS,
  PIPELINE_LABELS,
  RESOURCE_KINDS,
  RESOURCE_LABELS,
  RESOURCE_STATUSES,
  SERVICE_KINDS,
  SERVICE_LABELS,
  STATUS_LABELS,
  exposureOf,
  indexElements,
  isHost,
  type Deployment,
  type Dependency,
  type DependencyKind,
  type Network,
  type Pipeline,
  type PipelineStage,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type Service,
  type ServiceKind,
} from './types';
import { findView } from './views';

/**
 * Editor interactivo de la plataforma. Su identidad es la de un diagrama de despliegue: en la vista de un entorno las
 * redes son zonas anidadas (coloreadas por exposición), los clústeres y máquinas son cajas que contienen las instancias de
 * los servicios, y los recursos llevan la figura de su clase (cilindro para datos, píldora para colas, hexágono para las
 * pasarelas…). Arrastrar un servicio a un clúster con «corre en» crea el despliegue; en la entrega continua, un servicio a
 * un pipeline lo añade a los que construye. Los entornos no se dibujan: se eligen en las propiedades.
 */
const STEP_COLOR = '#475569';
const NETWORK_FILLS: Record<string, string> = { public: '#e03131', private: '#1c7ed6', isolated: '#495057' };

const service = (kind: ServiceKind, glyph: string, shape: NodeNotation['shape']): NodeNotation => ({ kind, label: SERVICE_LABELS[kind], glyph, shape, fill: SERVICE_COLORS[kind], width: 200, height: 78 });
const resource = (kind: ResourceKind, glyph: string, shape: NodeNotation['shape'], height = 78): NodeNotation => ({ kind, label: RESOURCE_LABELS[kind], glyph, shape, fill: RESOURCE_COLORS[kind], width: 200, height });

const NODE_KIND_NOTATION: NodeNotation[] = [
  service('service', '▣', 'rect'),
  service('worker', '⚙', 'rounded'),
  service('job', '⏱', 'hexagon'),
  service('frontend', '▭', 'card'),
  { kind: 'external', label: 'Servicio externo', glyph: '☁', shape: 'rect', fill: EXTERNAL_COLOR, width: 200, height: 78, addable: false },
  resource('cluster', '⬢', 'rect'),
  resource('vm', '▥', 'rect'),
  resource('database', '⛁', 'cylinder', 84),
  resource('cache', '⚡', 'cylinder', 84),
  resource('storage', '▤', 'cylinder', 84),
  resource('queue', '⇒', 'pill', 64),
  resource('load-balancer', '⇶', 'hexagon'),
  resource('gateway', '⇄', 'chevron'),
  resource('dns', '◎', 'circle'),
  resource('secret-store', '🔒', 'hexagon'),
  resource('registry', '▦', 'card'),
  resource('other', '▢', 'rect'),
  { kind: 'network', label: 'Red', glyph: '▦', shape: 'rect', fill: NETWORK_FILLS.private, width: 240, height: 120 },
  { kind: 'pipeline', label: 'Pipeline', glyph: '⛓', shape: 'rect', fill: STEP_COLOR, width: 240, height: 120 },
  { kind: 'step', label: 'Paso', glyph: '·', shape: 'rect', fill: STEP_COLOR, width: 180, height: 70, addable: false },
  { kind: 'instance', label: 'Instancia desplegada', glyph: '▣', shape: 'rect', fill: SERVICE_COLORS.service, width: 200, height: 78, addable: false },
];

const EDGE_KIND_NOTATION: EdgeNotation[] = [
  ...DEPENDENCY_KINDS.map((kind): EdgeNotation => ({ kind, label: DEPENDENCY_LABELS[kind], stroke: DEPENDENCY_STYLES[kind].stroke, line: DEPENDENCY_STYLES[kind].dashed ? 'dashed' : 'solid', width: DEPENDENCY_STYLES[kind].width })),
  { kind: 'runs-on', label: 'corre en (despliegue)', stroke: '#94a3b8', line: 'dashed', width: 1.5 },
  { kind: 'flow', label: 'pasa por (pipeline)', stroke: STEP_COLOR, line: 'solid', width: 1.5 },
];

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] }));
const NAME: FieldSpec = { key: 'name', label: 'Nombre', type: 'text' };
const DESCRIPTION: FieldSpec = { key: 'description', label: 'Descripción', type: 'longtext' };
const REF: FieldSpec = { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' };
const TAGS: FieldSpec = { key: 'tags', label: 'Etiquetas', type: 'list' };
const INSTANCE_FIELDS: FieldSpec[] = [
  { key: 'replicas', label: 'Réplicas', type: 'text' },
  { key: 'version', label: 'Versión desplegada', type: 'text' },
];

function nodeFields(kind: string, doc: PlatformDocument): FieldSpec[] {
  const environment: FieldSpec = { key: 'environmentId', label: 'Entorno', type: 'select', options: doc.environments.map((e) => ({ value: e.id, label: e.name })) };
  const network = (key: string, label: string): FieldSpec => ({ key, label, type: 'select', options: doc.networks.map((n) => ({ value: n.id, label: `${n.name} (${doc.environments.find((e) => e.id === n.environmentId)?.name ?? n.environmentId})` })), allowEmpty: true });
  if ((SERVICE_KINDS as readonly string[]).includes(kind) || kind === 'external') {
    return [
      NAME,
      DESCRIPTION,
      { key: 'kind', label: 'Clase', type: 'select', options: options(SERVICE_KINDS, SERVICE_LABELS), allowEmpty: true },
      { key: 'technology', label: 'Tecnología', type: 'text' },
      { key: 'owner', label: 'Responsable', type: 'text' },
      { key: 'repo', label: 'Repositorio', type: 'text' },
      { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES, CRITICALITY_LABELS), allowEmpty: true },
      { key: 'external', label: 'Externo (SaaS, no se despliega aquí)', type: 'boolean' },
      REF,
      TAGS,
    ];
  }
  if ((RESOURCE_KINDS as readonly string[]).includes(kind)) {
    return [
      NAME,
      DESCRIPTION,
      { key: 'kind', label: 'Clase', type: 'select', options: options(RESOURCE_KINDS, RESOURCE_LABELS) },
      environment,
      network('networkId', 'Red'),
      { key: 'technology', label: 'Tecnología', type: 'text' },
      { key: 'version', label: 'Versión', type: 'text' },
      { key: 'status', label: 'Estado', type: 'select', options: options(RESOURCE_STATUSES, STATUS_LABELS), allowEmpty: true, hint: 'si no se indica, aprovisionado' },
      { key: 'iac', label: 'Gestionado como código (IaC)', type: 'boolean' },
      { key: 'owner', label: 'Responsable', type: 'text' },
      REF,
      TAGS,
    ];
  }
  switch (kind) {
    case 'network':
      return [NAME, DESCRIPTION, environment, network('parentId', 'Red que la contiene'), { key: 'exposure', label: 'Exposición', type: 'select', options: options(EXPOSURES, EXPOSURE_LABELS), allowEmpty: true, hint: 'si no se indica, privada' }, { key: 'cidr', label: 'CIDR', type: 'text' }];
    case 'pipeline':
    case 'step':
      return [
        NAME,
        DESCRIPTION,
        { key: 'kind', label: 'Clase', type: 'select', options: options(PIPELINE_KINDS, PIPELINE_LABELS) },
        { key: 'tool', label: 'Herramienta', type: 'text' },
        { key: 'owner', label: 'Responsable', type: 'text' },
        { key: 'serviceIds', label: 'Servicios que construye o despliega', type: 'list', hint: 'ids de servicio' },
        { key: 'provisions', label: 'Recursos que aprovisiona (IaC)', type: 'list', hint: 'ids de recurso' },
        { key: 'stages', label: 'Entornos por los que promociona', type: 'list', hint: 'ids de entorno en orden; «prod*» pide aprobación manual' },
      ];
    case 'instance':
      return INSTANCE_FIELDS;
    default:
      return [NAME, DESCRIPTION];
  }
}

const EDGE_FIELDS: Record<string, FieldSpec[]> = {
  dependency: [
    { key: 'kind', label: 'Tipo', type: 'select', options: options(DEPENDENCY_KINDS, DEPENDENCY_LABELS) },
    { key: 'protocol', label: 'Protocolo', type: 'text' },
    DESCRIPTION,
  ],
  'runs-on': INSTANCE_FIELDS,
  flow: [],
};

const clean = (value: unknown): unknown => (value === '' || value === null || value === false || (Array.isArray(value) && value.length === 0) ? undefined : value);

function patchObject<T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = clean(patch[key]);
    if (key === 'replicas' && value !== undefined) value = Number(value);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

const stagesToText = (stages: PipelineStage[]): string[] => stages.map((s) => `${s.environmentId}${s.approval ? '*' : ''}`);
const parseStages = (text: unknown): PipelineStage[] =>
  (Array.isArray(text) ? (text as unknown[]).map(String) : []).map((t) => t.trim()).filter(Boolean).map((t) => (t.endsWith('*') ? { environmentId: t.slice(0, -1).trim(), approval: true } : { environmentId: t }));

/** Qué representa un id del lienzo: el elemento, una instancia de despliegue, un paso de pipeline o una flecha. */
type Target =
  | { type: 'element'; id: string }
  | { type: 'instance'; deploymentId: string }
  | { type: 'pipeline'; pipelineId: string; step?: string }
  | { type: 'dependency'; dependencyId: string }
  | { type: 'runs-on'; deploymentId: string }
  | { type: 'flow'; pipelineId: string; direction: 'in' | 'out'; elementId: string }
  | { type: 'flow-step'; pipelineId: string };

function resolve(doc: PlatformDocument, id: string): Target | undefined {
  if (id.startsWith('i:')) return doc.deployments.some((d) => d.id === id.slice(2)) ? { type: 'instance', deploymentId: id.slice(2) } : undefined;
  if (id.startsWith('x:')) return doc.deployments.some((d) => d.id === id.slice(2)) ? { type: 'runs-on', deploymentId: id.slice(2) } : undefined;
  if (id.startsWith('d:')) {
    const dependencyId = doc.dependencies.map((d) => d.id).find((did) => id === `d:${did}` || id.startsWith(`d:${did}:`));
    return dependencyId ? { type: 'dependency', dependencyId } : undefined;
  }
  if (id.startsWith('p:')) {
    const pipelineId = doc.pipelines.map((p) => p.id).find((pid) => id === `p:${pid}` || id.startsWith(`p:${pid}:`));
    if (!pipelineId) return undefined;
    const rest = id.slice(`p:${pipelineId}`.length + 1);
    if (rest === '') return { type: 'pipeline', pipelineId };
    if (rest.startsWith('in:')) return { type: 'flow', pipelineId, direction: 'in', elementId: rest.slice(3) };
    if (rest.startsWith('out:')) return { type: 'flow', pipelineId, direction: 'out', elementId: rest.slice(4) };
    if (/^e\d+$/.test(rest)) return { type: 'flow-step', pipelineId };
    return { type: 'pipeline', pipelineId, step: rest };
  }
  return indexElements(doc).has(id) ? { type: 'element', id } : undefined;
}

/** Servicio o recurso que hay detrás de un nodo del lienzo (una instancia es su servicio). */
function elementBehind(doc: PlatformDocument, nodeId: string): { kind: 'service' | 'resource'; id: string } | undefined {
  const target = resolve(doc, nodeId);
  if (target?.type === 'instance') return { kind: 'service', id: doc.deployments.find((d) => d.id === target.deploymentId)!.serviceId };
  if (target?.type === 'element') {
    const e = indexElements(doc).get(target.id)!;
    if (e.kind === 'service' || e.kind === 'resource') return { kind: e.kind, id: e.id };
  }
  return undefined;
}

const widthFor = (lines: string[], min: number): number => Math.min(300, Math.max(min, Math.ceil(Math.max(...lines.map((l, i) => l.length * (i === 0 ? 7.2 : 6.2))) + 32)));

/** Entorno en el que crear algo: el del contenedor elegido, el de la vista abierta o el primero del documento. */
function environmentFor(doc: PlatformDocument, parentId?: string, viewId?: string): string | undefined {
  const parent = parentId ? indexElements(doc).get(parentId) : undefined;
  if (parent && (parent.kind === 'network' || parent.kind === 'resource')) return (parent.item as { environmentId: string }).environmentId;
  if (viewId) {
    try {
      const env = findView(doc, viewId).environmentId;
      if (env) return env;
    } catch {
      /* vista desconocida: se sigue con el primer entorno */
    }
  }
  return doc.environments[0]?.id;
}

const ok = (document: PlatformDocument, id?: string): EditResult<PlatformDocument> => ({ ok: true, document, id });
const fail = (reason: string): EditResult<PlatformDocument> => ({ ok: false, reason });

export const platformEditor: EditorSpec<PlatformDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'calls',

  project(doc, viewId): EditorGraph {
    const view = findView(doc, viewId);
    const scene = buildScene(doc, view);
    const all = indexElements(doc);
    const networks = new Map(doc.networks.map((n) => [n.id, n]));
    const kinds = new Map(NODE_KIND_NOTATION.map((k) => [k.kind, k]));
    const nodes: EditorNode[] = [];
    for (const [id, g] of scene.groups) {
      const element = all.get(g.elementId);
      const network = networks.get(g.elementId);
      const kind = network ? 'network' : element?.kind === 'pipeline' ? 'pipeline' : ((element?.item as Resource | undefined)?.kind ?? 'other');
      // El lienzo antepone la clase al título del grupo, así que el título lleva solo el nombre y lo que lo caracteriza.
      const label = network
        ? `${network.name} · ${EXPOSURE_LABELS[exposureOf(network)]}${network.cidr ? ` (${network.cidr})` : ''}`
        : element?.kind === 'pipeline'
          ? `${element.name} · ${PIPELINE_LABELS[(element.item as Pipeline).kind]}${(element.item as Pipeline).tool ? ` (${(element.item as Pipeline).tool})` : ''}`
          : (element?.name ?? g.label);
      nodes.push({ id, kind, label, parentId: g.groupId, ref: (element?.item as { ref?: string } | undefined)?.ref, fill: network ? NETWORK_FILLS[exposureOf(network)] : undefined });
    }
    for (const [id, n] of scene.nodes) {
      const [label = id, ...rest] = n.lines;
      const notation = kinds.get(n.cls) ?? kinds.get('other')!;
      const shownAsInstance = id.startsWith('i:');
      nodes.push({
        id,
        kind: n.cls,
        label,
        sublabel: rest[0],
        badges: rest.slice(1).filter(Boolean),
        parentId: n.groupId,
        ref: shownAsInstance ? undefined : (n.elementId ? (all.get(n.elementId)?.item as { ref?: string } | undefined)?.ref : undefined),
        fill: n.fill,
        stroke: n.stroke === '#0f172a55' ? undefined : n.stroke,
        dashed: n.dashed,
        width: widthFor(n.lines, notation.width),
      });
    }
    return {
      nodes,
      edges: [...scene.edges].map(([id, e]) => ({ id, kind: e.kind, source: e.source, target: e.target, label: e.label })),
    };
  },

  fields(target, doc) {
    if (target.type === 'node') return nodeFields(target.kind, doc);
    return EDGE_FIELDS[(DEPENDENCY_KINDS as readonly string[]).includes(target.kind) ? 'dependency' : target.kind] ?? [];
  },

  read(doc, id) {
    const target = resolve(doc, id);
    if (!target) return undefined;
    switch (target.type) {
      case 'element': {
        const e = indexElements(doc).get(target.id)!;
        if (e.kind === 'service') return { type: 'node', kind: (e.item as Service).external ? 'external' : ((e.item as Service).kind ?? 'service'), values: { ...e.item } };
        if (e.kind === 'resource') return { type: 'node', kind: (e.item as Resource).kind, values: { ...e.item } };
        if (e.kind === 'pipeline') return { type: 'node', kind: 'pipeline', values: { ...e.item, stages: stagesToText((e.item as Pipeline).stages) } };
        return { type: 'node', kind: e.kind, values: { ...e.item } };
      }
      case 'pipeline': {
        const p = doc.pipelines.find((x) => x.id === target.pipelineId)!;
        return { type: 'node', kind: 'pipeline', values: { ...p, stages: stagesToText(p.stages) } };
      }
      case 'instance':
      case 'runs-on': {
        const d = doc.deployments.find((x) => x.id === target.deploymentId)!;
        return { type: target.type === 'instance' ? 'node' : 'edge', kind: target.type === 'instance' ? 'instance' : 'runs-on', values: { ...d, replicas: d.replicas === undefined ? '' : String(d.replicas) } };
      }
      case 'dependency': {
        const d = doc.dependencies.find((x) => x.id === target.dependencyId)!;
        return { type: 'edge', kind: d.kind, values: { ...d } };
      }
      default:
        return { type: 'edge', kind: 'flow', values: {} };
    }
  },

  addNode(doc, kind, name, parentId, viewId) {
    const taken = [...indexElements(doc).keys()];
    const parent = parentId ? resolve(doc, parentId) : undefined;
    const parentElement = parent?.type === 'element' ? indexElements(doc).get(parent.id) : undefined;
    if ((SERVICE_KINDS as readonly string[]).includes(kind)) {
      const id = uniqueId(name, taken);
      const created: Service = { id, name, ...(kind !== 'service' ? { kind: kind as ServiceKind } : {}) };
      let deployments = doc.deployments;
      // En la vista de un entorno el servicio nace desplegado: en el anfitrión elegido o, si no, en el primero del entorno.
      const environmentId = viewId ? environmentFor(doc, undefined, viewId) : undefined;
      const view = viewId ? findView(doc, viewId) : undefined;
      if (view?.type === 'environment' && environmentId) {
        const chosen = parentElement?.kind === 'resource' && isHost(parentElement.item as Resource) && (parentElement.item as Resource).environmentId === environmentId ? (parentElement.item as Resource) : undefined;
        const host = chosen ?? doc.resources.find((r) => r.environmentId === environmentId && isHost(r));
        if (host) deployments = [...deployments, { id: uniqueId(`${id}-${environmentId}`, deployments.map((d) => d.id)), serviceId: id, environmentId, hostId: host.id }];
      }
      return ok({ ...doc, services: [...doc.services, created], deployments }, id);
    }
    if ((RESOURCE_KINDS as readonly string[]).includes(kind)) {
      const environmentId = environmentFor(doc, parentId, viewId);
      if (!environmentId) return fail('Añade primero un entorno al documento (pestaña JSON): todo recurso pertenece a uno.');
      const id = uniqueId(name, taken);
      const networkId = parentElement?.kind === 'network' ? parentElement.id : parentElement?.kind === 'resource' ? (parentElement.item as Resource).networkId : undefined;
      const created: Resource = { id, name, kind: kind as ResourceKind, environmentId, ...(networkId ? { networkId } : {}) };
      return ok({ ...doc, resources: [...doc.resources, created] }, id);
    }
    if (kind === 'network') {
      const environmentId = environmentFor(doc, parentId, viewId);
      if (!environmentId) return fail('Añade primero un entorno al documento (pestaña JSON): toda red pertenece a uno.');
      const id = uniqueId(name, taken);
      const created: Network = { id, name, environmentId, ...(parentElement?.kind === 'network' ? { parentId: parentElement.id } : {}) };
      return ok({ ...doc, networks: [...doc.networks, created] }, id);
    }
    if (kind === 'pipeline') {
      const id = uniqueId(name, taken);
      const created: Pipeline = { id, name, kind: 'ci-cd', serviceIds: [], stages: doc.environments.map((e) => ({ environmentId: e.id, ...(e.kind === 'prod' ? { approval: true } : {}) })) };
      return ok({ ...doc, pipelines: [...doc.pipelines, created] }, `p:${id}`);
    }
    return fail(`Tipo de elemento desconocido: ${kind}`);
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = platformEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return fail(reason);
    const source = elementBehind(doc, sourceId);
    const target = elementBehind(doc, targetId);
    if ((DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
      const id = uniqueId(`${source!.id}-${target!.id}`, doc.dependencies.map((d) => d.id));
      const created: Dependency = { id, sourceId: source!.id, targetId: target!.id, kind: kind as DependencyKind };
      return ok({ ...doc, dependencies: [...doc.dependencies, created] }, `d:${id}`);
    }
    if (kind === 'runs-on') {
      const host = doc.resources.find((r) => r.id === target!.id)!;
      const id = uniqueId(`${source!.id}-${host.environmentId}`, doc.deployments.map((d) => d.id));
      const created: Deployment = { id, serviceId: source!.id, environmentId: host.environmentId, hostId: host.id };
      return ok({ ...doc, deployments: [...doc.deployments, created] }, `x:${id}`);
    }
    // flow: servicio → pipeline (lo construye) o pipeline → recurso (lo aprovisiona)
    const from = resolve(doc, sourceId);
    const to = resolve(doc, targetId);
    const pipelineId = from?.type === 'pipeline' ? from.pipelineId : to?.type === 'pipeline' ? to.pipelineId : undefined;
    const pipelines = doc.pipelines.map((p) => {
      if (p.id !== pipelineId) return p;
      if (to?.type === 'pipeline') return { ...p, serviceIds: [...p.serviceIds, source!.id] };
      return { ...p, provisions: [...(p.provisions ?? []), target!.id] };
    });
    return ok({ ...doc, pipelines }, to?.type === 'pipeline' ? `p:${pipelineId}:in:${source!.id}` : `p:${pipelineId}:out:${target!.id}`);
  },

  update(doc, id, patch) {
    const target = resolve(doc, id);
    if (!target) return fail(`No existe «${id}».`);
    if (typeof patch.name === 'string' && patch.name.trim() === '') return fail('El nombre no puede estar vacío.');
    const all = indexElements(doc);
    switch (target.type) {
      case 'element': {
        const e = all.get(target.id)!;
        if (e.kind === 'service') {
          return ok({ ...doc, services: doc.services.map((s) => (s.id === e.id ? patchObject(s, patch, ['name', 'description', 'kind', 'technology', 'owner', 'repo', 'criticality', 'external', 'ref', 'tags']) : s)) }, id);
        }
        if (e.kind === 'resource') {
          const next = patchObject(e.item as Resource, patch, ['name', 'description', 'kind', 'environmentId', 'networkId', 'technology', 'version', 'status', 'iac', 'owner', 'ref', 'tags']);
          const network = next.networkId ? doc.networks.find((n) => n.id === next.networkId) : undefined;
          if (next.networkId && !network) return fail(`No existe la red «${next.networkId}».`);
          if (network && network.environmentId !== next.environmentId) return fail(`La red «${network.name}» es del entorno «${network.environmentId}», no de «${next.environmentId}».`);
          if (!doc.environments.some((x) => x.id === next.environmentId)) return fail(`No existe el entorno «${next.environmentId}».`);
          return ok({ ...doc, resources: doc.resources.map((r) => (r.id === e.id ? next : r)) }, id);
        }
        if (e.kind === 'network') {
          const next = patchObject(e.item as Network, patch, ['name', 'description', 'environmentId', 'parentId', 'exposure', 'cidr']);
          if (next.parentId === next.id) return fail('Una red no puede contenerse a sí misma.');
          const parent = next.parentId ? doc.networks.find((n) => n.id === next.parentId) : undefined;
          if (next.parentId && !parent) return fail(`No existe la red «${next.parentId}».`);
          if (parent && parent.environmentId !== next.environmentId) return fail('La red y la que la contiene deben ser del mismo entorno.');
          return ok({ ...doc, networks: doc.networks.map((n) => (n.id === e.id ? next : n)) }, id);
        }
        if (e.kind === 'pipeline') return updatePipeline(doc, e.id, patch, id);
        return ok({ ...doc, environments: doc.environments.map((x) => (x.id === e.id ? patchObject(x, patch, ['name', 'description', 'kind', 'provider', 'region']) : x)) }, id);
      }
      case 'pipeline':
        return updatePipeline(doc, target.pipelineId, patch, id);
      case 'instance':
      case 'runs-on': {
        if (typeof patch.replicas === 'string' && patch.replicas !== '' && !/^\d+$/.test(patch.replicas.trim())) return fail('Las réplicas son un número entero.');
        return ok({ ...doc, deployments: doc.deployments.map((d) => (d.id === target.deploymentId ? patchObject(d, patch, ['replicas', 'version']) : d)) }, id);
      }
      case 'dependency': {
        const next = doc.dependencies.map((d) => (d.id === target.dependencyId ? patchObject(d, patch, ['kind', 'protocol', 'description']) : d));
        const edited = next.find((d) => d.id === target.dependencyId)!;
        if (!(DEPENDENCY_KINDS as readonly string[]).includes(edited.kind)) return fail(`Tipo de dependencia desconocido: ${String(edited.kind)}`);
        return ok({ ...doc, dependencies: next }, id);
      }
      default:
        return fail('El flujo de un pipeline se edita en el propio pipeline.');
    }
  },

  remove(doc, id) {
    const target = resolve(doc, id);
    if (!target) return fail(`No existe «${id}».`);
    switch (target.type) {
      case 'element':
        return ok(removeElement(doc, target.id));
      case 'pipeline':
        return ok({ ...doc, pipelines: doc.pipelines.filter((p) => p.id !== target.pipelineId) });
      case 'instance':
      case 'runs-on':
        return ok({ ...doc, deployments: doc.deployments.filter((d) => d.id !== target.deploymentId) });
      case 'dependency':
        return ok({ ...doc, dependencies: doc.dependencies.filter((d) => d.id !== target.dependencyId) });
      case 'flow':
        return ok({
          ...doc,
          pipelines: doc.pipelines.map((p) =>
            p.id !== target.pipelineId ? p : target.direction === 'in' ? { ...p, serviceIds: p.serviceIds.filter((s) => s !== target.elementId) } : { ...p, provisions: (p.provisions ?? []).filter((r) => r !== target.elementId) },
          ),
        });
      default:
        return fail('Los pasos de un pipeline se quitan editando sus entornos.');
    }
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (sourceId === targetId) return 'Un elemento no puede unirse consigo mismo.';
    const source = elementBehind(doc, sourceId);
    const target = elementBehind(doc, targetId);
    if ((DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
      if (!source || !target) return 'Una dependencia une servicios o recursos.';
      if (source.id === target.id) return 'Un elemento no puede depender de sí mismo.';
      if (doc.dependencies.some((d) => d.kind === kind && d.sourceId === source.id && d.targetId === target.id)) return 'Esa dependencia ya existe.';
      return undefined;
    }
    if (kind === 'runs-on') {
      if (source?.kind !== 'service') return '«corre en» va de un servicio al clúster o máquina donde se despliega.';
      const s = doc.services.find((x) => x.id === source.id)!;
      if (s.external) return 'Un servicio externo no se despliega en la plataforma.';
      const host = target?.kind === 'resource' ? doc.resources.find((r) => r.id === target.id) : undefined;
      if (!host || !isHost(host)) return `El destino debe ser ${HOST_KINDS.map((k) => RESOURCE_LABELS[k].toLowerCase()).join(' o ')}.`;
      if (doc.deployments.some((d) => d.serviceId === s.id && d.hostId === host.id)) return 'Ese servicio ya corre en ese anfitrión.';
      return undefined;
    }
    if (kind === 'flow') {
      const from = resolve(doc, sourceId);
      const to = resolve(doc, targetId);
      if (source?.kind === 'service' && to?.type === 'pipeline') {
        const p = doc.pipelines.find((x) => x.id === to.pipelineId)!;
        if (doc.services.find((s) => s.id === source.id)?.external) return 'Ningún pipeline construye un servicio externo.';
        return p.serviceIds.includes(source.id) ? 'Ese pipeline ya construye ese servicio.' : undefined;
      }
      if (from?.type === 'pipeline' && target?.kind === 'resource') {
        const p = doc.pipelines.find((x) => x.id === from.pipelineId)!;
        if (p.kind !== 'iac') return 'Solo un pipeline de infraestructura como código aprovisiona recursos.';
        return (p.provisions ?? []).includes(target.id) ? 'Ese pipeline ya aprovisiona ese recurso.' : undefined;
      }
      return '«pasa por» va de un servicio a un pipeline (lo construye) o de un pipeline IaC a un recurso (lo aprovisiona).';
    }
    return `Tipo de relación desconocido: ${kind}`;
  },
};

function updatePipeline(doc: PlatformDocument, pipelineId: string, patch: Record<string, unknown>, id: string): EditResult<PlatformDocument> {
  const p = doc.pipelines.find((x) => x.id === pipelineId)!;
  const next = patchObject(p, patch, ['name', 'description', 'kind', 'tool', 'owner', 'serviceIds', 'provisions']);
  if (!('serviceIds' in next) || !Array.isArray(next.serviceIds)) next.serviceIds = [];
  if ('stages' in patch) next.stages = parseStages(patch.stages);
  const missingService = next.serviceIds.find((s) => !doc.services.some((x) => x.id === s));
  if (missingService) return fail(`No existe el servicio «${missingService}».`);
  const missingResource = (next.provisions ?? []).find((r) => !doc.resources.some((x) => x.id === r));
  if (missingResource) return fail(`No existe el recurso «${missingResource}».`);
  const missingEnv = next.stages.find((s) => !doc.environments.some((e) => e.id === s.environmentId));
  if (missingEnv) return fail(`No existe el entorno «${missingEnv.environmentId}».`);
  if (next.provisions && next.provisions.length > 0 && next.kind !== 'iac') return fail('Solo un pipeline de infraestructura como código (iac) aprovisiona recursos.');
  return ok({ ...doc, pipelines: doc.pipelines.map((x) => (x.id === pipelineId ? next : x)) }, id);
}

/** Quita un servicio, recurso, red, pipeline o entorno y todo lo que lo referencia. */
function removeElement(doc: PlatformDocument, id: string): PlatformDocument {
  const e = indexElements(doc).get(id)!;
  switch (e.kind) {
    case 'service':
      return {
        ...doc,
        services: doc.services.filter((s) => s.id !== id),
        deployments: doc.deployments.filter((d) => d.serviceId !== id),
        dependencies: doc.dependencies.filter((d) => d.sourceId !== id && d.targetId !== id),
        pipelines: doc.pipelines.map((p) => ({ ...p, serviceIds: p.serviceIds.filter((s) => s !== id) })),
      };
    case 'resource':
      return {
        ...doc,
        resources: doc.resources.filter((r) => r.id !== id),
        deployments: doc.deployments.filter((d) => d.hostId !== id),
        dependencies: doc.dependencies.filter((d) => d.sourceId !== id && d.targetId !== id),
        pipelines: doc.pipelines.map((p) => (p.provisions ? { ...p, provisions: p.provisions.filter((r) => r !== id) } : p)),
      };
    case 'network': {
      const parent = (e.item as Network).parentId;
      return {
        ...doc,
        networks: doc.networks.filter((n) => n.id !== id).map((n) => (n.parentId === id ? (parent ? { ...n, parentId: parent } : (({ parentId: _p, ...rest }) => rest)(n)) : n)),
        resources: doc.resources.map((r) => (r.networkId === id ? (parent ? { ...r, networkId: parent } : (({ networkId: _n, ...rest }) => rest)(r)) : r)),
      };
    }
    case 'pipeline':
      return { ...doc, pipelines: doc.pipelines.filter((p) => p.id !== id) };
    default: {
      const gone = new Set([...doc.resources.filter((r) => r.environmentId === id).map((r) => r.id)]);
      return {
        ...doc,
        environments: doc.environments.filter((x) => x.id !== id),
        networks: doc.networks.filter((n) => n.environmentId !== id),
        resources: doc.resources.filter((r) => r.environmentId !== id),
        deployments: doc.deployments.filter((d) => d.environmentId !== id),
        dependencies: doc.dependencies.filter((d) => !gone.has(d.sourceId) && !gone.has(d.targetId)),
        pipelines: doc.pipelines.map((p) => ({ ...p, stages: p.stages.filter((s) => s.environmentId !== id), ...(p.provisions ? { provisions: p.provisions.filter((r) => !gone.has(r)) } : {}) })),
      };
    }
  }
}

export { stagesToText, parseStages };
