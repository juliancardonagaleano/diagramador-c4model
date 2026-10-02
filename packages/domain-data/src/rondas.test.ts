import { describe, expect, it } from 'vitest';
import example from '../../../examples/ventas-datos.json';
import { checkContract } from './contract';
import { dataEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toSvg } from './export/render';
import { dataModule } from './module';
import type { DataDocument } from './types';

const doc = dataModule.schema.parse(example) as DataDocument;
const valid = (d: DataDocument): boolean => dataModule.schema.safeParse(d).success;
const action = (id: string) => dataEditor.actions!.find((a) => a.id === id)!;

describe('editor de datos: notación, reglas, acciones y contratos', () => {
  it('el ERD dibuja la pata de gallo según la cardinalidad y resalta las claves de la ficha', () => {
    const g = dataEditor.project(doc, 'erd');
    expect(g.edges.find((e) => e.id === 'pedido-lineas')?.ends).toEqual({ source: 'one', target: 'many' });
    const lines = g.nodes.find((n) => n.id === 'erp-lineas');
    expect(lines?.lines?.[0]).toMatch(/^PK,FK pedido_id/);
    expect(lines?.lineEmphasis).toEqual(['key', 'key', undefined, undefined]);
    expect(g.nodes.find((n) => n.id === 'erp-pedidos')?.lineEmphasis).toEqual(['key', 'ref', undefined, undefined]);
    const nm = dataEditor.addEdge(doc, 'N:M', 'erp-pedidos', 'dwh-fact-ventas');
    if (!nm.ok) throw new Error('addEdge');
    expect(dataEditor.project(nm.document, 'erd').edges.find((e) => e.id === nm.id)?.ends).toEqual({ source: 'many', target: 'many' });
  });

  it('el SVG y el draw.io del ERD llevan la pata de gallo en lugar de la flecha', async () => {
    const svg = await toSvg(doc, 'erd');
    expect(svg).toMatch(/stroke-linecap="round"/);
    expect(svg).not.toMatch(/marker-end="url\(#arrow\)"/);
    expect(await toDrawio(doc)).toMatch(/startArrow=ERone;startFill=0;endArrow=ERmany/);
    expect(await toSvg(doc, 'lineage')).toMatch(/marker-end="url\(#arrow\)"/);
  });

  it('las figuras llevan insignias de candado, clasificación y falta de responsable', () => {
    const g = dataEditor.project(doc, 'lineage');
    expect(g.nodes.find((n) => n.id === 'bronze-clientes')?.badges).toEqual(['🔒 PII', 'confidencial']);
    expect(g.nodes.find((n) => n.id === 'erp-pedidos')?.badges).toEqual(['interna']);
    expect(g.nodes.find((n) => n.id === 'bronze-pedidos')?.badges).not.toContain('⚠ sin responsable');
    const ownerless = { ...doc, assets: doc.assets.map((a) => (a.id === 'lake' ? { ...a, owner: undefined } : a)) } as DataDocument;
    expect(dataEditor.project(ownerless, 'lineage').nodes.find((n) => n.id === 'bronze-pedidos')?.badges).toContain('⚠ sin responsable');
  });

  it('un informe solo lee, una fuente externa solo escribe y una tabla solo cuelga de un contenedor compatible', () => {
    expect(dataEditor.canConnect?.(doc, 'pipeline', 'panel-ventas', 'modelo-fuga')).toMatch(/solo lee/);
    expect(dataEditor.canConnect?.(doc, 'pipeline', 'bronze-pedidos', 'crm')).toMatch(/solo escribe/);
    expect(dataEditor.canConnect?.(doc, 'pipeline', 'pipeline:limpieza', 'crm')).toMatch(/solo escribe/);
    expect(dataEditor.canConnect?.(doc, 'pipeline', 'panel-ventas', 'pipeline:entrena-fuga')).toMatch(/solo lee/);
    expect(dataEditor.canConnect?.(doc, 'pipeline', 'crm', 'panel-ventas')).toBeUndefined();
    expect(dataEditor.addEdge(doc, 'pipeline', 'panel-ventas', 'modelo-fuga')).toMatchObject({ ok: false });
    expect(dataEditor.update(doc, 'erp-pedidos', { parentId: 'panel-ventas' })).toMatchObject({ ok: false, reason: expect.stringMatching(/solo cuelga de/) });
    const moved = dataEditor.update(doc, 'erp-pedidos', { parentId: 'dwh' });
    expect(moved.ok && moved.document.assets.find((a) => a.id === 'erp-pedidos')?.parentId).toBe('dwh');
    if (moved.ok) expect(valid(moved.document)).toBe(true);
    // Una tabla elegida como contenedor no contiene a otra: la nueva cuelga del contenedor de la elegida.
    const sibling = dataEditor.addNode(doc, 'table', 'Devoluciones', 'erp-pedidos');
    expect(sibling.ok && sibling.document.assets.find((a) => a.id === sibling.id)?.parentId).toBe('erp');
  });

  it('«Agrupar en dominio» asigna los activos seleccionados a un dominio, creándolo si falta', () => {
    const g = action('group-domain');
    expect(g.disabled?.(doc, ['pipeline:limpieza'])).toBeDefined();
    const r = g.run(doc, ['bronze-pedidos', 'bronze-clientes'], 'Datos crudos');
    if (!r.ok) throw new Error(r.reason);
    const created = r.document.domains.find((d) => d.name === 'Datos crudos');
    expect(created).toBeDefined();
    expect(r.document.assets.filter((a) => a.domainId === created!.id).map((a) => a.id)).toEqual(['bronze-clientes', 'bronze-pedidos']);
    expect(valid(r.document)).toBe(true);
    const existing = g.run(doc, ['bronze-pedidos'], 'ventas');
    expect(existing.ok && existing.document.domains.length).toBe(doc.domains.length);
    expect(g.run(doc, ['bronze-pedidos'], '  ')).toMatchObject({ ok: false });
  });

  it('«Propagar clasificación» sube lo que cuelga aguas abajo y se detiene en los pipelines que anonimizan', () => {
    const p = action('propagate-classification');
    expect(p.disabled?.(doc, ['crm-clientes'])).toMatch(/ya tiene/);
    const raised = dataEditor.update(doc, 'erp-pedidos', { classification: 'restricted' });
    if (!raised.ok) throw new Error('update');
    expect(p.disabled?.(raised.document, ['erp-pedidos'])).toBeUndefined();
    const r = p.run(raised.document, ['erp-pedidos']);
    if (!r.ok) throw new Error(r.reason);
    const level = (id: string) => r.document.assets.find((a) => a.id === id)?.classification;
    expect(['bronze-pedidos', 'silver-ventas', 'dwh-dim-cliente'].map(level)).toEqual(['restricted', 'restricted', 'restricted']);
    expect(level('dwh-fact-ventas')).toBe('internal');
    expect(valid(r.document)).toBe(true);
  });

  it('«Enmascarar» inserta un pipeline que anonimiza y hace que lo lean una copia sin datos personales', () => {
    const m = action('mask');
    expect(m.disabled?.(doc, ['panel-ventas'])).toBeDefined();
    const r = m.run(doc, ['crm-clientes']);
    if (!r.ok) throw new Error(r.reason);
    const masked = r.document.assets.find((a) => a.id === 'crm-clientes-anonimizado');
    expect(masked).toMatchObject({ kind: 'table', parentId: 'crm', classification: 'internal' });
    expect(masked?.columns?.some((c) => c.pii)).toBe(false);
    expect(r.document.pipelines.find((p) => p.id === 'enmascarar-crm-clientes')).toMatchObject({ anonymizes: true, inputs: ['crm-clientes'], outputs: ['crm-clientes-anonimizado'] });
    expect(r.document.pipelines.find((p) => p.id === 'ingesta-crm')?.inputs).toEqual(['crm-clientes-anonimizado']);
    expect(r.id).toBe('pipeline:enmascarar-crm-clientes');
    expect(valid(r.document)).toBe(true);
    // También se enmascara solo la entrada de un pipeline, seleccionando su arista.
    const edge = m.run(doc, ['flow:limpieza:in:bronze-clientes']);
    expect(edge.ok && edge.document.pipelines.find((p) => p.id === 'limpieza')?.inputs).toEqual(['bronze-pedidos', 'bronze-clientes-anonimizado']);
    expect(m.disabled?.(doc, ['flow:limpieza:out:silver-ventas'])).toBeDefined();
  });

  it('el mapa de calor colorea el linaje por clasificación o por datos personales', () => {
    expect(dataModule.views?.(doc).map((v) => v.id)).toEqual(expect.arrayContaining(['calor:clasificacion', 'calor:pii']));
    const byClass = dataEditor.project(doc, 'calor:clasificacion');
    expect(byClass.nodes.find((n) => n.id === 'erp-pedidos')?.fill).toBe('#ffd43b');
    expect(byClass.nodes.find((n) => n.id === 'bronze-clientes')?.fill).toBe('#ff922b');
    expect(dataEditor.project(doc, 'calor:pii').nodes.find((n) => n.id === 'bronze-clientes')?.fill).toBe('#e03131');
    expect(dataEditor.project(doc, 'lineage').nodes.find((n) => n.id === 'bronze-clientes')?.fill).toBeUndefined();
  });

  it('el contrato de datos es un adjunto YAML que se crea desde el activo, se valida y se reformatea', () => {
    const at = dataEditor.attachments!;
    const made = at.createFor!(doc, 'erp-pedidos');
    if (!made.ok) throw new Error(made.reason);
    expect(valid(made.document)).toBe(true);
    expect(made.document.assets.find((a) => a.id === 'erp-pedidos')?.contractId).toBe(made.id);
    const detail = at.read(made.document, made.id!)!;
    expect(detail.usedBy.map((u) => u.id)).toEqual(['erp-pedidos']);
    expect(detail.text).toMatch(/primaryKey: true/);
    expect(detail.text).toMatch(/logicalType: integer/);
    expect(at.check('odcs', detail.text).filter((d) => d.severity !== 'info')).toEqual([]);
    expect(at.summary?.('odcs', detail.text)?.[1]).toMatch(/pedidos: 4 propiedades/);
    const broken = detail.text.replace('logicalType: integer', 'logicalType: entero').replace('kind: DataContract', 'kind: Otro');
    const errors = checkContract(broken).filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.message)).toEqual([expect.stringMatching(/«kind»/), expect.stringMatching(/Tipo lógico desconocido/)]);
    expect(errors[0].line).toBeGreaterThan(0);
    expect(checkContract('a: [1')[0]).toMatchObject({ severity: 'error', line: 1 });
    expect(at.reformat('odcs', 'kind:   DataContract', { name: 'x' })).toMatchObject({ ok: true, text: 'kind: DataContract\n' });
    expect(at.transforms?.[0].run(detail.text, { name: 'x', format: 'odcs' })).toMatchObject({ ok: true });
    const gone = at.remove(made.document, made.id!);
    if (!gone.ok) throw new Error(gone.reason);
    expect(gone.document.assets.find((a) => a.id === 'erp-pedidos')?.contractId).toBeUndefined();
    expect(valid(gone.document)).toBe(true);
    expect(dataEditor.update(doc, 'erp-pedidos', { contractId: 'nada' })).toMatchObject({ ok: false });
  });
});
