import { describe, expect, it } from 'vitest';
import example from '../../../examples/ventas-datos.json';
import { columnsToText, dataEditor, parseColumns } from './editor';
import { dataModule } from './module';
import type { DataDocument } from './types';

const doc = dataModule.schema.parse(example) as DataDocument;
const valid = (d: DataDocument): boolean => dataModule.schema.safeParse(d).success;

describe('editor de datos', () => {
  it('el linaje dibuja los pipelines como nodos entre sus entradas y salidas, con los contenedores como zonas', () => {
    const g = dataEditor.project(doc, 'lineage');
    const pipelines = g.nodes.filter((n) => n.kind === 'pipeline');
    expect(pipelines.length).toBe(doc.pipelines.length);
    expect(g.edges.filter((e) => e.kind === 'pipeline').length).toBe(doc.pipelines.reduce((n, p) => n + p.inputs.length + p.outputs.length, 0));
    expect(g.nodes.find((n) => n.id === 'erp-pedidos')?.parentId).toBe('erp');
  });

  it('el ERD dibuja las entidades como fichas con sus columnas y las relaciones con su cardinalidad', () => {
    const g = dataEditor.project(doc, 'erd');
    const card = g.nodes.find((n) => n.id === 'erp-pedidos');
    expect(card?.lines?.length).toBeGreaterThan(0);
    expect(card?.parentId).toBeUndefined();
    expect(g.edges.find((e) => e.id === 'pedido-lineas')).toMatchObject({ kind: '1:N', source: 'erp-pedidos', target: 'erp-lineas' });
  });

  it('conectar dos activos con «pipeline» crea el pipeline; conectar con un pipeline añade entrada o salida', () => {
    const a = dataEditor.addEdge(doc, 'pipeline', 'panel-ventas', 'modelo-fuga');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(valid(a.document)).toBe(true);
    const created = a.document.pipelines[a.document.pipelines.length - 1];
    expect(created).toMatchObject({ inputs: ['panel-ventas'], outputs: ['modelo-fuga'] });
    const b = dataEditor.addEdge(a.document, 'pipeline', 'dwh-dim-cliente', a.id!);
    expect(b.ok && b.document.pipelines.find((p) => p.id === created.id)?.inputs).toEqual(['panel-ventas', 'dwh-dim-cliente']);
    if (!b.ok) return;
    // quitar la última salida se rechaza; quitar una de dos entradas se acepta
    expect(dataEditor.remove(b.document, `flow:${created.id}:out:modelo-fuga`)).toMatchObject({ ok: false });
    const c = dataEditor.remove(b.document, `flow:${created.id}:in:panel-ventas`);
    expect(c.ok && c.document.pipelines.find((p) => p.id === created.id)?.inputs).toEqual(['dwh-dim-cliente']);
  });

  it('las relaciones ER solo unen entidades y los pipelines no se añaden desde la paleta', () => {
    expect(dataEditor.canConnect?.(doc, '1:N', 'erp', 'erp-pedidos')).toMatch(/entidades/);
    expect(dataEditor.canConnect?.(doc, '1:N', 'erp-pedidos', 'bronze-pedidos')).toBeUndefined();
    expect(dataEditor.addNode(doc, 'pipeline', 'x')).toMatchObject({ ok: false });
    const t = dataEditor.addNode(doc, 'table', 'Devoluciones', 'erp');
    expect(t.ok && t.document.assets.find((a) => a.id === t.id)).toMatchObject({ kind: 'table', parentId: 'erp' });
  });

  it('las columnas se editan como texto y vuelven al modelo', () => {
    const cols = parseColumns('PK id: uuid\nnombre?: text (PII)\nFK,UK cliente_id: int\nsuelta');
    expect(cols).toEqual([
      { name: 'id', type: 'uuid', keys: ['pk'] },
      { name: 'nombre', type: 'text', nullable: true, pii: true },
      { name: 'cliente_id', type: 'int', keys: ['fk', 'uk'] },
      { name: 'suelta' },
    ]);
    expect(parseColumns(columnsToText(cols))).toEqual(cols);
    const u = dataEditor.update(doc, 'erp-pedidos', { columnsText: 'PK id: int\nimporte: decimal', classification: 'restricted' });
    expect(u.ok && u.document.assets.find((a) => a.id === 'erp-pedidos')).toMatchObject({ classification: 'restricted', columns: [{ name: 'id', type: 'int', keys: ['pk'] }, { name: 'importe', type: 'decimal' }] });
    if (u.ok) expect(valid(u.document)).toBe(true);
  });

  it('borrar un contenedor arrastra sus tablas, limpia pipelines y relaciones y deja un documento válido', () => {
    const r = dataEditor.remove(doc, 'erp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document.assets.some((a) => a.id === 'erp-pedidos')).toBe(false);
    expect(r.document.pipelines.some((p) => p.id === 'ingesta-erp')).toBe(false);
    expect(r.document.relations.some((x) => x.id === 'pedido-lineas')).toBe(false);
    expect(valid(r.document)).toBe(true);
  });

  it('editar un pipeline por su nodo cambia tipo y frecuencia', () => {
    const u = dataEditor.update(doc, 'pipeline:limpieza', { kind: 'streaming', schedule: 'continuo', anonymizes: true });
    expect(u.ok && u.document.pipelines.find((p) => p.id === 'limpieza')).toMatchObject({ kind: 'streaming', schedule: 'continuo', anonymizes: true });
    expect(dataEditor.read(doc, 'pipeline:limpieza')?.kind).toBe('pipeline');
  });
});
