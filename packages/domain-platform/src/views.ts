import { nextEnvironment } from './actions';
import { compareEnvironments, resolveComparison } from './compare';
import { hasCosts } from './costs';
import { dependencyGraph, reach, scopeEnvironment, scoped, type Reach } from './graph';
import { indexElements, type PlatformDocument } from './types';

export interface PlatformView {
  /** `topology`, `env:<id>`, `delivery`, `costs` o, bajo demanda, `impact:<id>`, `depends:<id>`, `focus:<id>` y `compare:<A>:<B>`. */
  id: string;
  type: 'topology' | 'environment' | 'delivery' | 'costs' | 'impact' | 'depends' | 'focus' | 'compare';
  /** Entornos que compara la vista `compare` (A a la izquierda, B a la derecha). */
  compareIds?: [string, string];
  title: string;
  /** Entorno al que se acota la vista (`environment` y las de impacto de un elemento de un solo entorno). */
  environmentId?: string;
  /** Elemento de partida de las vistas de impacto, dependencias y entorno. */
  focusId?: string;
  /** Servicios y recursos dibujados, servicios primero y en el orden del documento. */
  elementIds: string[];
  dependencyIds: string[];
  /** Despliegues: en la vista de un entorno son las instancias dentro de su anfitrión; en las de traza, las flechas «corre en». */
  deploymentIds: string[];
  pipelineIds: string[];
}

/** Ordena unos ids como en el documento: servicios, luego recursos. */
function inDocumentOrder(doc: PlatformDocument, ids: Set<string>): string[] {
  return [...doc.services, ...doc.resources].map((x) => x.id).filter((id) => ids.has(id));
}

function topology(doc: PlatformDocument): PlatformView {
  const ids = new Set(doc.services.map((s) => s.id));
  for (const d of doc.dependencies) {
    ids.add(d.sourceId);
    ids.add(d.targetId);
  }
  return {
    id: 'topology',
    type: 'topology',
    title: `Topología - ${doc.workspace.name}`,
    elementIds: inDocumentOrder(doc, ids),
    dependencyIds: doc.dependencies.map((d) => d.id),
    deploymentIds: [],
    pipelineIds: [],
  };
}

function environmentView(doc: PlatformDocument, environmentId: string): PlatformView {
  const environment = doc.environments.find((e) => e.id === environmentId)!;
  const { dependencies, deployments } = scoped(doc, environmentId);
  const ids = new Set([...doc.resources.filter((r) => r.environmentId === environmentId).map((r) => r.id), ...deployments.map((d) => d.serviceId)]);
  // Los servicios externos de los que dependen los desplegados aquí (una pasarela de pagos) se dibujan fuera de la plataforma.
  for (const d of dependencies) {
    for (const id of [d.sourceId, d.targetId]) if (doc.services.some((s) => s.id === id && s.external)) ids.add(id);
  }
  return {
    id: `env:${environmentId}`,
    type: 'environment',
    title: `Entorno ${environment.name} - ${doc.workspace.name}`,
    environmentId,
    elementIds: inDocumentOrder(doc, ids),
    dependencyIds: dependencies.map((d) => d.id),
    deploymentIds: deployments.map((d) => d.id),
    pipelineIds: [],
  };
}

function delivery(doc: PlatformDocument): PlatformView {
  const ids = new Set(doc.pipelines.flatMap((p) => [...p.serviceIds, ...(p.provisions ?? [])]));
  return {
    id: 'delivery',
    type: 'delivery',
    title: `Entrega continua - ${doc.workspace.name}`,
    elementIds: inDocumentOrder(doc, ids),
    dependencyIds: [],
    deploymentIds: [],
    pipelineIds: doc.pipelines.map((p) => p.id),
  };
}

/** Costes mensuales por entorno: los recursos y las instancias con coste, agrupados en su entorno. */
function costs(doc: PlatformDocument): PlatformView {
  const priced = doc.deployments.filter((d) => d.monthlyCost !== undefined);
  return {
    id: 'costs',
    type: 'costs',
    title: `Costes por entorno - ${doc.workspace.name}`,
    elementIds: doc.resources.filter((r) => r.monthlyCost !== undefined).map((r) => r.id),
    dependencyIds: [],
    deploymentIds: priced.map((d) => d.id),
    pipelineIds: [],
  };
}

/**
 * Vistas derivadas del documento: la topología lógica (servicios, recursos y sus dependencias), una por entorno con
 * lo que hay desplegado en cada red y anfitrión, la entrega continua (pipelines) y, si hay costes declarados, los costes por entorno. Solo se listan las que tienen
 * contenido; la comparación de dos entornos consecutivos en el camino a producción (`compare:<A>:<B>`) se lista si ambos tienen despliegues. El impacto o las dependencias de un elemento concreto se piden por su id (ver `findView`).
 */
export function listViews(doc: PlatformDocument): PlatformView[] {
  const views: PlatformView[] = [];
  if (doc.services.length > 0 && doc.dependencies.length > 0) views.push(topology(doc));
  for (const e of doc.environments) {
    if (doc.resources.some((r) => r.environmentId === e.id) || doc.deployments.some((d) => d.environmentId === e.id)) views.push(environmentView(doc, e.id));
  }
  if (doc.pipelines.length > 0) views.push(delivery(doc));
  views.push(...promotionPairs(doc).map(([a, b]) => compareView(doc, `${a}:${b}`)));
  if (hasCosts(doc)) views.push(costs(doc));
  return views;
}

