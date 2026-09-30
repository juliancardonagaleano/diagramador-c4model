import { uniqueId, type EdgeNotation, type EditResult, type EditorGraph, type EditorSpec, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { ASSET_SHAPES, KIND_COLORS, PIPELINE_SHAPE, columnLine, entityLines, governanceLine, pipelineLine, pipelineNodeId } from './export/render';
import {
  ASSET_KINDS,
  CARDINALITIES,
  CLASSIFICATIONS,
  CLASSIFICATION_LABELS,
  COLUMN_KEYS,
  ENTITY_KINDS,
  KIND_LABELS,
  PARENT_KINDS,
  PIPELINE_KINDS,
  PIPELINE_LABELS,
  hasPii,
  type AssetKind,
  type Cardinality,
  type Column,
  type ColumnKey,
  type DataAsset,
  type DataDocument,
  type Pipeline,
} from './types';
import { findView } from './views';

/**
 * Edición interactiva del módulo de datos. Notación: los contenedores (fuente, base, almacén, lago) como cilindros y zonas,
 * las entidades (tabla, vista, archivo) como fichas con sus columnas al estilo entidad-relación, los pipelines como
 * chevrones entre los activos que leen y escriben. Las relaciones del modelo entidad-relación llevan su cardinalidad.
 */

export const PIPELINE_KIND = 'pipeline';
const PIPELINE_COLOR = '#334155';
const CONTEXT_COLOR = '#94a3b8';
const CLASSIFICATION_STROKE: Partial<Record<string, string>> = { restricted: '#c92a2a', confidential: '#e8590c' };

const asset = (kind: AssetKind, glyph: string, width: number, height: number, extra: Partial<NodeNotation> = {}): NodeNotation => ({
  kind,
  label: KIND_LABELS[kind],
  glyph,
  shape: ASSET_SHAPES[kind],
  fill: KIND_COLORS[kind],
  width,
  height,
  ...extra,
});

const NODE_KIND_NOTATION: NodeNotation[] = [
  asset('source', '⬚', 190, 76),
  asset('database', '⛁', 190, 84),
  asset('warehouse', '⛁', 190, 84),
  asset('lake', '≈', 190, 84),
  asset('stream', '⇒', 180, 60),
  asset('table', '▤', 180, 68, { fill: '#ffffff', stroke: KIND_COLORS.table }),
  asset('view', '▤', 180, 68, { fill: '#ffffff', stroke: KIND_COLORS.view }),
  asset('file', '▯', 180, 68),
  asset('report', '▦', 180, 68),
  asset('model', '⬡', 180, 68),
  { kind: PIPELINE_KIND, label: 'Pipeline', glyph: '➤', shape: PIPELINE_SHAPE, fill: PIPELINE_COLOR, width: 180, height: 52, addable: false },
];

/** La relación «pipeline» conecta dos activos creando el pipeline entre ellos, o añade una entrada/salida a uno existente. */
const EDGE_KIND_NOTATION: EdgeNotation[] = [
  { kind: 'pipeline', label: 'Pipeline (flujo de datos)', stroke: '#475569', line: 'solid', width: 1.5 },
  ...CARDINALITIES.map((c): EdgeNotation => ({ kind: c, label: `Relación ${c}`, stroke: '#475569', line: 'solid', width: 1.5, arrowEnd: c !== 'N:M' && c !== '1:1' })),
];

const options = (values: readonly string[], labels?: Record<string, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels?.[value] ?? value }));

