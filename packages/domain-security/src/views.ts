import { entryPoints, flowGraph, reach, type Reach } from './graph';
import { CONTROL_STANDARDS, STANDARD_LABELS, indexElements, type ControlStandard, type SecurityDocument } from './types';

export interface SecurityView {
  /** `dfd`, `threats`, `heatmap` (y `heatmap:residual`), `standards` (y `standards:<estándar>`), `surface` o, bajo demanda, `blast:<id>`, `exposure:<id>` y `focus:<id>`. */
  id: string;
  type: 'dfd' | 'threats' | 'blast' | 'exposure' | 'focus' | 'heatmap' | 'standards' | 'surface';
  /** Matriz de calor: dónde se coloca cada amenaza, por su riesgo inherente o por el residual tras los controles implementados. */
  mode?: 'inherent' | 'residual';
  /** Cobertura de estándares: el catálogo de la vista; si falta, todos. */
  standard?: ControlStandard;
  /** Superficie de ataque: saltos desde la zona no confiable de cada activo alcanzado (0 = origen no confiable, 1 = expuesto directamente). */
  depths?: Record<string, number>;
  /** Superficie de ataque: flujos por los que se entra desde una zona no confiable. */
  entryFlowIds?: string[];
  title: string;
  /** Activo de partida de las vistas de traza. */
  focusId?: string;
  /** Activos dibujados, en el orden del documento. */
  assetIds: string[];
  flowIds: string[];
  /** Amenazas y controles: solo la vista de amenazas los dibuja. */
  threatIds: string[];
  controlIds: string[];
}

function dfd(doc: SecurityDocument): SecurityView {
  return {
    id: 'dfd',
    type: 'dfd',
    title: `Flujos de datos y fronteras de confianza - ${doc.workspace.name}`,
    assetIds: doc.assets.map((a) => a.id),
    flowIds: doc.flows.map((f) => f.id),
    threatIds: [],
    controlIds: [],
  };
}

function threatsView(doc: SecurityDocument): SecurityView {
  const targets = new Set(doc.threats.map((t) => t.targetId));
  const controls = new Set(doc.threats.flatMap((t) => t.controlIds ?? []));
  return {
    id: 'threats',
    type: 'threats',
    title: `Modelo de amenazas - ${doc.workspace.name}`,
    assetIds: doc.assets.filter((a) => targets.has(a.id)).map((a) => a.id),
    flowIds: doc.flows.filter((f) => targets.has(f.id)).map((f) => f.id),
    threatIds: doc.threats.map((t) => t.id),
    controlIds: doc.controls.filter((c) => controls.has(c.id)).map((c) => c.id),
  };
}

/** Matriz de calor 3 × 4 (probabilidad × impacto): las amenazas, cada una en su celda. */
function heatmapView(doc: SecurityDocument, mode: 'inherent' | 'residual'): SecurityView {
  return {
    id: mode === 'inherent' ? 'heatmap' : 'heatmap:residual',
    type: 'heatmap',
    mode,
    title: `Matriz de calor${mode === 'residual' ? ' (riesgo residual)' : ''} - ${doc.workspace.name}`,
    assetIds: [],
    flowIds: [],
    threatIds: doc.threats.map((t) => t.id),
    controlIds: [],
  };
}

/** Estándares a los que remite algún control, en el orden del catálogo. */
export const standardsInUse = (doc: SecurityDocument): ControlStandard[] => CONTROL_STANDARDS.filter((s) => doc.controls.some((c) => c.standard === s));

/** Cobertura de estándares: los controles agrupados por catálogo y las amenazas que cubren (o no). */
function standardsView(doc: SecurityDocument, standard?: ControlStandard): SecurityView {
  return {
    id: standard ? `standards:${standard}` : 'standards',
    type: 'standards',
    ...(standard ? { standard } : {}),
    title: `Cobertura de estándares${standard ? ` (${STANDARD_LABELS[standard]})` : ''} - ${doc.workspace.name}`,
    assetIds: [],
    flowIds: [],
    threatIds: doc.threats.map((t) => t.id),
    controlIds: doc.controls.filter((c) => (standard ? c.standard === standard : c.standard !== undefined)).map((c) => c.id),
  };
}

/**
 * Superficie de ataque: los activos a los que se entra desde una zona no confiable (expuestos) y el radio de alcance de lo
 * que se compromete desde ellos (saltos por los flujos de datos), con los flujos de entrada.
 */
export function surfaceDepths(doc: SecurityDocument): Record<string, number> {
  const entries = entryPoints(doc);
  const graph = flowGraph(doc);
  const depths: Record<string, number> = {};
  for (const c of entries) depths[c.flow.sourceId] = 0;
  const exposed = [...new Set(entries.map((c) => c.flow.targetId))];
  for (const id of exposed) depths[id] = 1;
  for (const id of exposed) {
    for (const step of reach(graph, id, 'downstream')) {
      const depth = step.depth + 1;
      if (depths[step.id] === undefined || (depths[step.id] > 1 && depth < depths[step.id])) depths[step.id] = depth;
    }
  }
  return depths;
}