/** Vista de comparación de dos entornos (`compare:<A>:<B>`; con uno solo, se compara con el siguiente en el camino a producción). */
export function compareView(doc: PlatformDocument, text: string): PlatformView {
  const [a, b] = resolveComparison(doc, text);
  const { services, resources } = compareEnvironments(doc, a.id, b.id);
  const deployments = doc.deployments.filter((d) => d.environmentId === a.id || d.environmentId === b.id);
  const ids = new Set([...services.map((s) => s.service.id), ...resources.flatMap((r) => [r.a?.id, r.b?.id].filter((id): id is string => !!id))]);
  return {
    id: `compare:${a.id}:${b.id}`,
    type: 'compare',
    title: `Comparación ${a.name} - ${b.name} - ${doc.workspace.name}`,
    compareIds: [a.id, b.id],
    elementIds: inDocumentOrder(doc, ids),
    dependencyIds: [],
    deploymentIds: deployments.map((d) => d.id),
    pipelineIds: [],
  };
}

/** Pares de entornos consecutivos en el camino a producción (dev → test → staging → prod) que tienen algo desplegado: los que se comparan por defecto. */
function promotionPairs(doc: PlatformDocument): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const withContent = doc.environments.filter((e) => e.kind !== 'dr' && doc.deployments.some((d) => d.environmentId === e.id));
  for (const e of withContent) {
    const next = nextEnvironment(doc, e.id);
    if (next && withContent.some((x) => x.id === next.id)) pairs.push([e.id, next.id]);
  }
  return pairs;
}

const TRACE: Record<string, { reach: Reach; type: 'impact' | 'depends' | 'focus'; title: string }> = {
  impact: { reach: 'dependents', type: 'impact', title: 'Impacto de' },
  depends: { reach: 'dependencies', type: 'depends', title: 'Dependencias de' },
  focus: { reach: 'both', type: 'focus', title: 'Entorno de' },
};

/**
 * Vista de un servicio o recurso: lo que depende de él (impacto), aquello de lo que depende o ambos. Un recurso es de un
 * entorno y un servicio que corre en uno solo se acota a él; con `environmentId` se acota a otro (p. ej. el de producción
 * para un servicio que corre en varios).
 */
export function traceView(doc: PlatformDocument, elementId: string, mode: 'impact' | 'depends' | 'focus' = 'focus', environmentId?: string): PlatformView {
  const element = indexElements(doc).get(elementId);
  if (!element || (element.kind !== 'service' && element.kind !== 'resource')) throw new Error(`No existe el servicio ni el recurso «${elementId}».`);
  const environment = environmentId === undefined ? undefined : doc.environments.find((e) => e.id === environmentId);
  if (environmentId !== undefined && !environment) throw new Error(`No existe el entorno «${environmentId}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  const scope = environmentId ?? scopeEnvironment(doc, element);
  const { reach: direction, type, title } = TRACE[mode];
  const ids = new Set([elementId, ...reach(dependencyGraph(doc, scope), elementId, direction).map((s) => s.id)]);
  const { dependencies, deployments } = scoped(doc, scope);
  const scopeName = scope ? doc.environments.find((e) => e.id === scope)?.name : undefined;
  return {
    id: `${mode}:${elementId}`,
    type,
    title: `${title} «${element.name}»${scopeName ? ` (${scopeName})` : ''}`,
    ...(scope ? { environmentId: scope } : {}),
    focusId: elementId,
    elementIds: inDocumentOrder(doc, ids),
    dependencyIds: dependencies.filter((d) => ids.has(d.sourceId) && ids.has(d.targetId)).map((d) => d.id),
    deploymentIds: deployments.filter((d) => ids.has(d.serviceId) && ids.has(d.hostId)).map((d) => d.id),
    pipelineIds: [],
  };
}

export function findView(doc: PlatformDocument, viewId?: string): PlatformView {
  const views = listViews(doc);
  if (!viewId) {
    if (views.length === 0) throw new Error('El documento no tiene vistas que exportar');
    return views[0];
  }
  const exact = views.find((v) => v.id === viewId);
  if (exact) return exact;
  if (viewId.startsWith('compare:')) return compareView(doc, viewId.slice('compare:'.length));
  const [prefix, ...rest] = viewId.split(':');
  const id = rest.join(':');
  const elements = indexElements(doc);
  if (prefix in TRACE && elements.has(id)) return traceView(doc, id, prefix as 'impact' | 'depends' | 'focus');
  const bare = elements.get(viewId);
  if (bare && (bare.kind === 'service' || bare.kind === 'resource')) return traceView(doc, viewId);
  const environment = views.find((v) => v.id === `env:${viewId}`);
  if (environment) return environment;
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'impact:<elemento>', 'depends:<elemento>', 'focus:<elemento>', 'compare:<entorno>:<entorno>'].join(', ')}.`);
}
