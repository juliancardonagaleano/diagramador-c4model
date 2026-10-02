import { classificationRank, sensitive, trustOf, trustRank, type Asset, type Classification, type Flow, type SecurityDocument, type Zone } from './types';

export interface FlowGraph {
  /** Activo → activos a los que envía datos. */
  sendsTo: Map<string, string[]>;
  /** Activo → activos de los que recibe datos. */
  receivesFrom: Map<string, string[]>;
}

/** `downstream` = hacia dónde pueden ir los datos (alcance si se compromete); `upstream` = de dónde pueden venir; `both`, las dos. */
export type Reach = 'downstream' | 'upstream' | 'both';

export interface ReachStep {
  id: string;
  /** Saltos desde el activo de partida (1 = vecino directo). */
  depth: number;
  /** Activo desde el que se llegó a este (el de partida, si es un vecino directo). */
  via: string;
}

/** Grafo de flujos de datos entre activos; cada flujo va del origen al destino. */
export function flowGraph(doc: SecurityDocument): FlowGraph {
  const sendsTo = new Map<string, string[]>();
  const receivesFrom = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) map.set(key, [...list, value]);
  };
  for (const f of doc.flows) {
    push(sendsTo, f.sourceId, f.targetId);
    push(receivesFrom, f.targetId, f.sourceId);
  }
  return { sendsTo, receivesFrom };
}

/** Recorre el grafo a partir de un activo (sin incluirlo). */
export function reach(graph: FlowGraph, startId: string, direction: Reach): ReachStep[] {
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
  if (direction !== 'upstream') walk(graph.sendsTo);
  if (direction !== 'downstream') {
    seen.clear();
    seen.add(startId);
    if (direction === 'both') for (const s of steps) seen.add(s.id);
    walk(graph.receivesFrom);
  }
  return steps;
}

/** La zona y sus ancestros, de la más interna a la más externa. */
export function zoneChain(doc: SecurityDocument, zoneId: string | undefined): Zone[] {
  const chain: Zone[] = [];
  for (let id = zoneId; id !== undefined && !chain.some((z) => z.id === id); id = chain[chain.length - 1]?.parentId) {
    const zone = doc.zones.find((z) => z.id === id);
    if (!zone) break;
    chain.push(zone);
  }
  return chain;
}

export const zoneOf = (doc: SecurityDocument, asset: Asset): Zone | undefined => doc.zones.find((z) => z.id === asset.zoneId);

/** `ingress` = el flujo entra a una zona más confiable; `egress` = sale hacia una menos confiable; `lateral` = entre zonas de igual confianza. */
export type CrossingDirection = 'ingress' | 'egress' | 'lateral';

export interface Crossing {
  flow: Flow;
  from: Zone;
  to: Zone;
  direction: CrossingDirection;
  /** Diferencia de niveles de confianza (siempre >= 0). */
  gap: number;
}

/** Flujos que cruzan una frontera de confianza, es decir, unen activos de zonas distintas. */
export function crossings(doc: SecurityDocument): Crossing[] {
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const zones = new Map(doc.zones.map((z) => [z.id, z]));
  const result: Crossing[] = [];
  for (const flow of doc.flows) {
    const [source, target] = [assets.get(flow.sourceId), assets.get(flow.targetId)];
    const [from, to] = [source && zones.get(source.zoneId), target && zones.get(target.zoneId)];
    if (!from || !to || from.id === to.id) continue;
    const delta = trustRank(trustOf(to)) - trustRank(trustOf(from));
    result.push({ flow, from, to, direction: delta > 0 ? 'ingress' : delta < 0 ? 'egress' : 'lateral', gap: Math.abs(delta) });
  }
  return result;
}

/** Clasificación más alta de los datos que toca un activo: la suya o la de sus flujos. */
export function effectiveClassification(doc: SecurityDocument, asset: Asset): Classification | undefined {
  const own = [asset.classification, ...doc.flows.filter((f) => f.sourceId === asset.id || f.targetId === asset.id).map((f) => f.classification)].filter((c): c is Classification => c !== undefined);
  return own.sort((a, b) => classificationRank(b) - classificationRank(a))[0];
}

/** Activos que interesa proteger: los que guardan o tratan datos sensibles y los de una zona restringida. */
export function isCrownJewel(doc: SecurityDocument, asset: Asset): boolean {
  if (asset.kind === 'actor' || asset.kind === 'external' || asset.kind === 'channel') return false;
  if (asset.kind === 'secret') return true;
  const zone = zoneOf(doc, asset);
  return sensitive(asset.classification) || (zone !== undefined && trustOf(zone) === 'restricted');
}

/** Flujos por los que se entra desde una zona no confiable: la superficie de ataque. */
export function entryPoints(doc: SecurityDocument): Crossing[] {
  return crossings(doc).filter((c) => trustOf(c.from) === 'untrusted' && c.direction === 'ingress');
}

export interface AttackPath {
  /** Activo de una zona no confiable donde empieza. */
  sourceId: string;
  /** Activo que se quiere proteger. */
  targetId: string;
  /** Activos del camino, del origen al destino (ambos incluidos). */
  assetIds: string[];
  /** Flujos recorridos, en orden. */
  flowIds: string[];
  /** Fronteras de confianza que cruza. */
  boundaries: number;
}

/**
 * Caminos más cortos desde los activos de zonas no confiables hasta los que interesa proteger, siguiendo los flujos de
 * datos. Un camino con pocas fronteras y sin controles intermedios es lo primero que hay que revisar.
 */
export function attackPaths(doc: SecurityDocument): AttackPath[] {
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const zones = new Map(doc.zones.map((z) => [z.id, z]));
  const outgoing = new Map<string, Flow[]>();
  for (const f of doc.flows) outgoing.set(f.sourceId, [...(outgoing.get(f.sourceId) ?? []), f]);
  const untrusted = (a: Asset): boolean => trustOf(zones.get(a.zoneId) ?? { id: '', name: '' }) === 'untrusted';
  const targets = doc.assets.filter((a) => isCrownJewel(doc, a) && !untrusted(a));
  const best = new Map<string, AttackPath>();

  for (const origin of doc.assets.filter(untrusted)) {
    const via = new Map<string, Flow | null>([[origin.id, null]]);
    for (let frontier = [origin.id]; frontier.length > 0; ) {
      const following: string[] = [];
      for (const id of frontier) {
        for (const f of outgoing.get(id) ?? []) {
          if (via.has(f.targetId)) continue;
          via.set(f.targetId, f);
          following.push(f.targetId);
        }
      }
      frontier = following;
    }
    for (const target of targets) {
      if (!via.has(target.id)) continue;
      const flowIds: string[] = [];
      const assetIds = [target.id];
      for (let f = via.get(target.id); f; f = via.get(f.sourceId)) {
        flowIds.unshift(f.id);
        assetIds.unshift(f.sourceId);
      }
      const boundaries = flowIds.filter((fid) => {
        const f = doc.flows.find((x) => x.id === fid)!;
        return assets.get(f.sourceId)?.zoneId !== assets.get(f.targetId)?.zoneId;
      }).length;
      const path: AttackPath = { sourceId: origin.id, targetId: target.id, assetIds, flowIds, boundaries };
      const known = best.get(target.id);
      if (!known || path.flowIds.length < known.flowIds.length) best.set(target.id, path);
    }
  }
  return targets.map((t) => best.get(t.id)).filter((p): p is AttackPath => p !== undefined);
}
