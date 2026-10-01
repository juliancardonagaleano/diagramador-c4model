import { describe, expect, it } from 'vitest';
import { integrationEditor, integrationModule } from '@iark/domain-integration';
import type { IntegrationDocument } from '@iark/domain-integration';
import { EditHistory } from './history';
import { buildFlow, structureKey } from './flow';
import { matchShortcut } from './shortcuts';
import example from '../../../examples/pedidos-integracion.json';

const doc = integrationModule.schema.parse(example) as IntegrationDocument;
const spec = integrationEditor as never;

describe('EditHistory', () => {
  it('deshace y rehace y descarta lo rehecho al editar de nuevo', () => {
    const h = new EditHistory();
    h.record('a');
    h.record('b');
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe('a');
    expect(h.undo('a')).toBeUndefined();
    expect(h.redo('a')).toBe('b');
    h.record('b');
    expect(h.canRedo).toBe(false);
  });
});

describe('matchShortcut', () => {
  it('usa los mismos atajos que el editor C4 y calla al escribir', () => {
    expect(matchShortcut({ key: 'z', ctrlKey: true }, false)).toBe('undo');
    expect(matchShortcut({ key: 'Z', ctrlKey: true, shiftKey: true }, false)).toBe('redo');
    expect(matchShortcut({ key: 'y', metaKey: true }, false)).toBe('redo');
    expect(matchShortcut({ key: 'l', ctrlKey: true }, false)).toBe('layout');
    expect(matchShortcut({ key: 'Delete' }, false)).toBe('delete');
    expect(matchShortcut({ key: 'Delete' }, true)).toBeUndefined();
    expect(matchShortcut({ key: 'x' }, false)).toBeUndefined();
  });
});

describe('editor de integración', () => {
  it('proyecta un grafo con sus figuras y agrupa los nodos con padre', () => {
    const graph = integrationEditor.project(doc);
    const zones = graph.nodes.filter((n) => n.kind === 'domain');
    expect(zones.map((z) => z.id).sort()).toEqual(['domain:finanzas', 'domain:pedidos', 'domain:plataforma']);
    expect(graph.nodes.length).toBe(doc.nodes.length + zones.length);
    const { nodes, edges } = buildFlow(spec, graph, undefined);
    expect(edges.length).toBe(doc.interactions.length);
    expect(edges.every((e) => e.type === 'notation')).toBe(true);
    const shapeOf = (kind: string) => nodes.find((n) => n.data.node.kind === kind)?.data.notation.shape;
    expect([shapeOf('topic'), shapeOf('api'), shapeOf('store'), shapeOf('user'), shapeOf('pattern')]).toEqual(['fan', 'hexagon', 'cylinder', 'actor', 'diamond']);
    expect(nodes.find((n) => n.id === 'domain:pedidos')?.data.group).toBe(true);
    expect(nodes.find((n) => n.id === 'pedidos')?.parentId).toBe('domain:pedidos');
    expect(nodes.find((n) => n.id === 'pedidos-api')?.parentId).toBe('pedidos');
    const parentIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId));
    for (const id of parentIds) {
      expect(nodes.find((n) => n.id === id)?.data.group).toBe(true);
      // los padres van antes que sus hijos
      expect(nodes.findIndex((n) => n.id === id)).toBeLessThan(nodes.findIndex((n) => n.parentId === id));
    }
  });

  it('añade, conecta, edita y borra dejando siempre un documento válido', () => {
    let d = doc;
    const add = integrationEditor.addNode(d, 'system', 'Facturación');
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    d = add.document;
    const conn = integrationEditor.addEdge(d, 'async-message', add.id!, doc.nodes[0].id);
    expect(conn.ok).toBe(true);
    if (!conn.ok) return;
    d = conn.document;
    const upd = integrationEditor.update(d, conn.id!, { protocol: 'AMQP', pattern: 'saga', criticality: '' });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    d = upd.document;
    expect(d.interactions.find((i) => i.id === conn.id)).toMatchObject({ protocol: 'AMQP', pattern: 'saga', style: 'async-message' });
    expect(d.interactions.find((i) => i.id === conn.id)).not.toHaveProperty('criticality');
    expect(integrationModule.schema.safeParse(d).success).toBe(true);
    const del = integrationEditor.remove(d, add.id!);
    expect(del.ok && del.document.interactions.some((i) => i.id === conn.id)).toBe(false);
    if (del.ok) expect(integrationModule.schema.safeParse(del.document).success).toBe(true);
  });

  it('borrar un broker arrastra sus colas, sus interacciones y los pasos de flujo que las usaban', () => {
    const broker = doc.nodes.find((n) => n.kind === 'broker')!;
    const res = integrationEditor.remove(doc, broker.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(integrationModule.schema.safeParse(res.document).success).toBe(true);
    expect(res.document.nodes.some((n) => n.parentId === broker.id)).toBe(false);
  });

  it('rechaza conectar un nodo consigo mismo y renombrar a vacío', () => {
    const id = doc.nodes[0].id;
    expect(integrationEditor.addEdge(doc, 'event', id, id)).toMatchObject({ ok: false });
    expect(integrationEditor.update(doc, id, { name: '  ' })).toMatchObject({ ok: false });
  });

  it('la firma de estructura no cambia al editar una propiedad que no se dibuja', () => {
    const a = structureKey(integrationEditor.project(doc));
    const upd = integrationEditor.update(doc, doc.nodes[0].id, { owner: 'Equipo X' });
    expect(upd.ok && structureKey(integrationEditor.project(upd.document))).toBe(a);
  });
});
