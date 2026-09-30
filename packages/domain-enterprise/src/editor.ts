import { uniqueId, type EdgeNotation, type EditorGraph, type EditorNode, type EditorSpec, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { applicationsByCapability, capabilityChildren } from './graph';
import { CONTEXT_COLOR, ELEMENT_SHAPES, IMPORTANCE_STROKE, KIND_COLORS, LIFECYCLE_STROKE, MATURITY_COLORS, MATURITY_UNKNOWN, layoutCapabilityMap } from './export/render';
import {
  CRITICALITIES,
  CRITICALITY_LABELS,
  IMPORTANCES,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  LIFECYCLES,
  LIFECYCLE_LABELS,
  MATURITY_MAX,
  MATURITY_MIN,
  RELATION_KINDS,
  RELATION_LABELS,
  RELATION_RULES,
  TECHNOLOGY_KINDS,
  TECHNOLOGY_KIND_LABELS,
  drawnEnds,
  indexElements,
  lifecycleOf,
  type Application,
  type Capability,
  type DrawnKind,
  type Element,
  type ElementKind,
  type EnterpriseDocument,
  type Lifecycle,
  type Process,
  type Relation,
  type RelationKind,
  type Technology,
} from './types';
import { findView } from './views';

/**
 * Editor interactivo de arquitectura empresarial. Sigue la notación de capas de ArchiMate: capacidades como recuadros
 * redondeados (el mapa las anida en cuadrícula, con el color de la madurez y el borde de la importancia), procesos como
 * flechas anchas, aplicaciones como cajas y tecnología como barras. Las unidades son responsables: no se dibujan, se
 * eligen en las propiedades de cada elemento.
 */
const node = (kind: DrawnKind, glyph: string, width: number, height: number): NodeNotation => ({
  kind,
  label: KIND_LABELS[kind],
  glyph,
  shape: ELEMENT_SHAPES[kind],
  fill: KIND_COLORS[kind],
  width,
  height,
});

const NODE_KIND_NOTATION: NodeNotation[] = [
  node('capability', '◆', 210, 78),
  node('process', '➔', 210, 70),
  node('application', '▣', 210, 82),
  node('technology', '▤', 210, 78),
];

const EDGE_COLOR = '#475569';
const EDGE_KIND_NOTATION: EdgeNotation[] = [
  { kind: 'supports', label: RELATION_LABELS.supports, stroke: EDGE_COLOR, line: 'solid', width: 1.5 },
  { kind: 'realizes', label: RELATION_LABELS.realizes, stroke: KIND_COLORS.process, line: 'solid', width: 1.5 },
  { kind: 'runs-on', label: RELATION_LABELS['runs-on'], stroke: KIND_COLORS.technology, line: 'solid', width: 1.5 },
  { kind: 'depends-on', label: RELATION_LABELS['depends-on'], stroke: EDGE_COLOR, line: 'dashed', width: 1.5 },
];

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] }));
const MATURITY_OPTIONS = Array.from({ length: MATURITY_MAX - MATURITY_MIN + 1 }, (_, i) => String(MATURITY_MIN + i)).map((value) => ({ value, label: `${value}/5` }));

const REF_FIELD: FieldSpec = { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' };
const TAGS_FIELD: FieldSpec = { key: 'tags', label: 'Etiquetas', type: 'list' };

function nodeFields(kind: string, doc: EnterpriseDocument): FieldSpec[] {
  const owner: FieldSpec = { key: 'ownerId', label: 'Unidad responsable', type: 'select', options: doc.units.map((u) => ({ value: u.id, label: u.name })), allowEmpty: true };
  const lifecycle: FieldSpec = { key: 'lifecycle', label: 'Ciclo de vida', type: 'select', options: options(LIFECYCLES, LIFECYCLE_LABELS), allowEmpty: true, hint: 'si no se indica, activa' };
  const common: FieldSpec[] = [
    { key: 'name', label: 'Nombre', type: 'text' },
    { key: 'description', label: 'Descripción', type: 'longtext' },
  ];
  switch (kind) {
    case 'capability':
      return [
        ...common,
        { key: 'parentId', label: 'Capacidad padre', type: 'select', options: doc.capabilities.map((c) => ({ value: c.id, label: c.name })), allowEmpty: true },
        owner,
        { key: 'importance', label: 'Importancia', type: 'select', options: options(IMPORTANCES, IMPORTANCE_LABELS), allowEmpty: true },
        { key: 'maturity', label: 'Madurez', type: 'select', options: MATURITY_OPTIONS, allowEmpty: true, hint: '1 inicial · 5 optimizada' },
        TAGS_FIELD,
      ];
    case 'process':
      return [...common, owner, TAGS_FIELD];
    case 'application':
      return [
        ...common,
        { key: 'technology', label: 'Tecnología (pila)', type: 'text' },
        { key: 'vendor', label: 'Proveedor', type: 'text' },
        owner,
        lifecycle,
        { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES, CRITICALITY_LABELS), allowEmpty: true },
        { key: 'external', label: 'Externa (SaaS o de terceros)', type: 'boolean' },
        REF_FIELD,
        TAGS_FIELD,
      ];
    case 'technology':
      return [
        ...common,
        { key: 'kind', label: 'Clase', type: 'select', options: options(TECHNOLOGY_KINDS, TECHNOLOGY_KIND_LABELS), allowEmpty: true, hint: 'si no se indica, plataforma' },
        { key: 'version', label: 'Versión', type: 'text' },
        owner,
        lifecycle,
        { key: 'endOfLife', label: 'Fin de soporte', type: 'text', hint: '2027-06 o 2027-06-30' },
        REF_FIELD,
        TAGS_FIELD,
      ];
    default:
      return common;
  }
}

