import { flowGraph, reach, type Reach } from './graph';
import { indexElements, type SecurityDocument } from './types';

export interface SecurityView {
  /** `dfd`, `threats` o, bajo demanda, `blast:<id>`, `exposure:<id>` y `focus:<id>`. */
  id: string;
  type: 'dfd' | 'threats' | 'blast' | 'exposure' | 'focus';
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

/**
 * Vistas derivadas del documento: los flujos de datos con sus zonas de confianza y el modelo de amenazas (amenazas, lo que
 * amenazan y los controles que las mitigan). Solo se listan las que tienen contenido. El alcance de un activo se pide por
 * su id (ver `findView`).
 */
export function listViews(doc: SecurityDocument): SecurityView[] {
  const views: SecurityView[] = [];
  if (doc.assets.length > 0) views.push(dfd(doc));
  if (doc.threats.length > 0) views.push(threatsView(doc));
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
  const elements = indexElements(doc);
  if (prefix in TRACE && elements.get(id)?.kind === 'asset') return traceView(doc, id, prefix as 'blast' | 'exposure' | 'focus');
  if (elements.get(viewId)?.kind === 'asset') return traceView(doc, viewId);
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'blast:<activo>', 'exposure:<activo>', 'focus:<activo>'].join(', ')}.`);
}
