import { capabilityChildren, dependencyGraph, ownership, reach, unitTree, type Reach } from './graph';
import { indexElements, type EnterpriseDocument } from './types';

export interface EnterpriseView {
  /** `capabilities`, `landscape`, `unit:<id>` o, bajo demanda, `impact:<id>`, `depends:<id>` y `focus:<id>`. */
  id: string;
  type: 'capabilities' | 'landscape' | 'unit' | 'impact' | 'depends' | 'focus';
  title: string;
  /** Elementos dibujados (los del foco y los de contexto), capacidades primero y en el orden del documento. */
  elementIds: string[];
  /** Elementos de contexto: extremos de una relación dibujada que quedan fuera del foco de la vista (discontinuos). */
  contextIds: string[];
  relationIds: string[];
}

interface Spec {
  id: string;
  type: EnterpriseView['type'];
  title: string;
  focus: Set<string>;
  /** Incluir las relaciones que salen del foco y dibujar sus extremos como contexto. Si no, solo las que quedan dentro. */
  context?: boolean;
}

function drawnOrder(doc: EnterpriseDocument): string[] {
  return [...doc.capabilities, ...doc.processes, ...doc.applications, ...doc.technologies].map((x) => x.id);
}

function build(doc: EnterpriseDocument, spec: Spec): EnterpriseView {
  const relations = doc.relations.filter((r) =>
    spec.context ? spec.focus.has(r.sourceId) || spec.focus.has(r.targetId) : spec.focus.has(r.sourceId) && spec.focus.has(r.targetId),
  );
  const drawn = new Set(spec.focus);
  for (const r of relations) {
    drawn.add(r.sourceId);
    drawn.add(r.targetId);
  }
  return {
    id: spec.id,
    type: spec.type,
    title: spec.title,
    elementIds: drawnOrder(doc).filter((id) => drawn.has(id)),
    contextIds: drawnOrder(doc).filter((id) => drawn.has(id) && !spec.focus.has(id)),
    relationIds: relations.map((r) => r.id),
  };
}

/** Elementos que entran en las vistas de relaciones: todos menos las capacidades con hijas que no se relacionan con nada (son solo agrupación). */
function drawable(doc: EnterpriseDocument): Set<string> {
  const children = capabilityChildren(doc);
  const related = new Set(doc.relations.flatMap((r) => [r.sourceId, r.targetId]));
  return new Set(drawnOrder(doc).filter((id) => !(children.has(id) && !related.has(id))));
}

/**
 * Vistas derivadas del documento: el mapa de capacidades, el paisaje (capacidad → aplicación → tecnología) y una por
 * unidad con lo que tiene a su cargo. Solo se listan las que tienen contenido. El impacto o las dependencias de un
 * elemento concreto se piden por su id (ver `findView`).
 */
export function listViews(doc: EnterpriseDocument): EnterpriseView[] {
  const views: EnterpriseView[] = [];
  if (doc.capabilities.length > 0) {
    views.push({
      id: 'capabilities',
      type: 'capabilities',
      title: `Mapa de capacidades - ${doc.workspace.name}`,
      elementIds: doc.capabilities.map((c) => c.id),
      contextIds: [],
      relationIds: [],
    });
  }
  const shown = drawable(doc);
  if (doc.relations.length > 0) {
    views.push(build(doc, { id: 'landscape', type: 'landscape', title: `Paisaje empresarial - ${doc.workspace.name}`, focus: shown }));
  }
  const { ownerOf } = ownership(doc);
  for (const unit of doc.units) {
    const tree = unitTree(doc, unit.id);
    const focus = new Set([...shown].filter((id) => tree.has(ownerOf(id) ?? '')));
    if (focus.size > 0) views.push(build(doc, { id: `unit:${unit.id}`, type: 'unit', title: `Unidad - ${unit.name}`, focus, context: true }));
  }
  return views;
}

const TRACE: Record<string, { reach: Reach; type: EnterpriseView['type']; title: string }> = {
  impact: { reach: 'dependents', type: 'impact', title: 'Impacto de' },
  depends: { reach: 'dependencies', type: 'depends', title: 'Dependencias de' },
  focus: { reach: 'both', type: 'focus', title: 'Entorno de' },
};

/** Vista de un elemento: lo que se apoya en él (impacto), aquello en lo que se apoya (dependencias) o ambos. */
export function traceView(doc: EnterpriseDocument, elementId: string, mode: 'impact' | 'depends' | 'focus' = 'focus'): EnterpriseView {
  const element = indexElements(doc).get(elementId);
  if (!element || element.kind === 'unit') throw new Error(`No existe el elemento «${elementId}» (capacidad, proceso, aplicación o tecnología).`);
  const { reach: direction, type, title } = TRACE[mode];
  const focus = new Set([elementId, ...reach(dependencyGraph(doc), elementId, direction).map((s) => s.id)]);
  return build(doc, { id: `${mode}:${elementId}`, type, title: `${title} «${element.name}»`, focus });
}

export function findView(doc: EnterpriseDocument, viewId?: string): EnterpriseView {
  const views = listViews(doc);
  if (!viewId) {
    if (views.length === 0) throw new Error('El documento no tiene vistas que exportar');
    return views[0];
  }
  const exact = views.find((v) => v.id === viewId);
  if (exact) return exact;
  const [prefix, ...rest] = viewId.split(':');
  const id = rest.join(':');
  if (prefix in TRACE && indexElements(doc).has(id)) return traceView(doc, id, prefix as 'impact' | 'depends' | 'focus');
  const elements = indexElements(doc);
  const bare = elements.get(viewId);
  if (bare && bare.kind !== 'unit') return traceView(doc, viewId);
  const unit = views.find((v) => v.id === `unit:${viewId}`);
  if (unit) return unit;
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), 'impact:<elemento>', 'depends:<elemento>', 'focus:<elemento>'].join(', ')}.`);
}
