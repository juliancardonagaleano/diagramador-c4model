import { isHost, type Deployment, type Element, type PlatformDocument } from './types';

export interface DependencyGraph {
  /** Elemento → aquello de lo que depende (servicio → otro servicio, recurso o el anfitrión donde se despliega). */
  leansOn: Map<string, string[]>;
  /** Elemento → los que dependen de él. */
  leanedBy: Map<string, string[]>;
}

export type Reach = 'dependents' | 'dependencies' | 'both';

export interface ReachStep {
  id: string;
  /** Saltos desde el elemento de partida (1 = vecino directo). */
  depth: number;
  /** Elemento desde el que se llegó a este (el de partida, si es un vecino directo). */
  via: string;
}

/** Entornos en los que se despliega un servicio, en el orden del documento. */
export function deploymentEnvironments(doc: PlatformDocument, serviceId: string): string[] {
  return doc.environments.filter((e) => doc.deployments.some((d) => d.serviceId === serviceId && d.environmentId === e.id)).map((e) => e.id);
}

/** Entorno al que pertenece un elemento: el de un recurso o una red; el de un servicio, solo si se despliega en uno. */
export function scopeEnvironment(doc: PlatformDocument, element: Element): string | undefined {
  if (element.kind === 'resource' || element.kind === 'network') return (element.item as { environmentId: string }).environmentId;
  if (element.kind === 'service') {
    const envs = deploymentEnvironments(doc, element.id);
    return envs.length === 1 ? envs[0] : undefined;
  }
  return undefined;
}

/** ¿Está el elemento (servicio o recurso) presente en el entorno? Un servicio externo lo está siempre. */
function presentIn(doc: PlatformDocument, id: string, environmentId: string): boolean {
  const resource = doc.resources.find((r) => r.id === id);
  if (resource) return resource.environmentId === environmentId;
  const service = doc.services.find((s) => s.id === id);
  if (!service) return false;
  return service.external === true || doc.deployments.some((d) => d.serviceId === id && d.environmentId === environmentId);
}

/** Dependencias y despliegues que quedan dentro de un entorno (todas, si no se indica). */
export function scoped(doc: PlatformDocument, environmentId?: string): { dependencies: PlatformDocument['dependencies']; deployments: Deployment[] } {
  if (!environmentId) return { dependencies: doc.dependencies, deployments: doc.deployments };
  return {
    dependencies: doc.dependencies.filter((d) => presentIn(doc, d.sourceId, environmentId) && presentIn(doc, d.targetId, environmentId)),
    deployments: doc.deployments.filter((d) => d.environmentId === environmentId),
  };
}

/**
 * Grafo de dependencias: cada dependencia va del origen al destino y cada despliegue, del servicio a su anfitrión (el
 * servicio depende del clúster o la máquina donde corre). Con un entorno, solo entra lo que hay en él.
 */
export function dependencyGraph(doc: PlatformDocument, environmentId?: string): DependencyGraph {
  const leansOn = new Map<string, string[]>();
  const leanedBy = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) map.set(key, [...list, value]);
  };
  const { dependencies, deployments } = scoped(doc, environmentId);
  const edges = [...dependencies.map((d) => [d.sourceId, d.targetId] as const), ...deployments.map((d) => [d.serviceId, d.hostId] as const)];
  for (const [from, to] of edges) {
    push(leansOn, from, to);
    push(leanedBy, to, from);
  }
  return { leansOn, leanedBy };
}

/** Recorre el grafo a partir de un elemento (sin incluirlo): de qué depende, qué depende de él o ambos. */
export function reach(graph: DependencyGraph, startId: string, direction: Reach): ReachStep[] {
  const steps: ReachStep[] = [];
  const seen = new Set([startId]);
  const walk = (next: Map<string, string[]>): void => {
    let frontier = [startId];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const following: string[] = [];
      for (const id of frontier) {
        for (const n of next.get(id) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          steps.push({ id: n, depth, via: id });
          following.push(n);
        }
      }
      frontier = following;
    }
  };
  if (direction !== 'dependencies') walk(graph.leanedBy);
  if (direction !== 'dependents') {
    seen.clear();
    seen.add(startId);
    if (direction === 'both') for (const s of steps) seen.add(s.id);
    walk(graph.leansOn);
  }
  return steps;
}

/** Servicios cuyas llamadas síncronas (`calls`) forman un ciclo, como lista de ids en el orden del ciclo (un ciclo por componente). */
export function callCycles(doc: PlatformDocument): string[][] {
  const services = new Set(doc.services.map((s) => s.id));
  const next = new Map<string, string[]>();
  for (const d of doc.dependencies) {
    if (d.kind === 'calls' && services.has(d.sourceId) && services.has(d.targetId)) next.set(d.sourceId, [...(next.get(d.sourceId) ?? []), d.targetId]);
  }
  const cycles: string[][] = [];
  const done = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    const at = path.indexOf(id);
    if (at >= 0) {
      const cycle = path.slice(at);
      if (!cycles.some((c) => c.length === cycle.length && cycle.every((x) => c.includes(x)))) cycles.push(cycle);
      return;
    }
    if (done.has(id)) return;
    for (const n of next.get(id) ?? []) visit(n, [...path, id]);
    done.add(id);
  };
  for (const s of doc.services) visit(s.id, []);
  return cycles;
}

/** Recursos que son anfitriones (clústeres y máquinas virtuales), por id. */
export function hostsById(doc: PlatformDocument): Map<string, PlatformDocument['resources'][number]> {
  return new Map(doc.resources.filter(isHost).map((r) => [r.id, r]));
}
