import type { ColumnMapping, ColumnRef, DataDocument } from './types';

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

// ───────────── linaje a nivel de columna ─────────────

export interface ColumnStep extends ColumnRef {
  /** Pipeline cuyo mapeo une esta columna con la anterior del recorrido. */
  pipelineId: string;
  /** Saltos desde la columna de partida. */
  depth: number;
  /** Cómo se obtiene a partir de la anterior (aguas abajo) o cómo se usa para obtener la anterior (aguas arriba). */
  transform?: string;
}

const columnKey = (r: ColumnRef): string => JSON.stringify([r.assetId, r.column]);
export const sameColumn = (a: ColumnRef, b: ColumnRef): boolean => a.assetId === b.assetId && a.column === b.column;

/** Todos los mapeos declarados, con el pipeline que los lleva. */
export function allMappings(doc: DataDocument): Array<{ pipelineId: string; mapping: ColumnMapping }> {
  return doc.pipelines.flatMap((p) => (p.mappings ?? []).map((mapping) => ({ pipelineId: p.id, mapping })));
}

/**
 * Recorre el linaje de una columna, en anchura, siguiendo los mapeos de los pipelines: aguas abajo (qué columnas se
 * calculan a partir de ella) o aguas arriba (de qué columnas sale). Cada columna aparece una sola vez.
 */
export function traceColumnLineage(doc: DataDocument, start: ColumnRef, direction: LineageDirection = 'both'): { upstream: ColumnStep[]; downstream: ColumnStep[] } {
  const mappings = allMappings(doc);
  const walk = (from: (m: ColumnMapping) => ColumnRef, to: (m: ColumnMapping) => ColumnRef): ColumnStep[] => {
    const seen = new Set<string>([columnKey(start)]);
    const steps: ColumnStep[] = [];
    let frontier = [start];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const following: ColumnRef[] = [];
      for (const ref of frontier) {
        for (const { pipelineId, mapping } of mappings) {
          if (!sameColumn(from(mapping), ref)) continue;
          const next = to(mapping);
          if (seen.has(columnKey(next))) continue;
          seen.add(columnKey(next));
          steps.push({ ...next, pipelineId, depth, ...(mapping.transform ? { transform: mapping.transform } : {}) });
          following.push(next);
        }
      }
      frontier = following;
    }
    return steps;
  };
  return {
    upstream: direction === 'downstream' ? [] : walk((m) => m.to, (m) => m.from),
    downstream: direction === 'upstream' ? [] : walk((m) => m.from, (m) => m.to),
  };
}

/** Impacto de una columna: sus dependientes y orígenes, los activos que tocan y, entre ellos, los informes y modelos afectados. */
export function columnImpact(doc: DataDocument, start: ColumnRef): { upstream: ColumnStep[]; downstream: ColumnStep[]; assetIds: string[]; consumerIds: string[] } {
  const { upstream, downstream } = traceColumnLineage(doc, start);
  const kinds = new Map(doc.assets.map((a) => [a.id, a.kind]));
  const assetIds = [...new Set([start.assetId, ...upstream.map((s) => s.assetId), ...downstream.map((s) => s.assetId)])];
  const consumerIds = [...new Set(downstream.map((s) => s.assetId))].filter((id) => kinds.get(id) === 'report' || kinds.get(id) === 'model');
  return { upstream, downstream, assetIds, consumerIds };
}

/** Columnas que participan en algún mapeo, de origen primero: las que no se calculan de otra son el punto de partida natural de una vista. */
export function mappedColumns(doc: DataDocument): ColumnRef[] {
  const mappings = allMappings(doc).map((x) => x.mapping);
  const targets = new Set(mappings.map((m) => columnKey(m.to)));
  const seen = new Set<string>();
  const sources: ColumnRef[] = [];
  for (const m of mappings) {
    if (targets.has(columnKey(m.from)) || seen.has(columnKey(m.from))) continue;
    seen.add(columnKey(m.from));
    sources.push(m.from);
  }
  return sources;
}

/** `activo.columna` → referencia; el id del activo es el prefijo más largo que existe (los ids pueden llevar puntos). */
export function parseColumnRef(text: string, assetIds: Iterable<string>): ColumnRef | undefined {
  const value = text.trim();
  const ids = new Set(assetIds);
  for (let i = value.lastIndexOf('.'); i > 0; i = value.lastIndexOf('.', i - 1)) {
    const assetId = value.slice(0, i);
    const column = value.slice(i + 1).trim();
    if (ids.has(assetId) && column) return { assetId, column };
  }
  return undefined;
}

export const formatColumnRef = (r: ColumnRef): string => `${r.assetId}.${r.column}`;