const EDGE_FIELDS: FieldSpec[] = [
  { key: 'kind', label: 'Tipo de relación', type: 'select', options: options(RELATION_KINDS, RELATION_LABELS) },
  { key: 'description', label: 'Descripción', type: 'longtext' },
];

const PATCHABLE: Record<ElementKind, string[]> = {
  unit: ['name', 'description', 'external'],
  capability: ['name', 'description', 'parentId', 'ownerId', 'importance', 'maturity', 'tags'],
  process: ['name', 'description', 'ownerId', 'tags'],
  application: ['name', 'description', 'technology', 'vendor', 'ownerId', 'lifecycle', 'criticality', 'external', 'ref', 'tags'],
  technology: ['name', 'description', 'kind', 'version', 'ownerId', 'lifecycle', 'endOfLife', 'ref', 'tags'],
};

const clean = (value: unknown): unknown => {
  if (value === '' || value === null || value === false || (Array.isArray(value) && value.length === 0)) return undefined;
  return value;
};

function patchObject<T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = clean(patch[key]);
    if (key === 'maturity' && value !== undefined) value = Number(value);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Orientación real (origen → destino del modelo) de una relación `kind` entre dos elementos, aceptando ambos sentidos del arrastre. */
function orient(kind: RelationKind, source: ElementKind, target: ElementKind): { reversed: boolean } | undefined {
  for (const [from, to] of RELATION_RULES[kind]) {
    if (from === source && to === target) return { reversed: false };
    if (from === target && to === source) return { reversed: true };
  }
  return undefined;
}

const collection = (kind: ElementKind): keyof EnterpriseDocument =>
  ({ unit: 'units', capability: 'capabilities', process: 'processes', application: 'applications', technology: 'technologies' } as const)[kind];

/** Ids de una capacidad y de todas sus descendientes. */
function capabilitySubtree(doc: EnterpriseDocument, id: string): Set<string> {
  const children = capabilityChildren(doc);
  const ids = new Set<string>();
  const walk = (c: string): void => {
    ids.add(c);
    for (const k of children.get(c) ?? []) walk(k.id);
  };
  walk(id);
  return ids;
}

const relationLabel = (r: Relation): string | undefined => r.description;

/** Segunda línea de un elemento en las vistas de relaciones: lo que lo caracteriza (tecnología, responsable, clase). */
function sublabelOf(e: Element, doc: EnterpriseDocument): string | undefined {
  switch (e.kind) {
    case 'capability': {
      const c = e.item as Capability;
      return [c.importance ? IMPORTANCE_LABELS[c.importance] : undefined, c.maturity ? `madurez ${c.maturity}/5` : undefined].filter(Boolean).join(' · ') || undefined;
    }
    case 'process':
      return doc.units.find((u) => u.id === (e.item as Process).ownerId)?.name;
    case 'application': {
      const a = e.item as Application;
      return a.technology ?? a.vendor;
    }
    case 'technology': {
      const t = e.item as Technology;
      return [TECHNOLOGY_KIND_LABELS[t.kind ?? 'platform'], t.version].filter(Boolean).join(' ');
    }
    default:
      return undefined;
  }
}

