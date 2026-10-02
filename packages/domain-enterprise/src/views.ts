import type { ViewRef } from '@iark/kernel';
import { capabilityChildren, dependencyGraph, ownership, reach, unitTree, type Reach } from './graph';
import { indexElements, lifecycleOf, type Application, type EnterpriseDocument, type Technology } from './types';

/** Criterio con el que se colorea el mapa de capacidades. */
export const CAPABILITY_COLOR_MODES = ['maturity', 'importance', 'criticality', 'lifecycle'] as const;
export type CapabilityColorMode = (typeof CAPABILITY_COLOR_MODES)[number];
export const CAPABILITY_COLOR_LABELS: Record<CapabilityColorMode, string> = {
  maturity: 'Madurez',
  importance: 'Importancia',
  criticality: 'Criticidad de las aplicaciones',
  lifecycle: 'Ciclo de vida de las aplicaciones',
};

export interface EnterpriseView {
  /** `capabilities`, `landscape`, `roadmap`, `unit:<id>` o, bajo demanda, `impact:<id>`, `depends:<id>`, `focus:<id>` y `capabilities:<criterio>`. */
  id: string;
  type: 'capabilities' | 'landscape' | 'roadmap' | 'unit' | 'impact' | 'depends' | 'focus';
  /** Solo en el mapa de capacidades: con qué se colorea (por defecto, la madurez). */
  colorBy?: CapabilityColorMode;
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
  return [...doc.capabilities, ...doc.processes, ...doc.applications, ...doc.technologies, ...doc.units].map((x) => x.id);
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

/**
 * Elementos que entran en las vistas de relaciones: todos menos las capacidades con hijas que no se relacionan con nada
 * (son solo agrupación) y las unidades que no se relacionan con nada. Una unidad se dibuja si participa en una relación
 * (asignación a un proceso) o si está suelta del todo (no tiene jerarquía ni responsabilidades), para poder conectarla.
 */
function drawable(doc: EnterpriseDocument): Set<string> {
  const children = capabilityChildren(doc);
  const related = new Set(doc.relations.flatMap((r) => [r.sourceId, r.targetId]));
  const units = new Set(doc.units.map((u) => u.id));
  const owners = new Set([...doc.capabilities, ...doc.processes, ...doc.applications, ...doc.technologies].flatMap((x) => (x.ownerId ? [x.ownerId] : [])));
  const hierarchy = new Set(doc.units.flatMap((u) => (u.parentId ? [u.id, u.parentId] : [])));
  return new Set(
    drawnOrder(doc).filter((id) => (units.has(id) ? related.has(id) || (!owners.has(id) && !hierarchy.has(id)) : !(children.has(id) && !related.has(id)))),
  );
}

/** Un periodo de la hoja de ruta del ciclo de vida: sus elementos se dibujan en una columna. */
export interface RoadmapColumn {
  /** `roadmap:retired`, `roadmap:2027`, `roadmap:undated`, `roadmap:planned`. */
  id: string;
  title: string;
  elementIds: string[];
}

const COLUMN_ORDER = { retired: 0, year: 1, undated: 2, planned: 3 } as const;

/**
 * Hoja de ruta del ciclo de vida: las aplicaciones y la tecnología que dejan de estar activas o tienen una salida prevista
 * (fin de soporte, retirada, estrategia de migrar, reemplazar o retirar), repartidas en columnas: retiradas, un año por
 * columna, en retirada o con estrategia sin fecha y previstas.
 */
export function roadmapColumns(doc: EnterpriseDocument): RoadmapColumn[] {
  const buckets = new Map<string, { title: string; order: number; key: string; items: Array<{ id: string; sort: string }> }>();
  const put = (key: string, title: string, order: number, id: string, sort: string): void => {
    const bucket = buckets.get(key) ?? { title, order, key, items: [] };
    bucket.items.push({ id, sort });
    buckets.set(key, bucket);
  };
  const place = (item: Application | Technology, strategy: Application['strategy']): void => {
    const life = lifecycleOf(item);
    const date = item.endOfLife;
    const leaving = life !== 'active' || !!date || (strategy !== undefined && strategy !== 'keep');
    if (!leaving) return;
    const sort = `${date ?? '9999'}|${item.name}`;
    if (life === 'retired') put('retired', 'Retiradas', COLUMN_ORDER.retired, item.id, sort);
    else if (life === 'planned') put('planned', 'Previstas', COLUMN_ORDER.planned, item.id, sort);
    else if (date) put(date.slice(0, 4), `Fin de soporte ${date.slice(0, 4)}`, COLUMN_ORDER.year, item.id, sort);
    else put('undated', 'Sin fecha', COLUMN_ORDER.undated, item.id, sort);
  };
  doc.applications.forEach((a) => place(a, a.strategy));
  doc.technologies.forEach((t) => place(t, undefined));
  return [...buckets.values()]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((b) => ({ id: `roadmap:${b.key}`, title: b.title, elementIds: b.items.sort((x, y) => x.sort.localeCompare(y.sort)).map((i) => i.id) }));
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
  const roadmap = roadmapColumns(doc);
  if (roadmap.length > 0) {
    views.push({
      id: 'roadmap',
      type: 'roadmap',
      title: `Hoja de ruta del ciclo de vida - ${doc.workspace.name}`,
      elementIds: roadmap.flatMap((c) => c.elementIds),
      contextIds: [],
      relationIds: [],
    });
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
  if (prefix === 'capabilities' && (CAPABILITY_COLOR_MODES as readonly string[]).includes(rest.join(':'))) {
    const base = views.find((v) => v.id === 'capabilities');
    if (base) {
      const mode = rest.join(':') as CapabilityColorMode;
      return { ...base, id: viewId, colorBy: mode, title: `Mapa de capacidades por ${CAPABILITY_COLOR_LABELS[mode].toLowerCase()} - ${doc.workspace.name}` };
    }
  }
  const id = rest.join(':');
  if (prefix in TRACE && indexElements(doc).has(id)) return traceView(doc, id, prefix as 'impact' | 'depends' | 'focus');
  const elements = indexElements(doc);
  const bare = elements.get(viewId);
  if (bare && bare.kind !== 'unit') return traceView(doc, viewId);
  const unit = views.find((v) => v.id === `unit:${viewId}`);
  if (unit) return unit;
  throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${[...views.map((v) => v.id), ...(views.some((v) => v.id === 'capabilities') ? CAPABILITY_COLOR_MODES.filter((m) => m !== 'maturity').map((m) => `capabilities:${m}`) : []), 'impact:<elemento>', 'depends:<elemento>', 'focus:<elemento>'].join(', ')}.`);
}

/**
 * Vistas que ofrece el módulo: las derivadas y, tras el mapa de capacidades, sus variantes por criterio de color (el
 * lienzo las muestra en el selector «Colorear por», no en «Vista»). Las exportaciones por lotes usan `listViews`.
 */
export function viewRefs(doc: EnterpriseDocument): ViewRef[] {
  return listViews(doc).flatMap((v): ViewRef[] => {
    if (v.type !== 'capabilities') return [{ id: v.id, title: v.title }];
    return CAPABILITY_COLOR_MODES.map((mode) =>
      mode === 'maturity'
        ? { id: v.id, title: v.title, variantLabel: CAPABILITY_COLOR_LABELS[mode] }
        : { id: `${v.id}:${mode}`, title: findView(doc, `${v.id}:${mode}`).title, variantOf: v.id, variantLabel: CAPABILITY_COLOR_LABELS[mode] },
    );
  });
}
