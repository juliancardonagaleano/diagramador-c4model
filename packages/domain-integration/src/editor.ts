import { uniqueId, type EditorSpec, type EdgeNotation, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { findView } from './views';
import { CRITICALITIES, INTERACTION_STYLES, KIND_LABELS, NODE_KINDS, PARENT_KINDS, PATTERNS, type IntegrationDocument, type IntegrationNode, type InteractionStyle, type NodeKind } from './types';
import { KIND_COLORS, NODE_GLYPHS, NODE_SHAPES, NODE_SIZES } from './notation';

const node = (kind: NodeKind): NodeNotation => ({
  kind,
  label: KIND_LABELS[kind],
  glyph: NODE_GLYPHS[kind],
  shape: NODE_SHAPES[kind],
  fill: KIND_COLORS[kind],
  width: NODE_SIZES[kind].width,
  height: NODE_SIZES[kind].height,
});

const NODE_KIND_NOTATION: NodeNotation[] = NODE_KINDS.map(node);

const STYLE_LABELS: Record<InteractionStyle, string> = {
  'request-response': 'Petición-respuesta',
  'async-message': 'Mensaje asíncrono',
  event: 'Evento',
  batch: 'Lote',
  stream: 'Flujo continuo',
};

const EDGE_KIND_NOTATION: EdgeNotation[] = [
  { kind: 'request-response', label: STYLE_LABELS['request-response'], stroke: '#475569', line: 'solid', width: 1.5 },
  { kind: 'async-message', label: STYLE_LABELS['async-message'], stroke: '#475569', line: 'dashed', width: 1.5 },
  { kind: 'event', label: STYLE_LABELS.event, stroke: '#475569', line: 'dashed', width: 2.5 },
  { kind: 'batch', label: STYLE_LABELS.batch, stroke: '#475569', line: 'dashed', width: 1.5 },
  { kind: 'stream', label: STYLE_LABELS.stream, stroke: '#475569', line: 'dashed', width: 2.5 },
];

const NODE_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text' },
  { key: 'description', label: 'Descripción', type: 'longtext' },
  { key: 'technology', label: 'Tecnología', type: 'text' },
  { key: 'owner', label: 'Responsable', type: 'text' },
  { key: 'external', label: 'Externo', type: 'boolean' },
  { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' },
  { key: 'tags', label: 'Etiquetas', type: 'list' },
];

const options = (values: readonly string[], labels?: Record<string, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels?.[value] ?? value }));

const EDGE_FIELDS = (doc: IntegrationDocument): FieldSpec[] => [
  { key: 'style', label: 'Estilo', type: 'select', options: options(INTERACTION_STYLES, STYLE_LABELS) },
  { key: 'description', label: 'Descripción', type: 'longtext' },
  { key: 'protocol', label: 'Protocolo', type: 'text' },
  { key: 'pattern', label: 'Patrón', type: 'select', options: options(PATTERNS), allowEmpty: true },
  { key: 'contractId', label: 'Contrato', type: 'select', options: doc.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.format})` })), allowEmpty: true },
  { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES), allowEmpty: true },
  { key: 'dataObjects', label: 'Datos que viajan', type: 'list' },
];

const clean = (value: unknown): unknown => {
  if (value === '' || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
  return value;
};

const patchObject = <T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T => {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    const value = clean(patch[key]);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
};

export const integrationEditor: EditorSpec<IntegrationDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'request-response',

  project(doc, viewId) {
    const view = findView(doc, viewId);
    const labelOf = new Map(view.interactions.map(({ interaction, step }) => [interaction.id, step]));
    const shown = new Set(view.nodeIds);
    return {
      nodes: doc.nodes
        .filter((n) => shown.has(n.id))
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.name,
          sublabel: n.technology,
          parentId: n.parentId && shown.has(n.parentId) ? n.parentId : undefined,
          ref: n.ref,
          dashed: n.external,
          fill: n.external ? '#6b6b6b' : undefined,
        })),
      edges: view.interactions.map(({ interaction: it }) => {
        const step = labelOf.get(it.id);
        const text = [it.description, it.protocol ? `[${it.protocol}]` : undefined].filter(Boolean).join(' ');
        return {
          id: it.id,
          kind: it.style,
          source: it.sourceId,
          target: it.targetId,
          label: step !== undefined ? `${step}. ${text}`.trim() : text || undefined,
          badges: it.pattern ? [it.pattern] : undefined,
          width: it.criticality === 'high' ? 2.25 : undefined,
        };
      }),
    };
  },

  fields: (target, doc) => (target.type === 'node' ? NODE_FIELDS : EDGE_FIELDS(doc)),

  read(doc, id) {
    const n = doc.nodes.find((x) => x.id === id);
    if (n) return { type: 'node', kind: n.kind, values: { ...n } };
    const it = doc.interactions.find((x) => x.id === id);
    if (it) return { type: 'edge', kind: it.style, values: { ...it } };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    if (!(NODE_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `Tipo de nodo desconocido: ${kind}` };
    const k = kind as NodeKind;
    const parent = parentId ? doc.nodes.find((n) => n.id === parentId) : undefined;
    const id = uniqueId(name, [...doc.nodes.map((n) => n.id)]);
    const created: IntegrationNode = { id, kind: k, name, ...(parent && PARENT_KINDS[k]?.includes(parent.kind) ? { parentId: parent.id } : {}) };
    return { ok: true, id, document: { ...doc, nodes: [...doc.nodes, created] } };
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = integrationEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return { ok: false, reason };
    const id = uniqueId(`${sourceId}-${targetId}`, doc.interactions.map((i) => i.id));
    return { ok: true, id, document: { ...doc, interactions: [...doc.interactions, { id, sourceId, targetId, style: kind as InteractionStyle }] } };
  },

  update(doc, id, patch) {
    if (doc.nodes.some((n) => n.id === id)) {
      if (typeof patch.name === 'string' && patch.name.trim() === '') return { ok: false, reason: 'El nombre no puede estar vacío.' };
      return { ok: true, id, document: { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? patchObject(n, patch, ['name', 'description', 'technology', 'owner', 'external', 'ref', 'tags']) : n)) } };
    }
    if (doc.interactions.some((i) => i.id === id)) {
      return { ok: true, id, document: { ...doc, interactions: doc.interactions.map((i) => (i.id === id ? patchObject(i, patch, ['style', 'description', 'protocol', 'pattern', 'contractId', 'criticality', 'dataObjects']) : i)) } };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  remove(doc, id) {
    if (doc.nodes.some((n) => n.id === id)) {
      const gone = new Set([id, ...doc.nodes.filter((n) => n.parentId === id).map((n) => n.id)]);
      const interactions = doc.interactions.filter((i) => !gone.has(i.sourceId) && !gone.has(i.targetId));
      const kept = new Set(interactions.map((i) => i.id));
      return {
        ok: true,
        document: {
          ...doc,
          nodes: doc.nodes.filter((n) => !gone.has(n.id)),
          interactions,
          flows: doc.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => kept.has(s.interactionId)) })),
        },
      };
    }
    if (doc.interactions.some((i) => i.id === id)) {
      return { ok: true, document: { ...doc, interactions: doc.interactions.filter((i) => i.id !== id), flows: doc.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => s.interactionId !== id) })) } };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  canConnect(doc, _kind, sourceId, targetId) {
    if (sourceId === targetId) return 'Una interacción no puede unir un nodo consigo mismo.';
    if (!doc.nodes.some((n) => n.id === sourceId) || !doc.nodes.some((n) => n.id === targetId)) return 'El origen o el destino no existe.';
    return undefined;
  },
};
