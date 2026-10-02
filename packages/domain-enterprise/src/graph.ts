import { dependencyEnds, type Capability, type EnterpriseDocument } from './types';

export interface DependencyGraph {
  /** Elemento → aquello en lo que se apoya (aplicación → tecnología, capacidad → aplicación que la soporta…). */
  leansOn: Map<string, string[]>;
  /** Elemento → los que se apoyan en él. */
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

/** Grafo de dependencias (ver `dependencyEnds`: el sentido en que se dibujan las relaciones, salvo flujo y disparo). */
export function dependencyGraph(doc: EnterpriseDocument): DependencyGraph {
  const leansOn = new Map<string, string[]>();
  const leanedBy = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => void map.set(key, [...(map.get(key) ?? []), value]);
  for (const r of doc.relations) {
    const { from, to } = dependencyEnds(r);
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

/** Responsable efectivo: el declarado o, en una capacidad, el de la capacidad padre más cercana que lo declare. */
export function ownership(doc: EnterpriseDocument): { ownerOf(id: string): string | undefined } {
  const capabilities = new Map<string, Capability>(doc.capabilities.map((c) => [c.id, c]));
  const direct = new Map<string, string | undefined>();
  for (const list of [doc.capabilities, doc.processes, doc.applications, doc.technologies]) for (const x of list) direct.set(x.id, x.ownerId);
  return {
    ownerOf(id) {
      const seen = new Set<string>();
      for (let c = capabilities.get(id); c && !seen.has(c.id); c = c.parentId ? capabilities.get(c.parentId) : undefined) {
        if (c.ownerId) return c.ownerId;
        seen.add(c.id);
      }
      return capabilities.has(id) ? undefined : direct.get(id);
    },
  };
}

/** Ids de una unidad y de todas las que cuelgan de ella. */
export function unitTree(doc: EnterpriseDocument, unitId: string): Set<string> {
  const ids = new Set([unitId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of doc.units) {
      if (u.parentId && ids.has(u.parentId) && !ids.has(u.id)) {
        ids.add(u.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Aplicaciones que soportan cada capacidad: las que la soportan directamente y las que soportan un proceso que la
 * realiza. Con `rollup`, una capacidad con hijas suma además las aplicaciones de todas sus descendientes.
 */
export function applicationsByCapability(doc: EnterpriseDocument, options: { rollup?: boolean } = {}): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>(doc.capabilities.map((c) => [c.id, new Set<string>()]));
  const processApps = new Map<string, Set<string>>();
  for (const r of doc.relations) {
    if (r.kind !== 'supports') continue;
    if (direct.has(r.targetId)) direct.get(r.targetId)!.add(r.sourceId);
    else processApps.set(r.targetId, (processApps.get(r.targetId) ?? new Set()).add(r.sourceId));
  }
  for (const r of doc.relations) {
    if (r.kind === 'realizes') for (const app of processApps.get(r.sourceId) ?? []) direct.get(r.targetId)?.add(app);
  }
  if (!options.rollup) return direct;
  const children = capabilityChildren(doc);
  const total = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const known = total.get(id);
    if (known) return known;
    const all = new Set(direct.get(id));
    total.set(id, all);
    for (const child of children.get(id) ?? []) for (const app of collect(child.id)) all.add(app);
    return all;
  };
  for (const c of doc.capabilities) collect(c.id);
  return total;
}

/** Capacidad → sus hijas directas, en el orden del documento. */
export function capabilityChildren(doc: EnterpriseDocument): Map<string | undefined, Capability[]> {
  const children = new Map<string | undefined, Capability[]>();
  for (const c of doc.capabilities) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  return children;
}
