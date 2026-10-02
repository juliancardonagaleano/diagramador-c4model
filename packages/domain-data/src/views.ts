import { inheritance } from './inherit';
import { columnImpact, formatColumnRef, mappedColumns, parseColumnRef, traceLineage, type LineageDirection } from './lineage';
import type { ViewRef } from '@iark/kernel';
import type { ErdNotation } from './relations';
import type { ColumnRef, DataDocument } from './types';

export interface DataView {
  /** `lineage`, `erd`, `erd:uml`, `domain:<id>` o, bajo demanda, `lineage:<activo>`, `upstream:<activo>` y `downstream:<activo>`. */
  id: string;
  type: 'lineage' | 'erd' | 'domain' | 'trace';
  title: string;
  /** Activos dibujados, en el orden del documento: los del foco, los que aparecen solo como contexto y los contenedores. */
  assetIds: string[];
  /** Activos de contexto: extremos de un pipeline dibujado que quedan fuera del foco de la vista (se dibujan discontinuos). */
  contextIds: string[];
  pipelineIds: string[];
  relationIds: string[];
  /** Solo en el modelo entidad-relación: pata de gallo (`erd`) o UML con multiplicidades (`erd:uml`). */
  notation?: ErdNotation;
  /** Solo en las vistas de impacto de columna (`column:<activo>.<columna>`): columna de partida y columnas afectadas de cada activo, de origen a destino. */
  column?: { start: ColumnRef; byAsset: Record<string, string[]> };
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
  notation?: ErdNotation;
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
    ...(spec.notation ? { notation: spec.notation } : {}),
  };
}

/**
 * Vistas derivadas del documento: el linaje completo, el modelo entidad-relación y una por dominio. Solo se listan las
 * que tienen contenido. El linaje de un activo concreto se pide por su id (ver `findView`). El modelo entidad-relación con
 * notación UML (`erd:uml`) es una variante del `erd` y no se lista aquí: ver `erdUmlView` y `viewRefs`.
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
    views.push(build(doc, { id: 'erd', type: 'erd', title: `Modelo entidad-relación - ${doc.workspace.name}`, focus: erdFocus, pipelineIds: [], relationIds: doc.relations.map((r) => r.id), withAncestors: false, notation: 'crowfoot' }));
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

/** Vista de impacto de una columna: de qué columnas sale (aguas arriba) y qué columnas, activos e informes dependen de ella (aguas abajo). */
export function columnView(doc: DataDocument, start: ColumnRef): DataView {
  const asset = doc.assets.find((a) => a.id === start.assetId);
  if (!asset) throw new Error(`No existe el activo «${start.assetId}».`);
  const impact = columnImpact(doc, start);
  const mapped = impact.upstream.length + impact.downstream.length > 0;
  if (!mapped && !(asset.columns ?? []).some((c) => c.name === start.column)) throw new Error(`El activo «${asset.name}» no tiene la columna «${start.column}».`);
  const byAsset: Record<string, string[]> = { [start.assetId]: [start.column] };
  for (const s of [...impact.upstream, ...impact.downstream]) if (!(byAsset[s.assetId] ?? []).includes(s.column)) byAsset[s.assetId] = [...(byAsset[s.assetId] ?? []), s.column];
  const view = build(doc, {
    id: `column:${formatColumnRef(start)}`,
    type: 'trace',
    title: `Impacto de la columna «${asset.name}.${start.column}»`,
    focus: new Set(impact.assetIds),
    pipelineIds: [...new Set([...impact.upstream, ...impact.downstream].map((s) => s.pipelineId))],
  });
  return { ...view, column: { start, byAsset } };
}

/** Vistas de impacto de columna que ofrece el documento: una por columna de origen de algún mapeo (vacío si no hay mapeos). */
export function columnViews(doc: DataDocument): Array<{ id: string; title: string }> {
  const names = new Map(doc.assets.map((a) => [a.id, a.name]));
  return mappedColumns(doc).map((c) => ({ id: `column:${formatColumnRef(c)}`, title: `Impacto de la columna ${names.get(c.assetId) ?? c.assetId}.${c.column}` }));
}

