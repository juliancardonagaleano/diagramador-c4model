import { inheritance } from './inherit';
import { listLinks } from './links';
import { columnImpact, formatColumnRef, mappedColumns, parseColumnRef, traceLineage, type LineageDirection } from './lineage';
import { isCatalogKind, type ColumnRef, type DataAsset, type DataDocument } from './types';

export interface DataView {
  /** `lineage`, `erd`, `products`, `glossary`, `domain:<id>` o, bajo demanda, `lineage:<activo>`, `upstream:<activo>` y `downstream:<activo>`. */
  id: string;
  type: 'lineage' | 'erd' | 'domain' | 'trace' | 'products' | 'glossary';
  title: string;
  /** Activos dibujados, en el orden del documento: los del foco, los que aparecen solo como contexto y los contenedores. */
  assetIds: string[];
  /** Activos de contexto: extremos de un pipeline dibujado que quedan fuera del foco de la vista (se dibujan discontinuos). */
  contextIds: string[];
  pipelineIds: string[];
  relationIds: string[];
  /** Enlaces del catálogo dibujados (`DataLink.id`): puertos de productos, activos servidos por una API y términos enlazados. */
  linkIds: string[];
  /** Términos del glosario dibujados, dentro de su glosario. */
  termIds: string[];
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
  linkIds?: string[];
  termIds?: string[];
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
  // Los activos del otro extremo de un enlace del catálogo también se dibujan, como contexto (los términos no son activos).
  const links = new Map(listLinks(doc).map((l) => [l.id, l]));
  const known = new Set(doc.assets.map((a) => a.id));
  for (const lid of spec.linkIds ?? []) {
    for (const id of [links.get(lid)?.source, links.get(lid)?.target]) {
      if (id !== undefined && known.has(id) && !spec.focus.has(id)) {
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
    linkIds: spec.linkIds ?? [],
    termIds: spec.termIds ?? [],
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

  // Un activo que solo se modela como entidad (tiene relaciones y ningún pipeline) se ve en el ERD, no en el linaje; un
  // producto, una API o un glosario con puertos, activos servidos o términos, en el mapa de productos o el glosario.
  const links = listLinks(doc);
  const catalogLinked = new Set(links.filter((l) => l.kind !== 'defines').flatMap((l) => [l.source, l.target]));
  for (const t of doc.terms ?? []) if (t.glossaryId) catalogLinked.add(t.glossaryId);
  const onlyCatalog = (a: DataAsset): boolean => isCatalogKind(a.kind) && catalogLinked.has(a.id) && !inPipeline.has(a.id);
  const lineageFocus = new Set(doc.assets.filter((a) => inPipeline.has(a.id) || (!inRelation.has(a.id) && !onlyCatalog(a))).map((a) => a.id));
  if (lineageFocus.size > 0) {
    views.push(build(doc, { id: 'lineage', type: 'lineage', title: `Linaje de datos - ${doc.workspace.name}`, focus: lineageFocus, pipelineIds: doc.pipelines.map((p) => p.id) }));
  }

  const erdFocus = new Set(doc.assets.filter((a) => (a.columns?.length ?? 0) > 0 || inRelation.has(a.id)).map((a) => a.id));
  if (erdFocus.size > 0) {
    views.push(build(doc, { id: 'erd', type: 'erd', title: `Modelo entidad-relación - ${doc.workspace.name}`, focus: erdFocus, pipelineIds: [], relationIds: doc.relations.map((r) => r.id), withAncestors: false }));
  }

  const portLinks = links.filter((l) => l.kind !== 'defines');
  const publishers = doc.assets.filter((a) => a.kind === 'data-product' || a.kind === 'data-api');
  if (publishers.length > 0) {
    const focus = new Set([...publishers.map((a) => a.id), ...portLinks.flatMap((l) => [l.source, l.target])]);
    views.push(build(doc, { id: 'products', type: 'products', title: `Productos de datos - ${doc.workspace.name}`, focus, pipelineIds: [], linkIds: portLinks.map((l) => l.id), withAncestors: false }));
  }

  const glossaries = doc.assets.filter((a) => a.kind === 'glossary');
  if (glossaries.length > 0 || (doc.terms ?? []).length > 0) {
    const termLinks = links.filter((l) => l.kind === 'defines');
    views.push(
      build(doc, { id: 'glossary', type: 'glossary', title: `Glosario - ${doc.workspace.name}`, focus: new Set(glossaries.map((a) => a.id)), pipelineIds: [], linkIds: termLinks.map((l) => l.id), termIds: (doc.terms ?? []).map((t) => t.id), withAncestors: false }),
    );
  }

  const { domainOf } = inheritance(doc);
  for (const domain of doc.domains) {
    const focus = new Set(doc.assets.filter((a) => domainOf(a.id) === domain.id).map((a) => a.id));
    if (focus.size === 0) continue;
    const pipelineIds = doc.pipelines.filter((p) => [...p.inputs, ...p.outputs].some((id) => focus.has(id))).map((p) => p.id);
    const linkIds = portLinks.filter((l) => focus.has(l.source) || focus.has(l.target)).map((l) => l.id);
    views.push(build(doc, { id: `domain:${domain.id}`, type: 'domain', title: `Dominio - ${domain.name}`, focus, pipelineIds, linkIds }));
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
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'lineage:<activo>', 'upstream:<activo>', 'downstream:<activo>', 'column:<activo>.<columna>'].join(', ')}.`);
}