function surfaceView(doc: SecurityDocument): SecurityView {
  const entries = entryPoints(doc);
  const depths = surfaceDepths(doc);
  const ids = new Set(Object.keys(depths));
  return {
    id: 'surface',
    type: 'surface',
    title: `Superficie de ataque - ${doc.workspace.name}`,
    assetIds: doc.assets.filter((a) => ids.has(a.id)).map((a) => a.id),
    flowIds: doc.flows.filter((f) => ids.has(f.sourceId) && ids.has(f.targetId)).map((f) => f.id),
    threatIds: [],
    controlIds: [],
    depths,
    entryFlowIds: entries.map((c) => c.flow.id),
  };
}

/**
 * Vistas derivadas del documento: los flujos de datos con sus zonas de confianza y el modelo de amenazas (amenazas, lo que
 * amenazan y los controles que las mitigan). Solo se listan las que tienen contenido. El alcance de un activo se pide por
 * su id (ver `findView`).
 */
export function listViews(doc: SecurityDocument): SecurityView[] {
  const views: SecurityView[] = [];
  if (doc.assets.length > 0) views.push(dfd(doc));
  if (doc.threats.length > 0) views.push(threatsView(doc));
  if (doc.threats.length > 0) views.push(heatmapView(doc, 'inherent'));
  if (standardsInUse(doc).length > 0) views.push(standardsView(doc));
  if (entryPoints(doc).length > 0) views.push(surfaceView(doc));
  return views;
}

const TRACE: Record<string, { reach: Reach; type: 'blast' | 'exposure' | 'focus'; title: string }> = {
  blast: { reach: 'downstream', type: 'blast', title: 'Alcance si se compromete' },
  exposure: { reach: 'upstream', type: 'exposure', title: 'Quién llega a' },
  focus: { reach: 'both', type: 'focus', title: 'Contexto de' },
};

/**
 * Vista de un activo: hasta dónde pueden llegar los datos si se compromete (`blast`), de dónde pueden llegar hasta él
 * (`exposure`) o ambos (`focus`).
 */
export function traceView(doc: SecurityDocument, assetId: string, mode: 'blast' | 'exposure' | 'focus' = 'focus'): SecurityView {
  const element = indexElements(doc).get(assetId);
  if (!element || element.kind !== 'asset') throw new Error(`No existe el activo «${assetId}».`);
  const { reach: direction, type, title } = TRACE[mode];
  const ids = new Set([assetId, ...reach(flowGraph(doc), assetId, direction).map((s) => s.id)]);
  return {
    id: `${mode}:${assetId}`,
    type,
    title: `${title} «${element.name}»`,
    focusId: assetId,
    assetIds: doc.assets.filter((a) => ids.has(a.id)).map((a) => a.id),
    flowIds: doc.flows.filter((f) => ids.has(f.sourceId) && ids.has(f.targetId)).map((f) => f.id),
    threatIds: [],
    controlIds: [],
  };
}

export function findView(doc: SecurityDocument, viewId?: string): SecurityView {
  const views = listViews(doc);
  if (!viewId) {
    if (views.length === 0) throw new Error('El documento no tiene vistas que exportar');
    return views[0];
  }
  const exact = views.find((v) => v.id === viewId);
  if (exact) return exact;
  const [prefix, ...rest] = viewId.split(':');
  const id = rest.join(':');
  if (viewId === 'heatmap:residual' && doc.threats.length > 0) return heatmapView(doc, 'residual');
  if (prefix === 'standards' && standardsInUse(doc).includes(id as ControlStandard)) return standardsView(doc, id as ControlStandard);
  const elements = indexElements(doc);
  if (prefix in TRACE && elements.get(id)?.kind === 'asset') return traceView(doc, id, prefix as 'blast' | 'exposure' | 'focus');
  if (elements.get(viewId)?.kind === 'asset') return traceView(doc, viewId);
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'heatmap:residual', ...standardsInUse(doc).map((s) => `standards:${s}`), 'blast:<activo>', 'exposure:<activo>', 'focus:<activo>'].join(', ')}.`);
}

/**
 * Vistas del lienzo: las derivadas y, tras la matriz de calor y la cobertura de estándares, sus variantes (el riesgo
 * residual; un catálogo concreto), que el lienzo ofrece en el selector «Colorear por» y no en «Vista». Las exportaciones por
 * lotes usan `listViews`.
 */
export function viewRefs(doc: SecurityDocument): Array<{ id: string; title: string; variantOf?: string; variantLabel?: string }> {
  return listViews(doc).flatMap((v) => {
    if (v.type === 'heatmap') {
      const residual = heatmapView(doc, 'residual');
      return [
        { id: v.id, title: v.title, variantLabel: 'Inherente' },
        { id: residual.id, title: residual.title, variantOf: v.id, variantLabel: 'Residual' },
      ];
    }
    if (v.type === 'standards') {
      return [
        { id: v.id, title: v.title, variantLabel: 'Todos' },
        ...standardsInUse(doc).map((s) => ({ id: `standards:${s}`, title: standardsView(doc, s).title, variantOf: v.id, variantLabel: STANDARD_LABELS[s] })),
      ];
    }
    return [{ id: v.id, title: v.title }];
  });
}
