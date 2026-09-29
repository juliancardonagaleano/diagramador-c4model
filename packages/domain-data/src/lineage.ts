import type { DataDocument } from './types';

export type LineageDirection = 'upstream' | 'downstream' | 'both';

export interface LineageStep {
  assetId: string;
  /** Pipeline que une este activo con el anterior del recorrido. */
  pipelineId: string;
  /** Saltos desde el activo de partida. */
  depth: number;
}

/** Quién produce y quién consume cada activo, según los pipelines. */
export interface LineageIndex {
  /** activo → pipelines que lo escriben. */
  producers: Map<string, string[]>;
  /** activo → pipelines que lo leen. */
  consumers: Map<string, string[]>;
}

export function indexLineage(doc: DataDocument): LineageIndex {
  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  for (const p of doc.pipelines) {
    for (const id of p.outputs) producers.set(id, [...(producers.get(id) ?? []), p.id]);
    for (const id of p.inputs) consumers.set(id, [...(consumers.get(id) ?? []), p.id]);
  }
  return { producers, consumers };
}

/**
 * Recorre el linaje desde un activo, en anchura: aguas arriba (de dónde vienen sus datos), aguas abajo (a qué activos
 * llegan) o ambos. Cada activo aparece una sola vez, con el pipeline por el que se llegó a él. Con `stopAtAnonymizing`,
 * aguas abajo no se atraviesan los pipelines que anonimizan (para seguir la difusión de datos personales).
 */
export function traceLineage(
  doc: DataDocument,
  startId: string,
  direction: LineageDirection = 'both',
  options: { stopAtAnonymizing?: boolean } = {},
): { upstream: LineageStep[]; downstream: LineageStep[] } {
  const pipelines = new Map(doc.pipelines.map((p) => [p.id, p]));
  const { producers, consumers } = indexLineage(doc);

  const walk = (next: (assetId: string) => Array<{ assetId: string; pipelineId: string }>): LineageStep[] => {
    const seen = new Set<string>([startId]);
    const steps: LineageStep[] = [];
    let frontier = [startId];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const following: string[] = [];
      for (const id of frontier) {
        for (const n of next(id)) {
          if (seen.has(n.assetId)) continue;
          seen.add(n.assetId);
          steps.push({ ...n, depth });
          following.push(n.assetId);
        }
      }
      frontier = following;
    }
    return steps;
  };

  const up = (id: string) => (producers.get(id) ?? []).flatMap((pid) => pipelines.get(pid)!.inputs.map((assetId) => ({ assetId, pipelineId: pid })));
  const down = (id: string) =>
    (consumers.get(id) ?? [])
      .filter((pid) => !(options.stopAtAnonymizing && pipelines.get(pid)!.anonymizes))
      .flatMap((pid) => pipelines.get(pid)!.outputs.map((assetId) => ({ assetId, pipelineId: pid })));
  return {
    upstream: direction === 'downstream' ? [] : walk(up),
    downstream: direction === 'upstream' ? [] : walk(down),
  };
}

/** Activos que forman parte de algún ciclo de linaje (un activo que, indirectamente, se alimenta de sí mismo). */
export function findLineageCycles(doc: DataDocument): string[][] {
  const next = new Map<string, string[]>();
  for (const p of doc.pipelines) for (const i of p.inputs) next.set(i, [...(next.get(i) ?? []), ...p.outputs]);
  const state = new Map<string, 1 | 2>();
  const cycles: string[][] = [];
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1);
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 1) {
        const cycle = [...path.slice(path.indexOf(to)), to];
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(to)) visit(to, [...path, to]);
    }
    state.set(id, 2);
  };
  for (const id of next.keys()) if (!state.has(id)) visit(id, [id]);
  return cycles;
}