function capabilityMap(doc: EnterpriseDocument): EditorGraph {
  const children = capabilityChildren(doc);
  const apps = applicationsByCapability(doc);
  return {
    nodes: doc.capabilities.map((c): EditorNode => {
      const group = children.has(c.id);
      const count = apps.get(c.id)?.size ?? 0;
      return {
        id: c.id,
        kind: 'capability',
        label: c.name,
        parentId: c.parentId,
        sublabel: group ? undefined : [c.importance ? IMPORTANCE_LABELS[c.importance] : undefined, count === 0 ? 'sin aplicación' : `${count} ${count === 1 ? 'aplicación' : 'aplicaciones'}`].filter(Boolean).join(' · '),
        badges: c.maturity ? [`madurez ${c.maturity}/5`] : undefined,
        fill: group ? undefined : c.maturity ? MATURITY_COLORS[c.maturity - 1] : MATURITY_UNKNOWN,
        stroke: group ? undefined : c.importance ? IMPORTANCE_STROKE[c.importance] : '#868e96',
        dashed: !group && count === 0,
      };
    }),
    edges: [],
  };
}

export const enterpriseEditor: EditorSpec<EnterpriseDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'supports',

  project(doc, viewId) {
    const view = findView(doc, viewId);
    if (view.type === 'capabilities') return capabilityMap(doc);
    const all = indexElements(doc);
    const context = new Set(view.contextIds);
    const nodes = view.elementIds.flatMap((id): EditorNode[] => {
      const e = all.get(id);
      if (!e || e.kind === 'unit') return [];
      const life = lifecycleOf(e.item as { lifecycle?: Lifecycle });
      const badges = [
        e.kind === 'application' && (e.item as Application).criticality ? `criticidad ${CRITICALITY_LABELS[(e.item as Application).criticality!]}` : undefined,
        life !== 'active' ? LIFECYCLE_LABELS[life] : undefined,
        e.kind === 'technology' && (e.item as Technology).endOfLife ? `soporte hasta ${(e.item as Technology).endOfLife}` : undefined,
      ].filter((b): b is string => !!b);
      return [
        {
          id: e.id,
          kind: e.kind,
          label: e.name,
          sublabel: sublabelOf(e, doc),
          ref: (e.item as { ref?: string }).ref,
          badges: badges.length > 0 ? badges : undefined,
          fill: context.has(e.id) ? CONTEXT_COLOR : undefined,
          stroke: LIFECYCLE_STROKE[life],
          dashed: context.has(e.id) || life === 'retired' || (e.kind === 'application' && (e.item as Application).external === true),
        },
      ];
    });
    const shown = new Set(view.relationIds);
    return {
      nodes,
      edges: doc.relations
        .filter((r) => shown.has(r.id))
        .map((r) => {
          const { from, to } = drawnEnds(r);
          return { id: r.id, kind: r.kind, source: from, target: to, label: relationLabel(r) };
        }),
    };
  },

  layout(doc, viewId) {
    return findView(doc, viewId).type === 'capabilities' ? layoutCapabilityMap(doc) : undefined;
  },

  fields: (target, doc) => (target.type === 'node' ? nodeFields(target.kind, doc) : EDGE_FIELDS),

  read(doc, id) {
    const e = indexElements(doc).get(id);
    if (e) {
      const values: Record<string, unknown> = { ...e.item };
      if (typeof values.maturity === 'number') values.maturity = String(values.maturity);
      return { type: 'node', kind: e.kind, values };
    }
    const r = doc.relations.find((x) => x.id === id);
    if (r) return { type: 'edge', kind: r.kind, values: { ...r } };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    const drawn: readonly string[] = ['capability', 'process', 'application', 'technology'];
    if (!drawn.includes(kind)) return { ok: false, reason: `Tipo de elemento desconocido: ${kind}` };
    const k = kind as DrawnKind;
    const id = uniqueId(name, indexElements(doc).keys());
    const key = collection(k);
    const parent = k === 'capability' && parentId ? doc.capabilities.find((c) => c.id === parentId) : undefined;
    const created = { id, name, ...(parent ? { parentId: parent.id } : {}) };
    return { ok: true, id, document: { ...doc, [key]: [...(doc[key] as unknown[]), created] } };
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = enterpriseEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return { ok: false, reason };
    const all = indexElements(doc);
    const k = kind as RelationKind;
    const { reversed } = orient(k, all.get(sourceId)!.kind, all.get(targetId)!.kind)!;
    const [from, to] = reversed ? [targetId, sourceId] : [sourceId, targetId];
    const id = uniqueId(`${from}--${k}--${to}`, doc.relations.map((r) => r.id));
    return { ok: true, id, document: { ...doc, relations: [...doc.relations, { id, kind: k, sourceId: from, targetId: to }] } };
  },

  update(doc, id, patch) {
    const all = indexElements(doc);
    const e = all.get(id);
    if (e) {
      if (typeof patch.name === 'string' && patch.name.trim() === '') return { ok: false, reason: 'El nombre no puede estar vacío.' };
      if (typeof patch.ownerId === 'string' && patch.ownerId !== '' && all.get(patch.ownerId)?.kind !== 'unit') return { ok: false, reason: 'El responsable debe ser una unidad.' };
      if (e.kind === 'capability' && typeof patch.parentId === 'string' && patch.parentId !== '') {
        if (all.get(patch.parentId)?.kind !== 'capability') return { ok: false, reason: 'La capacidad padre debe ser otra capacidad.' };
        if (capabilitySubtree(doc, id).has(patch.parentId)) return { ok: false, reason: 'Una capacidad no puede colgar de sí misma ni de una de sus hijas.' };
      }
      const key = collection(e.kind);
      return { ok: true, id, document: { ...doc, [key]: (doc[key] as Array<{ id: string }>).map((x) => (x.id === id ? patchObject(x, patch, PATCHABLE[e.kind]) : x)) } };
    }
    const r = doc.relations.find((x) => x.id === id);
    if (r) {
      const next = patchObject(r, patch, ['kind', 'description']);
      if (!(RELATION_KINDS as readonly string[]).includes(next.kind)) return { ok: false, reason: `Tipo de relación desconocido: ${String(next.kind)}` };
      if (next.kind !== r.kind && !orient(next.kind, all.get(r.sourceId)!.kind, all.get(r.targetId)!.kind)) {
        return { ok: false, reason: `«${RELATION_LABELS[next.kind]}» no admite ${KIND_LABELS[all.get(r.sourceId)!.kind].toLowerCase()} → ${KIND_LABELS[all.get(r.targetId)!.kind].toLowerCase()}.` };
      }
      const oriented = next.kind !== r.kind && orient(next.kind, all.get(r.sourceId)!.kind, all.get(r.targetId)!.kind)!.reversed ? { ...next, sourceId: r.targetId, targetId: r.sourceId } : next;
      return { ok: true, id, document: { ...doc, relations: doc.relations.map((x) => (x.id === id ? oriented : x)) } };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  remove(doc, id) {
    const e = indexElements(doc).get(id);
    if (e) {
      const gone = e.kind === 'capability' ? capabilitySubtree(doc, id) : new Set([id]);
      const strip = <T extends { id: string; ownerId?: string }>(items: T[]): T[] => items.filter((x) => !gone.has(x.id));
      return {
        ok: true,
        document: {
          ...doc,
          units: doc.units.filter((u) => !gone.has(u.id)),
          capabilities: strip(doc.capabilities),
          processes: strip(doc.processes),
          applications: strip(doc.applications),
          technologies: strip(doc.technologies),
          relations: doc.relations.filter((r) => !gone.has(r.sourceId) && !gone.has(r.targetId)),
        },
      };
    }
    if (doc.relations.some((r) => r.id === id)) return { ok: true, document: { ...doc, relations: doc.relations.filter((r) => r.id !== id) } };
    return { ok: false, reason: `No existe «${id}».` };
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (!(RELATION_KINDS as readonly string[]).includes(kind)) return `Tipo de relación desconocido: ${kind}`;
    if (sourceId === targetId) return 'Una relación no puede unir un elemento consigo mismo.';
    const all = indexElements(doc);
    const s = all.get(sourceId);
    const t = all.get(targetId);
    if (!s || !t) return 'El origen o el destino no existe.';
    if (s.kind === 'unit' || t.kind === 'unit') return 'Las unidades no se relacionan: son responsables de los elementos.';
    if (!orient(kind as RelationKind, s.kind, t.kind)) {
      const admitted = RELATION_RULES[kind as RelationKind].map(([a, b]) => `${KIND_LABELS[a].toLowerCase()} → ${KIND_LABELS[b].toLowerCase()}`).join(', ');
      return `«${RELATION_LABELS[kind as RelationKind]}» une ${admitted}; no ${KIND_LABELS[s.kind].toLowerCase()} con ${KIND_LABELS[t.kind].toLowerCase()}.`;
    }
    const k = kind as RelationKind;
    const { reversed } = orient(k, s.kind, t.kind)!;
    const [from, to] = reversed ? [targetId, sourceId] : [sourceId, targetId];
    if (doc.relations.some((r) => r.kind === k && r.sourceId === from && r.targetId === to)) return 'Esa relación ya existe.';
    return undefined;
  },
};