const assetFields = (doc: DataDocument, kind: string): FieldSpec[] => [
  { key: 'name', label: 'Nombre', type: 'text' },
  { key: 'description', label: 'Descripción', type: 'longtext' },
  { key: 'technology', label: 'Tecnología', type: 'text' },
  { key: 'owner', label: 'Responsable', type: 'text' },
  { key: 'steward', label: 'Custodio', type: 'text' },
  { key: 'domainId', label: 'Dominio', type: 'select', options: doc.domains.map((d) => ({ value: d.id, label: d.name })), allowEmpty: true },
  { key: 'classification', label: 'Clasificación', type: 'select', options: options(CLASSIFICATIONS, CLASSIFICATION_LABELS), allowEmpty: true },
  { key: 'pii', label: 'Datos personales', type: 'boolean' },
  { key: 'retention', label: 'Retención', type: 'text', hint: '7 años' },
  { key: 'external', label: 'Externo', type: 'boolean' },
  ...((ENTITY_KINDS as readonly string[]).includes(kind)
    ? [{ key: 'columnsText', label: 'Columnas (una por línea)', type: 'longtext', hint: 'PK id: uuid · nombre: text (PII) · email?: text' } as FieldSpec]
    : []),
  { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' },
  { key: 'tags', label: 'Etiquetas', type: 'list' },
];

const PIPELINE_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text' },
  { key: 'kind', label: 'Tipo', type: 'select', options: options(PIPELINE_KINDS, PIPELINE_LABELS) },
  { key: 'tool', label: 'Herramienta', type: 'text' },
  { key: 'schedule', label: 'Frecuencia', type: 'text', hint: 'diaria 02:00' },
  { key: 'description', label: 'Descripción', type: 'longtext' },
  { key: 'owner', label: 'Responsable', type: 'text' },
  { key: 'anonymizes', label: 'Anonimiza los datos personales', type: 'boolean' },
];

const RELATION_FIELDS: FieldSpec[] = [
  { key: 'cardinality', label: 'Cardinalidad', type: 'select', options: options(CARDINALITIES) },
  { key: 'description', label: 'Descripción', type: 'longtext' },
];

// ───────────── columnas como texto ─────────────

/** Texto editable de las columnas: `PK,FK nombre: tipo (PII)` por línea; `?` tras el nombre marca que admite nulos. */
export function columnsToText(columns: Column[] = []): string {
  return columns.map((c) => columnLine({ ...c, name: c.nullable ? `${c.name}?` : c.name })).join('\n');
}

export function parseColumns(text: string): Column[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let rest = line;
      const pii = /\(PII\)\s*$/i.test(rest);
      rest = rest.replace(/\(PII\)\s*$/i, '').trim();
      const keys: ColumnKey[] = [];
      const m = /^((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)\s+/i.exec(rest);
      if (m) {
        for (const k of m[1].split(',')) keys.push(k.trim().toLowerCase() as ColumnKey);
        rest = rest.slice(m[0].length);
      }
      const [namePart, ...typeParts] = rest.split(':');
      const nullable = namePart.trim().endsWith('?');
      const name = namePart.trim().replace(/\?$/, '').trim();
      const type = typeParts.join(':').trim();
      const column: Column = { name };
      if (type) column.type = type;
      if (keys.length) column.keys = keys.filter((k) => (COLUMN_KEYS as readonly string[]).includes(k));
      if (nullable) column.nullable = true;
      if (pii) column.pii = true;
      return column;
    })
    .filter((c) => c.name.length > 0);
}

// ───────────── ids del grafo ─────────────

const flowEdgeId = (pipelineId: string, direction: 'in' | 'out', assetId: string): string => `flow:${pipelineId}:${direction}:${assetId}`;
const parseFlowEdge = (id: string): { pipelineId: string; direction: 'in' | 'out'; assetId: string } | undefined => {
  const m = /^flow:(.+):(in|out):(.+)$/.exec(id);
  return m ? { pipelineId: m[1], direction: m[2] as 'in' | 'out', assetId: m[3] } : undefined;
};
const parsePipelineNode = (id: string): string | undefined => (id.startsWith('pipeline:') ? id.slice('pipeline:'.length) : undefined);

const clean = (value: unknown): unknown => (value === '' || value === null || (Array.isArray(value) && value.length === 0) ? undefined : value);
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

