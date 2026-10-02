// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';
import { dataAiSpec, toGenerated } from './ai/generation';
import { dataEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { dataModule } from './module';
import { erSymbols, multiplicities } from './relations';
import { validateDataDocument } from './schema';
import type { DataDocument, Relation } from './types';
import { ERD_UML_VIEW_ID, erdUmlView, exportViews, findView, listViews, viewRefs } from './views';

const parse = (input: unknown): DataDocument => {
  const r = validateDataDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};
const doc = parse(JSON.parse(readFileSync('examples/ventas-datos.json', 'utf8')));
const rel = (cardinality: Relation['cardinality'], extra: Partial<Relation> = {}): Relation => ({ id: 'r', sourceId: 'a', targetId: 'b', cardinality, ...extra });

describe('multiplicidades UML de una relación', () => {
  it('se derivan de la cardinalidad: uno es «1» y varios es «0..*»', () => {
    expect(multiplicities(rel('1:N'))).toEqual({ source: '1', target: '0..*' });
    expect(multiplicities(rel('N:1'))).toEqual({ source: '0..*', target: '1' });
    expect(multiplicities(rel('1:1'))).toEqual({ source: '1', target: '1' });
    expect(multiplicities(rel('N:M'))).toEqual({ source: '0..*', target: '0..*' });
  });

  it('la opcionalidad de cada extremo da «0..1» y «1..*»', () => {
    expect(multiplicities(rel('1:N', { sourceMin: 0, targetMin: 1 }))).toEqual({ source: '0..1', target: '1..*' });
    expect(multiplicities(rel('1:1', { targetMin: 0 }))).toEqual({ source: '1', target: '0..1' });
    expect(multiplicities(rel('N:M', { sourceMin: 1, targetMin: 1 }))).toEqual({ source: '1..*', target: '1..*' });
    // Lo que coincide con el valor por defecto no cambia nada.
    expect(multiplicities(rel('1:N', { sourceMin: 1, targetMin: 0 }))).toEqual(multiplicities(rel('1:N')));
  });

  it('en Mermaid (erDiagram) usa los remates del estándar', () => {
    expect(erSymbols(rel('1:N'))).toEqual({ left: '||', right: 'o{' });
    expect(erSymbols(rel('1:N', { sourceMin: 0, targetMin: 1 }))).toEqual({ left: '|o', right: '|{' });
    expect(erSymbols(rel('N:1', { sourceMin: 1 }))).toEqual({ left: '}|', right: '||' });
    expect(erSymbols(rel('1:1', { targetMin: 0 }))).toEqual({ left: '||', right: 'o|' });
  });

  it('el documento acepta sourceMin y targetMin solo con 0 o 1', () => {
    const relation = { id: 'x', sourceId: 'erp-pedidos', targetId: 'erp-lineas', cardinality: '1:N' };
    expect(validateDataDocument({ ...doc, relations: [{ ...relation, targetMin: 1 }] }).ok).toBe(true);
    expect(validateDataDocument({ ...doc, relations: [{ ...relation, targetMin: 2 }] }).ok).toBe(false);
    expect(validateDataDocument({ ...doc, relations: [{ ...relation, sourceMin: '0' }] }).ok).toBe(false);
  });
});

describe('el ERD como variante de notación', () => {
  it('el lienzo ofrece «Pata de gallo» y «UML» en un selector «Notación», aparte de «Vista»', () => {
    const refs = viewRefs(doc);
    expect(refs.find((v) => v.id === 'erd')).toMatchObject({ variantLabel: 'Pata de gallo', variantsLabel: 'Notación' });
    expect(refs.find((v) => v.id === ERD_UML_VIEW_ID)).toMatchObject({ variantOf: 'erd', variantLabel: 'UML', variantsLabel: 'Notación' });
    expect(refs.filter((v) => !v.variantOf).map((v) => v.id)).toEqual(expect.arrayContaining(['lineage', 'erd']));
    expect(refs.filter((v) => !v.variantOf).map((v) => v.id)).not.toContain('erd:uml');
    expect(dataModule.views?.(doc)).toEqual(refs);
    expect(refs.find((v) => v.id === 'lineage')?.variantOf).toBeUndefined();
  });

  it('la pata de gallo sigue siendo la vista por defecto y la lista de vistas no cambia', () => {
    expect(listViews(doc).map((v) => v.id)).toEqual(['lineage', 'erd', 'domain:ventas', 'domain:clientes', 'domain:plataforma']);
    expect(findView(doc, 'erd')).toMatchObject({ type: 'erd', notation: 'crowfoot' });
    expect(findView(doc, 'erd:uml')).toMatchObject({ id: 'erd:uml', type: 'erd', notation: 'uml', title: expect.stringContaining('(UML)') });
    expect(exportViews(doc).map((v) => v.id)).toEqual(['lineage', 'erd', 'erd:uml', 'domain:ventas', 'domain:clientes', 'domain:plataforma']);
  });

  it('un documento sin modelo entidad-relación no ofrece la variante', () => {
    const lineageOnly = parse({ assets: [{ id: 'a', kind: 'source', name: 'A' }] });
    expect(erdUmlView(lineageOnly)).toBeUndefined();
    expect(viewRefs(lineageOnly).map((v) => v.id)).toEqual(['lineage']);
    expect(() => findView(lineageOnly, 'erd:uml')).toThrow(/No existe la vista «erd:uml»/);
  });

  it('el error de una vista desconocida enumera también la variante UML', () => {
    expect(() => findView(doc, 'nada')).toThrow(/erd:uml/);
  });
});

describe('lienzo', () => {
  it('con la pata de gallo los extremos llevan su remate y no su multiplicidad', () => {
    const edge = dataEditor.project(doc, 'erd').edges.find((e) => e.id === 'pedido-lineas')!;
    expect(edge.ends).toEqual({ source: 'one', target: 'many' });
    expect(edge.endLabels).toBeUndefined();
  });

  it('en UML escribe la multiplicidad junto a cada extremo, sin remates de pata de gallo', () => {
    const g = dataEditor.project(doc, 'erd:uml');
    expect(g.nodes.map((n) => n.id).sort()).toEqual(dataEditor.project(doc, 'erd').nodes.map((n) => n.id).sort());
    expect(g.nodes.find((n) => n.id === 'erp-lineas')?.lines?.[0]).toMatch(/^PK,FK pedido_id/);
    const lines = g.edges.find((e) => e.id === 'pedido-lineas')!;
    expect(lines.endLabels).toEqual({ source: '1', target: '1..*' });
    expect(lines.ends).toBeUndefined();
    expect(lines.label).toBe('contiene');
    expect(g.edges.find((e) => e.id === 'cliente-ventas')?.endLabels).toEqual({ source: '1', target: '0..*' });
  });

  it('el panel de propiedades edita el mínimo de cada extremo', () => {
    const fields = dataEditor.fields({ type: 'edge', kind: '1:N' }, doc).map((f) => f.key);
    expect(fields).toEqual(['cardinality', 'sourceMin', 'targetMin', 'description']);
    expect(dataEditor.read(doc, 'pedido-lineas')?.values).toMatchObject({ targetMin: 1 });
    const r = dataEditor.update(doc, 'cliente-ventas', { sourceMin: '0', targetMin: '1' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.document.relations.find((x) => x.id === 'cliente-ventas')).toMatchObject({ sourceMin: 0, targetMin: 1 });
    expect(parse(r.document)).toBeDefined();
    expect(dataEditor.project(r.document, 'erd:uml').edges.find((e) => e.id === 'cliente-ventas')?.endLabels).toEqual({ source: '0..1', target: '1..*' });
    // Vaciar el campo vuelve al valor por defecto.
    const cleared = dataEditor.update(r.document, 'cliente-ventas', { sourceMin: '', targetMin: '' });
    expect(cleared.ok && cleared.document.relations.find((x) => x.id === 'cliente-ventas')).not.toHaveProperty('sourceMin');
    expect(dataEditor.update(doc, 'cliente-ventas', { targetMin: '7' })).toMatchObject({ ok: false, reason: expect.stringMatching(/0 \(opcional\) o 1/) });
  });
});

describe('exportaciones del ERD en UML', () => {
  it('SVG: multiplicidades junto a los extremos y líneas sin flecha ni pata de gallo', async () => {
    const svg = await toSvg(doc, 'erd:uml');
    expect(svg).toContain('(UML)');
    for (const m of ['>1<', '>1..*<', '>0..*<']) expect(svg).toContain(m);
    expect(svg).not.toMatch(/marker-end/);
    expect(svg).toContain('>contiene<');
    const crow = await toSvg(doc, 'erd');
    expect(crow).not.toContain('>1..*<');
    expect(crow).toContain('contiene (1:N)');
  });

  it('draw.io: una página más con la variante UML y las multiplicidades como etiquetas de la arista', async () => {
    const xml = await toDrawio(doc);
    const pages = [].concat(new XMLParser({ ignoreAttributes: false }).parse(xml).mxfile.diagram) as Array<{ '@_id': string; mxGraphModel: { root: { mxCell: Array<Record<string, string>> } } }>;
    expect(pages.map((p) => p['@_id'])).toEqual(['lineage', 'erd', 'erd:uml', 'domain:ventas', 'domain:clientes', 'domain:plataforma']);
    const cells = pages.find((p) => p['@_id'] === 'erd:uml')!.mxGraphModel.root.mxCell;
    const edge = cells.find((c) => c['@_id'] === 'e-pedido-lineas')!;
    expect(edge['@_style']).toMatch(/startArrow=none;endArrow=none/);
    expect(edge['@_value']).toBe('contiene');
    const labels = cells.filter((c) => c['@_parent'] === 'e-pedido-lineas').map((c) => [c['@_id'], c['@_value']]);
    expect(labels).toEqual([['e-pedido-lineas-source', '1'], ['e-pedido-lineas-target', '1..*']]);
    const crow = pages.find((p) => p['@_id'] === 'erd')!.mxGraphModel.root.mxCell.find((c) => c['@_id'] === 'e-pedido-lineas')!;
    expect(crow['@_style']).toMatch(/startArrow=ERone;startFill=0;endArrow=ERmany/);
  });

  it('Mermaid: classDiagram con la multiplicidad entre comillas junto a cada clase, y es válido', async () => {
    const text = toMermaid(doc, { viewId: 'erd:uml' });
    expect(text).toMatch(/^---\ntitle: Modelo entidad-relación \(UML\) - Plataforma de datos de ventas\n---\nclassDiagram/);
    expect(text).toContain('class erp_lineas["líneas de pedido"] {');
    expect(text).toContain('+bigint pedido_id PK, FK');
    expect(text).toContain('erp_pedidos "1" -- "1..*" erp_lineas : contiene');
    expect(text).toContain('dwh_dim_cliente "1" -- "0..*" dwh_fact_ventas : compra');
    await expect(mermaid.parse(text)).resolves.toBeTruthy();
    await expect(mermaid.parse(toMermaid(doc, { viewId: 'erd' }))).resolves.toBeTruthy();
  });

  it('Mermaid: tipos con paréntesis o comas no rompen la clase', async () => {
    const tricky = parse({
      assets: [
        { id: 'a', kind: 'table', name: 'A', columns: [{ name: 'precio', type: 'numeric(10,2)', keys: ['pk'] }, { name: 'nombre', type: 'varchar(30)' }] },
        { id: 'b', kind: 'table', name: 'B', columns: [{ name: 'id' }] },
      ],
      relations: [{ id: 'ab', sourceId: 'a', targetId: 'b', cardinality: 'N:M', sourceMin: 1 }],
    });
    const text = toMermaid(tricky, { viewId: 'erd:uml' });
    expect(text).toContain('+numeric_10_2 precio PK');
    expect(text).toContain('a "1..*" -- "0..*" b');
    await expect(mermaid.parse(text)).resolves.toBeTruthy();
  });

  it('el ERD de pata de gallo en Mermaid refleja la opcionalidad con los remates del estándar', async () => {
    const d = parse({
      assets: [
        { id: 'a', kind: 'table', name: 'A', columns: [{ name: 'id' }] },
        { id: 'b', kind: 'table', name: 'B', columns: [{ name: 'id' }] },
      ],
      relations: [{ id: 'ab', sourceId: 'a', targetId: 'b', cardinality: '1:N', sourceMin: 0, targetMin: 1 }],
    });
    const text = toMermaid(d, { viewId: 'erd' });
    expect(text).toContain('a |o--|{ b');
    await expect(mermaid.parse(text)).resolves.toBeTruthy();
  });
});

describe('importación de Mermaid: la opcionalidad se conserva solo si no es la habitual', () => {
  it('ida y vuelta de |o y |{', () => {
    const d = parse({
      assets: [
        { id: 'a', kind: 'table', name: 'A', columns: [{ name: 'id' }] },
        { id: 'b', kind: 'table', name: 'B', columns: [{ name: 'id' }] },
        { id: 'c', kind: 'table', name: 'C', columns: [{ name: 'id' }] },
      ],
      relations: [
        { id: 'ab', sourceId: 'a', targetId: 'b', cardinality: '1:N', sourceMin: 0, targetMin: 1 },
        { id: 'bc', sourceId: 'b', targetId: 'c', cardinality: '1:N' },
      ],
    });
    const { document } = fromMermaid(toMermaid(d, { viewId: 'erd' }));
    expect(document.relations.map((r) => [r.cardinality, r.sourceMin, r.targetMin])).toEqual([
      ['1:N', 0, 1],
      ['1:N', undefined, undefined],
    ]);
    expect(document.relations[1]).not.toHaveProperty('sourceMin');
    expect(document.relations[1]).not.toHaveProperty('targetMin');
  });

  it('un erDiagram escrito a mano con }| y o|', () => {
    const { document } = fromMermaid('erDiagram\n A }|--o| B : x\n C ||--o{ D : y');
    expect(document.relations.map((r) => [r.cardinality, r.sourceMin, r.targetMin])).toEqual([
      ['N:1', 1, 0],
      ['1:N', undefined, undefined],
    ]);
  });
});

describe('IA', () => {
  it('el esquema de generación incluye el mínimo de cada extremo y lo recupera al refinar', () => {
    const schema = dataAiSpec.generationJsonSchema() as { properties: { relations: { items: { properties: Record<string, unknown> } } } };
    expect(Object.keys(schema.properties.relations.items.properties)).toEqual(expect.arrayContaining(['sourceMin', 'targetMin']));
    expect(toGenerated(doc).relations.find((r) => r.id === 'pedido-lineas')).toMatchObject({ sourceMin: null, targetMin: 1 });
    expect(dataAiSpec.system()).toContain('sourceMin / targetMin');
    const back = dataAiSpec.toDocument(toGenerated(doc));
    expect(back.ok && (back.document as DataDocument).relations.find((r) => r.id === 'pedido-lineas')).toMatchObject({ targetMin: 1 });
  });
});