/** Mapas de calor: el linaje coloreado por clasificación o por datos personales. Solo existen en el lienzo; las exportaciones los dibujan como el linaje. */
export const HEAT_VIEWS = [
  { id: 'calor:clasificacion', title: 'Mapa de calor: clasificación' },
  { id: 'calor:pii', title: 'Mapa de calor: datos personales' },
] as const;

export function heatViews(doc: DataDocument): Array<{ id: string; title: string }> {
  return doc.assets.some((a) => a.classification || a.pii || a.columns?.some((c) => c.pii)) ? HEAT_VIEWS.map((v) => ({ ...v })) : [];
}

/** Variante del modelo entidad-relación con la notación UML: las multiplicidades (`1`, `0..*`) escritas junto a cada extremo. */
export const ERD_UML_VIEW_ID = 'erd:uml';

/** El modelo entidad-relación en notación UML, o `undefined` si el documento no tiene modelo entidad-relación. */
export function erdUmlView(doc: DataDocument): DataView | undefined {
  const erd = listViews(doc).find((v) => v.type === 'erd');
  return erd && { ...erd, id: ERD_UML_VIEW_ID, title: `Modelo entidad-relación (UML) - ${doc.workspace.name}`, notation: 'uml' };
}

/** Las vistas que se exportan por lotes (una página por vista en draw.io): las listadas y, tras el modelo entidad-relación, su variante UML. */
export function exportViews(doc: DataDocument): DataView[] {
  const uml = erdUmlView(doc);
  return listViews(doc).flatMap((v) => (v.type === 'erd' && uml ? [v, uml] : [v]));
}

/** Título del selector de variantes de una vista del lienzo para el modelo entidad-relación. */
const NOTATION_LABEL = 'Notación';

/**
 * Vistas que ofrece el módulo en el lienzo: las derivadas y, tras el modelo entidad-relación, su variante UML (el lienzo la
 * muestra en el selector «Notación», no en «Vista»), los mapas de calor y las vistas de impacto de columna.
 */
export function viewRefs(doc: DataDocument): ViewRef[] {
  const uml = erdUmlView(doc);
  const derived = listViews(doc).flatMap((v): ViewRef[] =>
    v.type === 'erd' && uml
      ? [
          { id: v.id, title: v.title, variantLabel: 'Pata de gallo', variantsLabel: NOTATION_LABEL },
          { id: uml.id, title: uml.title, variantOf: v.id, variantLabel: 'UML', variantsLabel: NOTATION_LABEL },
        ]
      : [{ id: v.id, title: v.title }],
  );
  return [...derived, ...heatViews(doc), ...columnViews(doc)].map((v) => ({ ...v }));
}

export function findView(doc: DataDocument, viewId?: string): DataView {
  const views = listViews(doc);
  if (viewId === ERD_UML_VIEW_ID) {
    const uml = erdUmlView(doc);
    if (uml) return uml;
  }
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
  if (viewId.startsWith('column:')) {
    const ref = parseColumnRef(viewId.slice('column:'.length), doc.assets.map((a) => a.id));
    if (!ref) throw new Error(`La vista «${viewId}» no indica un activo y una columna existentes (column:<activo>.<columna>).`);
    return columnView(doc, ref);
  }
  const [prefix, ...rest] = viewId.split(':');
  const id = rest.join(':');
  if (prefix in TRACE_PREFIX && doc.assets.some((a) => a.id === id)) return traceView(doc, id, TRACE_PREFIX[prefix]);
  if (doc.assets.some((a) => a.id === viewId)) return traceView(doc, viewId);
  const domain = views.find((v) => v.id === `domain:${viewId}`);
  if (domain) return domain;
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...exportViews(doc).map((v) => v.id), 'lineage:<activo>', 'upstream:<activo>', 'downstream:<activo>', 'column:<activo>.<columna>'].join(', ')}.`);
}
