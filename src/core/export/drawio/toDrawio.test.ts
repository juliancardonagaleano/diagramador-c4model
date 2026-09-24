import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { autoLayoutDocument } from '../../layout/elkLayout';
import { sampleDocument } from '../../model/sample';
import { toDrawio, DrawioExportError } from './toDrawio';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true });

describe('toDrawio', () => {
  it('falla si faltan posiciones', () => {
    expect(() => toDrawio(sampleDocument)).toThrow(DrawioExportError);
  });

  it('genera un mxfile con una página por vista y celdas C4', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid, { modified: new Date('2026-01-01T00:00:00Z') });
    expect(xml.startsWith('<mxfile')).toBe(true);
    const parsed = parser.parse(xml);
    const diagrams = [].concat(parsed.mxfile.diagram);
    expect(diagrams).toHaveLength(3);
    expect(diagrams.map((d: { '@_name': string }) => d['@_name'])).toEqual([
      'Contexto del sistema',
      'Contenedores',
      'Componentes de la API',
    ]);

    const contexto = diagrams[0] as { mxGraphModel: { root: { mxCell: unknown[]; object: Array<Record<string, unknown>> } } };
    const objects = contexto.mxGraphModel.root.object;
    const cliente = objects.find((o) => o['@_id'] === 'cliente')!;
    expect(cliente['@_c4Name']).toBe('Cliente personal');
    expect(cliente['@_c4Type']).toBe('Persona');
    const cell = cliente.mxCell as Record<string, unknown>;
    expect(String(cell['@_style'])).toContain('shape=mxgraph.c4.person2');
    expect(cell['@_vertex']).toBe('1');
    expect(xml).toContain('%c4Name%');
  });

  it('coloca los contenedores como hijos del boundary con geometría relativa', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid, { locale: 'en' });
    const parsed = parser.parse(xml);
    const diagrams = [].concat(parsed.mxfile.diagram) as Array<{
      mxGraphModel: { root: { object: Array<Record<string, unknown>> } };
    }>;
    const objects = diagrams[1].mxGraphModel.root.object;
    const banca = objects.find((o) => o['@_id'] === 'banca')!;
    expect(banca['@_c4Type']).toBe('System Scope Boundary');
    const bancaCell = banca.mxCell as { '@_parent': string; mxGeometry: Record<string, string> };
    expect(bancaCell['@_parent']).toBe('1');
    const api = objects.find((o) => o['@_id'] === 'api')!;
    const apiCell = api.mxCell as { '@_parent': string; mxGeometry: Record<string, string>; '@_style': string };
    expect(apiCell['@_parent']).toBe('banca');
    expect(Number(apiCell.mxGeometry['@_x'])).toBeGreaterThanOrEqual(0);
    expect(Number(apiCell.mxGeometry['@_y'])).toBeGreaterThanOrEqual(0);
    expect(Number(apiCell.mxGeometry['@_x'])).toBeLessThan(Number(bancaCell.mxGeometry['@_width']));
    const db = objects.find((o) => o['@_id'] === 'db')!;
    expect(String((db.mxCell as Record<string, unknown>)['@_style'])).toContain('shape=cylinder3');
    // La persona (fuera del boundary) cuelga de la capa raíz.
    const cliente = objects.find((o) => o['@_id'] === 'cliente')!;
    expect((cliente.mxCell as Record<string, unknown>)['@_parent']).toBe('1');
    // Relación api -> db como arista.
    const r11 = objects.find((o) => o['@_id'] === 'r11')!;
    const edge = r11.mxCell as Record<string, unknown>;
    expect(edge['@_edge']).toBe('1');
    expect(edge['@_source']).toBe('api');
    expect(edge['@_target']).toBe('db');
    expect(r11['@_c4Technology']).toBe('JDBC');
  });

  it('enlaza las páginas de niveles inferiores (C1 → C2 → C3) con link=data:page/id', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid);
    const parsed = parser.parse(xml);
    const diagrams = [].concat(parsed.mxfile.diagram) as Array<{ mxGraphModel: { root: { object: Array<Record<string, unknown>> } } }>;
    const ctx = diagrams[0].mxGraphModel.root.object;
    expect(ctx.find((o) => o['@_id'] === 'banca')?.['@_link']).toBe('data:page/id,contenedores');
    expect(ctx.find((o) => o['@_id'] === 'cliente')?.['@_link']).toBeUndefined();
    const cont = diagrams[1].mxGraphModel.root.object;
    expect(cont.find((o) => o['@_id'] === 'api')?.['@_link']).toBe('data:page/id,componentes-api');
    // Si la página hija no se exporta, no se enlaza.
    const only = toDrawio(laid, { viewIds: ['contexto'] });
    expect(only).not.toContain('data:page/id');
  });

  it('incluye los quiebres del autolayout como waypoints de las aristas', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid, { viewIds: ['contenedores'] });
    expect(xml).toContain('<Array as="points">');
    expect(xml).toMatch(/<mxPoint x="-?\d+" y="-?\d+"\/>/);
    const without = toDrawio(laid, { viewIds: ['contenedores'], waypoints: false });
    expect(without).not.toContain('<Array as="points">');
  });

  it('exporta con la notación de tarjetas (estilo drawdb)', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid, { notation: 'card' });
    const parsed = parser.parse(xml);
    const diagrams = [].concat(parsed.mxfile.diagram) as Array<{ mxGraphModel: { root: { object: Array<Record<string, unknown>> } } }>;
    const cont = diagrams[1].mxGraphModel.root.object;
    const api = cont.find((o) => o['@_id'] === 'api')!;
    const apiCell = api.mxCell as Record<string, string>;
    expect(apiCell['@_style']).toContain('fillColor=#F4F4F5');
    expect(apiCell['@_style']).not.toContain('mxgraph.c4');
    expect(String(api['@_label'])).toContain('background-color:#23A2D9');
    expect(String(api['@_label'])).toContain('%c4Name%');
    const cliente = cont.find((o) => o['@_id'] === 'cliente')!;
    expect(String(cliente['@_label'])).toContain('height:40px');
    const db = cont.find((o) => o['@_id'] === 'db')!;
    expect(String((db.mxCell as Record<string, string>)['@_style'])).toContain('shape=cylinder3');
    // Boundaries y relaciones no cambian.
    expect(String((cont.find((o) => o['@_id'] === 'banca')!.mxCell as Record<string, string>)['@_style'])).toContain('dashed=1');
    expect(xml).toContain('endArrow=blockThin');
  });

  it('escapa caracteres especiales en atributos', async () => {
    const doc = structuredClone(sampleDocument);
    doc.model.elements[0].name = 'Cliente <"VIP"> & más';
    const laid = await autoLayoutDocument(doc);
    const xml = toDrawio(laid, { viewIds: ['contexto'] });
    expect(xml).toContain('c4Name="Cliente &lt;&quot;VIP&quot;&gt; &amp; más"');
    expect(() => parser.parse(xml)).not.toThrow();
  });
});