function entitySize(a: DataAsset): { width: number; height: number } {
  const lines = entityLines(a);
  const widest = Math.max(...lines.map((l) => l.length));
  return { width: Math.min(340, Math.max(180, Math.ceil(widest * 6.6 + 28))), height: Math.max(68, 52 + (lines.length - 1) * 15) };
}

function project(doc: DataDocument, viewId?: string): EditorGraph {
  const view = findView(doc, viewId);
  const shown = new Set(view.assetIds);
  const context = new Set(view.contextIds);
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const erd = view.type === 'erd';

  const nodes: EditorGraph['nodes'] = doc.assets
    .filter((a) => shown.has(a.id))
    .map((a) => {
      const isEntity = (a.columns?.length ?? 0) > 0 && (ENTITY_KINDS as readonly string[]).includes(a.kind);
      const card = erd && isEntity;
      const badges = [hasPii(a) ? 'PII' : '', a.classification && a.classification !== 'public' && a.classification !== 'internal' ? CLASSIFICATION_LABELS[a.classification] : ''].filter(Boolean);
      return {
        id: a.id,
        kind: a.kind as string,
        label: a.name,
        sublabel: card ? undefined : [a.technology, governanceLine(a)].filter(Boolean).join(' · ') || undefined,
        parentId: !erd && a.parentId && shown.has(a.parentId) ? a.parentId : undefined,
        ref: a.ref,
        dashed: a.external || context.has(a.id),
        fill: context.has(a.id) ? CONTEXT_COLOR : undefined,
        stroke: CLASSIFICATION_STROKE[a.classification ?? ''],
        badges: badges.length ? badges : undefined,
        ...(card ? { lines: entityLines(a).slice(1), ...entitySize(a) } : {}),
      };
    });

  const pipelines = doc.pipelines.filter((p) => view.pipelineIds.includes(p.id));
  for (const p of pipelines) {
    nodes.push({ id: pipelineNodeId(p.id), kind: PIPELINE_KIND, label: p.name, sublabel: [pipelineLine(p), p.tool].filter(Boolean).join(' · ') || undefined, parentId: undefined, dashed: false, fill: undefined, stroke: undefined, badges: p.anonymizes ? ['anonimiza'] : undefined });
  }

  const edges: EditorGraph['edges'] = [];
  for (const p of pipelines) {
    for (const id of p.inputs) if (assets.has(id) && shown.has(id)) edges.push({ id: flowEdgeId(p.id, 'in', id), kind: 'pipeline', source: id, target: pipelineNodeId(p.id) });
    for (const id of p.outputs) if (assets.has(id) && shown.has(id)) edges.push({ id: flowEdgeId(p.id, 'out', id), kind: 'pipeline', source: pipelineNodeId(p.id), target: id });
  }
  for (const r of doc.relations.filter((r) => view.relationIds.includes(r.id))) {
    edges.push({ id: r.id, kind: r.cardinality, source: r.sourceId, target: r.targetId, label: [r.cardinality, r.description].filter(Boolean).join(' ') });
  }
  return { nodes, edges };
}

const fail = (reason: string): EditResult<DataDocument> => ({ ok: false, reason });

