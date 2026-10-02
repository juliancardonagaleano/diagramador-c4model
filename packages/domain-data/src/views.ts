import { inheritance } from './inherit';
import { traceLineage, type LineageDirection } from './lineage';
import type { DataDocument } from './types';

export interface DataView {
  /** `lineage`, `erd`, `domain:<id>` o, bajo demanda, `lineage:<activo>`, `upstream:<activo>` y `downstream:<activo>`. */
  id: string;
  type: 'lineage' | 'erd' | 'domain' | 'trace';
  title: string;
  /** Activos dibujados, en el orden del documento: los del foco, los que aparecen solo como contexto y los contenedores. */
  assetIds: string[];
  /** Activos de contexto: extremos de un pipeline dibujado que quedan fuera del foco de la vista (se dibujan discontinuos). */
  contextIds: string[];
  pipelineIds: string[];
  relationIds: string[];
}

interface Spec {
  id: string;
  type: DataView['type'];
  title: string;
  focus: Set<string>;
  pipelineIds: string[];
  relationIds?: string[];
  /** Arrastrar los contenedores de los activos dibujados (agrupaciones). El ERD dibuja fichas sueltas. */
  withAncestors?: boolean;
}

function build(doc: DataDocument, spec: Spec): DataView {
  const parents = new Map(doc.assets.map((a) => [a.id, a.parentId]));
  const pipelines = new Map(doc.pipelines.map((p) => [p.id, p]));
  const drawn = new Set(spec.focus);
  const context = new Set<string>();
  for (const pid of spec.pipelineIds) {
    for (const id of [...pipelines.get(pid)!.inputs, ...pipelines.get(pid)!.outputs]) {
      if (!spec.focus.has(id)) {
        drawn.add(id);
        context.add(id);
      }
    }
  }
  // Un activo dibujado arrastra a sus contenedores, para que la vista conserve sus agrupaciones.
  if (spec.withAncestors !== false) {
    for (const id of [...drawn]) {
      for (let parent = parents.get(id); parent && !drawn.has(parent); parent = parents.get(parent)) drawn.add(parent);
    }
  }
  return {
    id: spec.id,
    type: spec.type,
    title: spec.title,
    assetIds: doc.assets.filter((a) => drawn.has(a.id)).map((a) => a.id),
    contextIds: doc.assets.filter((a) => context.has(a.id) && !spec.focus.has(a.id)).map((a) => a.id),
    pipelineIds: spec.pipelineIds,
    relationIds: spec.relationIds ?? [],
  };
}

/**
 * Vistas derivadas del documento: el linaje completo, el modelo entidad-relación y una por dominio. Solo se listan las
 * que tienen contenido. El linaje de un activo concreto se pide por su id (ver `findView`).
 */
export function listViews(doc: DataDocument): DataView[] {
  const views: DataView[] = [];
  const inPipeline = new Set(doc.pipelines.flatMap((p) => [...p.inputs, ...p.outputs]));
  const inRelation = new Set(doc.relations.flatMap((r) => [r.sourceId, r.targetId]));

  // Un activo que solo se modela como entidad (tiene relaciones y ningún pipeline) se ve en el ERD, no en el linaje.
  const lineageFocus = new Set(doc.assets.filter((a) => inPipeline.has(a.id) || !inRelation.has(a.id)).map((a) => a.id));
  if (lineageFocus.size > 0) {
    views.push(build(doc, { id: 'lineage', type: 'lineage', title: `Linaje de datos - ${doc.workspace.name}`, focus: lineageFocus, pipelineIds: doc.pipelines.map((p) => p.id) }));
  }

  const erdFocus = new Set(doc.assets.filter((a) => (a.columns?.length ?? 0) > 0 || inRelation.has(a.id)).map((a) => a.id));
  if (erdFocus.size > 0) {
    views.push(build(doc, { id: 'erd', type: 'erd', title: `Modelo entidad-relación - ${doc.workspace.name}`, focus: erdFocus, pipelineIds: [], relationIds: doc.relations.map((r) => r.id), withAncestors: false }));
  }

  const { domainOf } = inheritance(doc);
  for (const domain of doc.domains) {
    const focus = new Set(doc.assets.filter((a) => domainOf(a.id) === domain.id).map((a) => a.id));
    if (focus.size === 0) continue;
    const pipelineIds = doc.pipelines.filter((p) => [...p.inputs, ...p.outputs].some((id) => focus.has(id))).map((p) => p.id);
    views.push(build(doc, { id: `domain:${domain.id}`, type: 'domain', title: `Dominio - ${domain.name}`, focus, pipelineIds }));
  }
  return views;
}

const TRACE_PREFIX: Record<string, LineageDirection> = { lineage: 'both', upstream: 'upstream', downstream: 'downstream' };
const TRACE_TITLE: Record<LineageDirection, string> = { both: 'Linaje de', upstream: 'Origen de', downstream: 'Impacto de' };

/** Linaje de un activo: todo lo que lo alimenta (aguas arriba) y/o todo lo que depende de él (aguas abajo). */
export function traceView(doc: DataDocument, assetId: string, direction: LineageDirection = 'both'): DataView {
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`No existe el activo «${assetId}».`);
  const { upstream, downstream } = traceLineage(doc, assetId, direction);
  const steps = [...upstream, ...downstream];
  const prefix = direction === 'both' ? 'lineage' : direction;
  return build(doc, {
    id: `${prefix}:${assetId}`,
    type: 'trace',
    title: `${TRACE_TITLE[direction]} «${asset.name}»`,
    focus: new Set([assetId, ...steps.map((s) => s.assetId)]),
    pipelineIds: [...new Set(steps.map((s) => s.pipelineId))],
  });
}

/** Mapas de calor: el linaje coloreado por clasificación o por datos personales. Solo existen en el lienzo; las exportaciones los dibujan como el linaje. */
export const HEAT_VIEWS = [
  { id: 'calor:clasificacion', title: 'Mapa de calor: clasificación' },
  { id: 'calor:pii', title: 'Mapa de calor: datos personales' },
] as const;

export function heatViews(doc: DataDocument): Array<{ id: string; title: string }> {
  return doc.assets.some((a) => a.classification || a.pii || a.columns?.some((c) => c.pii)) ? HEAT_VIEWS.map((v) => ({ ...v })) : [];
}

export function findView(doc: DataDocument, viewId?: string): DataView {
  const views = listViews(doc);
  const heat = HEAT_VIEWS.find((v) => v.id === viewId);
  if (heat) {
    const base = views.find((v) => v.type === 'lineage') ?? views[0];
    if (base) return { ...base, id: heat.id, title: heat.title };
  }
  if (!viewId) {
    if (views.length === 0) throw new Error('El documento no tiene vistas que exportar');
    return views[0];
  }
  const exact = views.find((v) => v.id === viewId);
  if (exact) return exact;
  const [prefix, ...rest] = viewId.split(':');
  const id = rest.join(':');
  if (prefix in TRACE_PREFIX && doc.assets.some((a) => a.id === id)) return traceView(doc, id, TRACE_PREFIX[prefix]);
  if (doc.assets.some((a) => a.id === viewId)) return traceView(doc, viewId);
  const domain = views.find((v) => v.id === `domain:${viewId}`);
  if (domain) return domain;
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'lineage:<activo>', 'upstream:<activo>', 'downstream:<activo>'].join(', ')}.`);
}