export const dataEditor: EditorSpec<DataDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'pipeline',
  project,

  fields: (target, doc) => (target.type === 'edge' ? (target.kind === 'pipeline' ? [] : RELATION_FIELDS) : target.kind === PIPELINE_KIND ? PIPELINE_FIELDS : assetFields(doc, target.kind)),

  read(doc, id) {
    const pid = parsePipelineNode(id);
    if (pid) {
      const p = doc.pipelines.find((x) => x.id === pid);
      return p ? { type: 'node', kind: PIPELINE_KIND, values: { ...p } } : undefined;
    }
    const a = doc.assets.find((x) => x.id === id);
    if (a) return { type: 'node', kind: a.kind, values: { ...a, columnsText: columnsToText(a.columns) } };
    const r = doc.relations.find((x) => x.id === id);
    if (r) return { type: 'edge', kind: r.cardinality, values: { ...r } };
    const flow = parseFlowEdge(id);
    if (flow && doc.pipelines.some((p) => p.id === flow.pipelineId)) return { type: 'edge', kind: 'pipeline', values: {} };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    if (kind === PIPELINE_KIND) return fail('Un pipeline se crea conectando dos activos con la relación «Pipeline».');
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) return fail(`Tipo de activo desconocido: ${kind}`);
    const k = kind as AssetKind;
    const parent = parentId ? doc.assets.find((a) => a.id === parentId) : undefined;
    const id = uniqueId(name, [...doc.assets.map((a) => a.id), ...doc.pipelines.map((p) => p.id), ...doc.domains.map((d) => d.id)]);
    const created: DataAsset = { id, kind: k, name };
    if (parent && PARENT_KINDS[k]?.includes(parent.kind)) created.parentId = parent.id;
    else if (parent?.domainId) created.domainId = parent.domainId;
    return { ok: true, id, document: { ...doc, assets: [...doc.assets, created] } };
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = dataEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return fail(reason);
    const sourcePipeline = parsePipelineNode(sourceId);
    const targetPipeline = parsePipelineNode(targetId);
    if (kind === 'pipeline') {
      if (sourcePipeline) {
        const id = flowEdgeId(sourcePipeline, 'out', targetId);
        return { ok: true, id, document: { ...doc, pipelines: doc.pipelines.map((p) => (p.id === sourcePipeline && !p.outputs.includes(targetId) ? { ...p, outputs: [...p.outputs, targetId] } : p)) } };
      }
      if (targetPipeline) {
        const id = flowEdgeId(targetPipeline, 'in', sourceId);
        return { ok: true, id, document: { ...doc, pipelines: doc.pipelines.map((p) => (p.id === targetPipeline && !p.inputs.includes(sourceId) ? { ...p, inputs: [...p.inputs, sourceId] } : p)) } };
      }
      const id = uniqueId(`${sourceId}-a-${targetId}`, [...doc.pipelines.map((p) => p.id), ...doc.assets.map((a) => a.id)]);
      const created: Pipeline = { id, name: `Pipeline ${doc.pipelines.length + 1}`, kind: 'batch', inputs: [sourceId], outputs: [targetId] };
      return { ok: true, id: pipelineNodeId(id), document: { ...doc, pipelines: [...doc.pipelines, created] } };
    }
    const id = uniqueId(`${sourceId}-${targetId}`, doc.relations.map((r) => r.id));
    return { ok: true, id, document: { ...doc, relations: [...doc.relations, { id, sourceId, targetId, cardinality: kind as Cardinality }] } };
  },

  update(doc, id, patch) {
    const pid = parsePipelineNode(id);
    if (pid) {
      if (!doc.pipelines.some((p) => p.id === pid)) return fail(`No existe «${id}».`);
      if (typeof patch.name === 'string' && !patch.name.trim()) return fail('El nombre no puede estar vacío.');
      if (patch.kind !== undefined && !(PIPELINE_KINDS as readonly string[]).includes(patch.kind as string)) return fail(`Tipo de pipeline desconocido: ${String(patch.kind)}`);
      return { ok: true, id, document: { ...doc, pipelines: doc.pipelines.map((p) => (p.id === pid ? patchObject(p, patch, ['name', 'kind', 'tool', 'schedule', 'description', 'owner', 'anonymizes']) : p)) } };
    }
    if (doc.assets.some((a) => a.id === id)) {
      if (typeof patch.name === 'string' && !patch.name.trim()) return fail('El nombre no puede estar vacío.');
      const { columnsText, ...rest } = patch;
      const withColumns = columnsText !== undefined ? { ...rest, columns: parseColumns(String(columnsText)) } : rest;
      return {
        ok: true,
        id,
        document: {
          ...doc,
          assets: doc.assets.map((a) => (a.id === id ? patchObject(a, withColumns, ['name', 'description', 'technology', 'owner', 'steward', 'domainId', 'classification', 'pii', 'retention', 'external', 'ref', 'tags', 'columns']) : a)),
        },
      };
    }
    if (doc.relations.some((r) => r.id === id)) {
      if (patch.cardinality !== undefined && !(CARDINALITIES as readonly string[]).includes(patch.cardinality as string)) return fail(`Cardinalidad desconocida: ${String(patch.cardinality)}`);
      return { ok: true, id, document: { ...doc, relations: doc.relations.map((r) => (r.id === id ? patchObject(r, patch, ['cardinality', 'description']) : r)) } };
    }
    return fail(`No existe «${id}».`);
  },

  remove(doc, id) {
    const pid = parsePipelineNode(id);
    if (pid) return { ok: true, document: { ...doc, pipelines: doc.pipelines.filter((p) => p.id !== pid) } };
    const flow = parseFlowEdge(id);
    if (flow) {
      const p = doc.pipelines.find((x) => x.id === flow.pipelineId);
      if (!p) return fail(`No existe «${id}».`);
      const list = flow.direction === 'in' ? p.inputs : p.outputs;
      if (list.length <= 1) return fail(`Un pipeline necesita al menos una ${flow.direction === 'in' ? 'entrada' : 'salida'}: borra el pipeline entero si sobra.`);
      const next = { ...p, [flow.direction === 'in' ? 'inputs' : 'outputs']: list.filter((x) => x !== flow.assetId) };
      return { ok: true, document: { ...doc, pipelines: doc.pipelines.map((x) => (x.id === p.id ? next : x)) } };
    }
    if (doc.assets.some((a) => a.id === id)) {
      const gone = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const a of doc.assets) if (a.parentId && gone.has(a.parentId) && !gone.has(a.id)) (gone.add(a.id), (grew = true));
      }
      const pipelines = doc.pipelines
        .map((p) => ({ ...p, inputs: p.inputs.filter((x) => !gone.has(x)), outputs: p.outputs.filter((x) => !gone.has(x)) }))
        .filter((p) => p.inputs.length > 0 && p.outputs.length > 0);
      return {
        ok: true,
        document: { ...doc, assets: doc.assets.filter((a) => !gone.has(a.id)), pipelines, relations: doc.relations.filter((r) => !gone.has(r.sourceId) && !gone.has(r.targetId)) },
      };
    }
    if (doc.relations.some((r) => r.id === id)) return { ok: true, document: { ...doc, relations: doc.relations.filter((r) => r.id !== id) } };
    return fail(`No existe «${id}».`);
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (sourceId === targetId) return 'Un activo no puede conectarse consigo mismo.';
    const sp = parsePipelineNode(sourceId);
    const tp = parsePipelineNode(targetId);
    const isAsset = (id: string): boolean => doc.assets.some((a) => a.id === id);
    if (kind === 'pipeline') {
      if (sp && tp) return 'Dos pipelines no se conectan entre sí: pasan por un activo.';
      if ((sp && !isAsset(targetId)) || (tp && !isAsset(sourceId)) || (!sp && !tp && (!isAsset(sourceId) || !isAsset(targetId)))) return 'El origen o el destino no existe.';
      return undefined;
    }
    if (sp || tp) return 'Una relación del modelo entidad-relación une dos entidades, no pipelines.';
    const s = doc.assets.find((a) => a.id === sourceId);
    const t = doc.assets.find((a) => a.id === targetId);
    if (!s || !t) return 'El origen o el destino no existe.';
    if (!ENTITY_KINDS.includes(s.kind) || !ENTITY_KINDS.includes(t.kind)) return `Una relación ${kind} une entidades (tabla, vista, archivo o stream), no ${KIND_LABELS[s.kind].toLowerCase()} con ${KIND_LABELS[t.kind].toLowerCase()}.`;
    return undefined;
  },
};
