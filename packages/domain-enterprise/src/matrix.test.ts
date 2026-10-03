import { readFileSync } from 'node:fs';
import type { GraphLayout } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { enterpriseCommands } from './commands';
import { enterpriseEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutMatrix, matrixCellId, matrixScene, parseMatrixCell, toSvg, wrapText } from './export/render';
import { applicationsByCapability } from './graph';
import { buildMatrix, capabilityRows, cellKey } from './matrix';
import { enterpriseModule } from './module';
import { formatEnterpriseIssues, validateEnterpriseDocument } from './schema';
import type { EnterpriseDocument } from './types';
import { findView, listViews, viewRefs } from './views';

const parse = (input: unknown): EnterpriseDocument => {
  const r = validateEnterpriseDocument(input);
  if (!r.ok) throw new Error(formatEnterpriseIssues(r.issues));
  return r.document;
};
const example = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as unknown;
const sample = parse(example);

/**
 * Un documento pequeño con cada caso de la regla: una agrupación con tres hojas, un hueco, una convivencia en transición, otra con
 * criterio declarado, otra sin criterio, un soporte por un proceso, una aplicación retirada y otra que no soporta nada.
 */
const small = parse({
  version: '1.0',
  workspace: { name: 'Pequeña' },
  capabilities: [
    { id: 'ventas', name: 'Ventas' },
    { id: 'online', name: 'Ventas online', parentId: 'ventas' },
    { id: 'pedidos', name: 'Pedidos', parentId: 'ventas' },
    { id: 'precios', name: 'Precios', parentId: 'ventas' },
    { id: 'logistica', name: 'Logística' },
    { id: 'inventario', name: 'Inventario', parentId: 'logistica' },
    { id: 'envios', name: 'Envíos', parentId: 'logistica' },
    { id: 'cobros', name: 'Cobros', parentId: 'logistica' },
    { id: 'rrhh', name: 'Recursos humanos' },
    { id: 'archivo', name: 'Archivo' },
  ],
  processes: [{ id: 'alta', name: 'Alta de pedido' }],
  applications: [
    { id: 'web', name: 'Tienda web', criticality: 'critical' },
    { id: 'erp', name: 'ERP', criticality: 'high' },
    { id: 'crm', name: 'CRM', criticality: 'medium' },
    { id: 'wms-viejo', name: 'WMS viejo', lifecycle: 'sunset' },
    { id: 'wms-nuevo', name: 'WMS nuevo', lifecycle: 'planned' },
    { id: 'pagos', name: 'Pagos', criticality: 'low' },
    { id: 'pasarela', name: 'Pasarela' },
    { id: 'antigua', name: 'Antigua', lifecycle: 'retired' },
    { id: 'suelta', name: 'Suelta' },
  ],
  relations: [
    // Ventas online: directa (web) y por un proceso (erp soporta «alta», que realiza «pedidos»).
    { id: 'a', kind: 'supports', sourceId: 'web', targetId: 'online' },
    { id: 'b', kind: 'supports', sourceId: 'erp', targetId: 'alta' },
    { id: 'c', kind: 'realizes', sourceId: 'alta', targetId: 'pedidos' },
    // Pedidos: también directa de la web (directa + por un proceso, que cuenta una vez) y del CRM: dos aplicaciones sin criterio.
    { id: 'd', kind: 'supports', sourceId: 'web', targetId: 'pedidos' },
    { id: 'e', kind: 'supports', sourceId: 'crm', targetId: 'pedidos' },
    // Inventario: un reemplazo en curso.
    { id: 'f', kind: 'supports', sourceId: 'wms-viejo', targetId: 'inventario' },
    { id: 'g', kind: 'supports', sourceId: 'wms-nuevo', targetId: 'inventario' },
    // Envíos: una sola.
    { id: 'h', kind: 'supports', sourceId: 'erp', targetId: 'envios' },
    // Cobros: dos con criterio declarado, y una retirada que no cuenta.
    { id: 'i', kind: 'supports', sourceId: 'pagos', targetId: 'cobros', description: 'tarjetas' },
    { id: 'j', kind: 'supports', sourceId: 'pasarela', targetId: 'cobros', description: 'transferencias' },
    { id: 'k', kind: 'supports', sourceId: 'antigua', targetId: 'cobros' },
    // Archivo: dos, solo una con criterio (la otra es la principal).
    { id: 'l', kind: 'supports', sourceId: 'erp', targetId: 'archivo' },
    { id: 'm', kind: 'supports', sourceId: 'pagos', targetId: 'archivo', description: 'contingencia' },
  ],
});

describe('regla de soporte de la matriz capacidad × aplicación', () => {
  const matrix = buildMatrix(small);
  const row = (id: string) => matrix.rows.find((r) => r.capability.id === id)!;
  const cell = (capability: string, application: string) => matrix.cells.get(cellKey(capability, application));

  it('las filas siguen el árbol de capacidades, con su nivel, y las columnas el orden de las aplicaciones', () => {
    expect(matrix.rows.map((r) => [r.capability.id, r.depth])).toEqual([
      ['ventas', 0],
      ['online', 1],
      ['pedidos', 1],
      ['precios', 1],
      ['logistica', 0],
      ['inventario', 1],
      ['envios', 1],
      ['cobros', 1],
      ['rrhh', 0],
      ['archivo', 0],
    ]);
    expect(matrix.rows.filter((r) => r.group).map((r) => r.capability.id)).toEqual(['ventas', 'logistica']);
    expect(matrix.columns.map((c) => c.application.id)).toEqual(small.applications.map((a) => a.id));
    expect(capabilityRows(small).map((r) => r.capability.id)).toEqual(matrix.rows.map((r) => r.capability.id));
  });

  it('soporte directo: una relación `supports` de la aplicación a la capacidad', () => {
    expect(cell('online', 'web')).toMatchObject({ support: 'direct', direct: { id: 'a' }, processIds: [] });
  });

  it('soporte por un proceso: la aplicación soporta un proceso que realiza la capacidad', () => {
    expect(cell('pedidos', 'erp')).toMatchObject({ support: 'process', processIds: ['alta'] });
    expect(cell('pedidos', 'erp')?.direct).toBeUndefined();
  });

  it('si es directo y por un proceso, la celda es directa y cuenta una sola vez', () => {
    const both = parse({
      version: '1.0',
      workspace: { name: 'x' },
      capabilities: [{ id: 'c', name: 'C' }],
      processes: [{ id: 'p', name: 'P' }],
      applications: [{ id: 'a', name: 'A' }],
      relations: [
        { id: '1', kind: 'supports', sourceId: 'a', targetId: 'c' },
        { id: '2', kind: 'supports', sourceId: 'a', targetId: 'p' },
        { id: '3', kind: 'realizes', sourceId: 'p', targetId: 'c' },
      ],
    });
    const m = buildMatrix(both);
    expect(m.cells.get(cellKey('c', 'a'))).toMatchObject({ support: 'direct', processIds: ['p'] });
    expect(m.rows[0].own).toEqual(['a']);
    expect(m.columns[0].capabilities).toBe(1);
  });

  it('una agrupación muestra como heredadas las aplicaciones de sus descendientes, que no cuentan como soporte propio', () => {
    expect(cell('ventas', 'web')).toMatchObject({ support: 'inherited' });
    expect(cell('ventas', 'crm')).toMatchObject({ support: 'inherited' });
    expect(row('ventas').own).toEqual([]);
    expect(row('ventas').all).toEqual(['web', 'erp', 'crm']);
    expect(matrix.columns.find((c) => c.application.id === 'web')!.capabilities).toBe(2);
    expect(row('ventas').status).toBe('none');
  });

  it('una agrupación con soporte propio lo marca como directo y no como heredado', () => {
    const grouped = parse({
      version: '1.0',
      workspace: { name: 'x' },
      capabilities: [{ id: 'g', name: 'G' }, { id: 'h', name: 'H', parentId: 'g' }],
      applications: [{ id: 'a', name: 'A' }],
      relations: [{ id: '1', kind: 'supports', sourceId: 'a', targetId: 'g' }, { id: '2', kind: 'supports', sourceId: 'a', targetId: 'h' }],
    });
    expect(buildMatrix(grouped).cells.get(cellKey('g', 'a'))?.support).toBe('direct');
  });

  it('coincide con applicationsByCapability, con y sin acumular por el árbol', () => {
    for (const d of [small, sample]) {
      const m = buildMatrix(d);
      const own = applicationsByCapability(d);
      const total = applicationsByCapability(d, { rollup: true });
      for (const r of m.rows) {
        expect(new Set(r.own), r.capability.id).toEqual(own.get(r.capability.id));
        expect(new Set(r.all), r.capability.id).toEqual(total.get(r.capability.id));
      }
    }
  });

  it('el criterio de una celda es la descripción de su relación `supports`', () => {
    expect(cell('cobros', 'pagos')?.criterion).toBe('tarjetas');
    expect(cell('online', 'web')?.criterion).toBeUndefined();
  });
});

describe('avisos de la matriz: huecos y solapamientos', () => {
  const matrix = buildMatrix(small);
  const status = (id: string) => matrix.rows.find((r) => r.capability.id === id)!.status;

  it('un hueco es una capacidad sin hijas que ninguna aplicación soporta; una agrupación vacía no lo es', () => {
    expect(status('rrhh')).toBe('gap');
    expect(status('precios')).toBe('gap');
    expect(status('ventas')).toBe('none');
  });

  it('dos aplicaciones vigentes sin criterio son un solapamiento', () => {
    expect(status('pedidos')).toBe('overlap');
  });

  it('una convivencia es una transición si alguna está prevista, en retirada o con estrategia de migrar, reemplazar o retirar', () => {
    expect(status('inventario')).toBe('transition');
    const migrating = parse({
      version: '1.0',
      workspace: { name: 'x' },
      capabilities: [{ id: 'c', name: 'C' }],
      applications: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', strategy: 'migrate' }],
      relations: [{ id: '1', kind: 'supports', sourceId: 'a', targetId: 'c' }, { id: '2', kind: 'supports', sourceId: 'b', targetId: 'c' }],
    });
    expect(buildMatrix(migrating).rows[0].status).toBe('transition');
  });

  it('tiene criterio si todas menos como mucho una (la principal) lo declaran en la descripción de su relación', () => {
    expect(status('archivo')).toBe('criterion');
    expect(status('cobros')).toBe('criterion');
    const undescribed = parse({
      version: '1.0',
      workspace: { name: 'x' },
      capabilities: [{ id: 'c', name: 'C' }],
      applications: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'd', name: 'D' }],
      relations: ['a', 'b', 'd'].map((app, i) => ({ id: String(i), kind: 'supports', sourceId: app, targetId: 'c', ...(app === 'a' ? { description: 'canal web' } : {}) })),
    });
    expect(buildMatrix(undescribed).rows[0].status).toBe('overlap');
  });

  it('una aplicación retirada no cuenta para el solapamiento', () => {
    expect(matrix.rows.find((r) => r.capability.id === 'cobros')!.inForce).toEqual(['pagos', 'pasarela']);
    const onlyOne = parse({
      version: '1.0',
      workspace: { name: 'x' },
      capabilities: [{ id: 'c', name: 'C' }],
      applications: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', lifecycle: 'retired' }],
      relations: [{ id: '1', kind: 'supports', sourceId: 'a', targetId: 'c' }, { id: '2', kind: 'supports', sourceId: 'b', targetId: 'c' }],
    });
    expect(buildMatrix(onlyOne).rows[0].status).toBe('single');
  });

  it('una sola aplicación no es solapamiento', () => {
    expect(status('envios')).toBe('single');
    expect(status('online')).toBe('single');
  });

  it('el resumen cuenta hojas, cobertura, huecos, solapamientos, convivencias con razón y aplicaciones sin capacidad', () => {
    expect(matrix.summary).toEqual({ leaves: 8, covered: 6, gaps: 2, overlaps: 1, explained: 3, idleApplications: 1 });
    expect(matrix.columns.find((c) => c.application.id === 'suelta')!.capabilities).toBe(0);
  });

  it('el ejemplo no tiene huecos y sus solapamientos son los de varias aplicaciones sin criterio', () => {
    const m = buildMatrix(sample);
    expect(m.summary).toMatchObject({ leaves: 12, covered: 12, gaps: 0, idleApplications: 0 });
    expect(m.rows.filter((r) => r.status === 'overlap').map((r) => r.capability.id)).toEqual(['gestion-pedidos', 'facturacion', 'cobros', 'atencion-cliente']);
    expect(m.rows.filter((r) => r.status === 'transition').map((r) => r.capability.id)).toEqual(['gestion-inventario']);
  });
});

describe('vistas: la matriz y el paisaje sin relaciones', () => {
  it('la matriz sale tras el paisaje cuando hay capacidades y aplicaciones, con las capacidades en el orden del árbol y las relaciones `supports`', () => {
    const ids = listViews(sample).map((v) => v.id);
    expect(ids.slice(0, 3)).toEqual(['capabilities', 'landscape', 'matrix']);
    const view = findView(sample, 'matrix');
    expect(view).toMatchObject({ id: 'matrix', type: 'matrix', title: 'Matriz capacidad × aplicación - Comercio Andino - arquitectura empresarial' });
    expect(view.elementIds.slice(0, 3)).toEqual(['gestion-comercial', 'ventas-online', 'gestion-pedidos']);
    expect(view.elementIds).toHaveLength(sample.capabilities.length + sample.applications.length);
    expect(view.relationIds).toEqual(sample.relations.filter((r) => r.kind === 'supports' && sample.applications.some((a) => a.id === r.sourceId) && sample.capabilities.some((c) => c.id === r.targetId)).map((r) => r.id));
    expect(viewRefs(sample).find((v) => v.id === 'matrix')).toEqual({ id: 'matrix', title: view.title });
  });

  it('sin capacidades o sin aplicaciones no hay matriz', () => {
    expect(listViews(parse({ capabilities: [{ id: 'a', name: 'A' }] })).some((v) => v.id === 'matrix')).toBe(false);
    expect(listViews(parse({ applications: [{ id: 'a', name: 'A' }] })).some((v) => v.id === 'matrix')).toBe(false);
  });

  it('un documento sin relaciones tiene paisaje en cuanto hay algo que dibujar', () => {
    const apps = parse({ applications: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    expect(listViews(apps).map((v) => v.id)).toEqual(['landscape']);
    expect(findView(apps).elementIds).toEqual(['a', 'b']);
    expect(findView(apps).relationIds).toEqual([]);
    const caps = parse({ capabilities: [{ id: 'g', name: 'G' }, { id: 'h', name: 'H', parentId: 'g' }] });
    expect(listViews(caps).map((v) => v.id)).toEqual(['capabilities', 'landscape']);
    expect(findView(caps, 'landscape').elementIds).toEqual(['h']);
  });

  it('con unidades y sin relaciones el paisaje existe y el lienzo las alcanza todas', () => {
    const units = parse({ units: [{ id: 'dir', name: 'Dirección' }, { id: 'eq', name: 'Equipo', parentId: 'dir' }] });
    expect(listViews(units).map((v) => v.id)).toEqual(['landscape']);
    expect(findView(units).elementIds).toEqual(['dir', 'eq']);
    expect(enterpriseEditor.project(units, 'landscape').nodes.map((n) => n.id)).toEqual(['dir', 'eq']);
    const mixed = parse({ units: [{ id: 'dir', name: 'Dirección' }, { id: 'eq', name: 'Equipo', parentId: 'dir' }], applications: [{ id: 'a', name: 'A' }] });
    expect(enterpriseEditor.project(mixed, 'landscape').nodes.map((n) => n.id).sort()).toEqual(['a', 'dir', 'eq']);
  });

  it('un documento vacío sigue sin vistas', () => {
    expect(listViews(parse({}))).toEqual([]);
  });

  it('el SVG y el lienzo del paisaje sin relaciones se dibujan', async () => {
    const apps = parse({ applications: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    const svg = await toSvg(apps);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('APLICACIÓN');
    expect(await toMermaid(apps)).toMatch(/^flowchart LR/);
  });
});

/** Cajas que se pisan (no debe haber ninguna). */
function overlaps(layout: GraphLayout): string[] {
  const found: string[] = [];
  layout.nodes.forEach((a, i) => {
    for (const b of layout.nodes.slice(i + 1)) if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) found.push(`${a.id} / ${b.id}`);
  });
  return found;
}

describe('dibujo de la matriz: cuadrícula, colores y avisos', () => {
  const scene = matrixScene(small);
  const style = (id: string) => scene.nodes.get(id)!;

  it('coloca una cabecera por capacidad y por aplicación, una celda por cada par, los totales y la clave, sin que se pisen', () => {
    const { layout } = scene;
    const cells = layout.nodes.filter((n) => n.id.startsWith('cell:'));
    expect(cells).toHaveLength(small.capabilities.length * small.applications.length);
    for (const c of small.capabilities) expect(layout.nodes.some((n) => n.id === c.id)).toBe(true);
    for (const a of small.applications) expect(layout.nodes.some((n) => n.id === a.id)).toBe(true);
    expect(layout.nodes.filter((n) => n.id.startsWith('total:row:'))).toHaveLength(small.capabilities.length);
    expect(layout.nodes.filter((n) => n.id.startsWith('total:column:'))).toHaveLength(small.applications.length);
    expect(overlaps(layout)).toEqual([]);
    expect(layout.groups).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.width <= layout.width && n.y + n.height <= layout.height)).toBe(true);
    expect(layoutMatrix(small)).toEqual(layout);
  });

  it('las filas hijas llevan sangría y las celdas de una columna comparten x', () => {
    const at = (id: string) => scene.layout.nodes.find((n) => n.id === id)!;
    expect(at('online').x).toBeGreaterThan(at('ventas').x);
    expect(at('online').x + at('online').width).toBe(at('ventas').x + at('ventas').width);
    expect(at(matrixCellId('online', 'web')).x).toBe(at('web').x);
    expect(at(matrixCellId('rrhh', 'web')).x).toBe(at('web').x);
    expect(at(matrixCellId('online', 'erp')).y).toBe(at('online').y);
  });

  it('las celdas con soporte llevan el color de la criticidad de la aplicación y una marca según el tipo de soporte', () => {
    expect(style(matrixCellId('online', 'web'))).toMatchObject({ label: '●', fill: '#ffa8a8' }); // crítica
    expect(style(matrixCellId('envios', 'erp'))).toMatchObject({ label: '●', fill: '#ffd8a8' }); // alta
    expect(style(matrixCellId('pedidos', 'crm'))).toMatchObject({ label: '●', fill: '#fff3bf' }); // media
    expect(style(matrixCellId('cobros', 'pagos'))).toMatchObject({ label: '●', fill: '#b2f2bb' }); // baja
    expect(style(matrixCellId('cobros', 'pasarela')).fill).toBe('#e9ecef'); // sin criticidad
    expect(style(matrixCellId('pedidos', 'erp'))).toMatchObject({ label: '○', dashed: true }); // por un proceso
    expect(style(matrixCellId('ventas', 'web'))).toMatchObject({ label: '·' }); // heredada, más pálida
    expect(style(matrixCellId('ventas', 'web')).fill).not.toBe('#ffa8a8');
    expect(style(matrixCellId('online', 'erp'))).toMatchObject({ label: '', fill: '#ffffff' });
  });

  it('un hueco se avisa con borde rojo discontinuo, celdas rosadas y «hueco» en su total; un solapamiento, en violeta', () => {
    expect(style('rrhh')).toMatchObject({ stroke: '#c92a2a', dashed: true });
    expect(style(matrixCellId('rrhh', 'web')).fill).toBe('#fff5f5');
    expect(style('total:row:rrhh')).toMatchObject({ label: '0', sublabel: 'hueco', stroke: '#c92a2a', dashed: true });
    expect(style('pedidos')).toMatchObject({ stroke: '#9c36b5' });
    expect(style(matrixCellId('pedidos', 'web')).stroke).toBe('#9c36b5');
    expect(style('total:row:pedidos')).toMatchObject({ label: '3', sublabel: 'solapamiento', fill: '#f3d9fa' });
    expect(style('total:row:inventario')).toMatchObject({ label: '2', sublabel: 'transición' });
    expect(style('total:row:envios')).toMatchObject({ label: '1' });
    expect(style('total:row:envios').sublabel).toBeUndefined();
  });

  it('los totales por columna y el de cobertura; una aplicación sin capacidad se avisa', () => {
    expect(style('total:column:erp')).toMatchObject({ label: '3' });
    expect(style('total:column:web')).toMatchObject({ label: '2' });
    expect(style('total:column:suelta')).toMatchObject({ label: '0', sublabel: 'sin capacidad', stroke: '#c92a2a' });
    expect(style('suelta')).toMatchObject({ stroke: '#c92a2a', dashed: true });
    expect(style('total:all')).toMatchObject({ label: '6/8', sublabel: 'cubiertas' });
    expect(style('wms-viejo')).toMatchObject({ badges: ['en retirada'] });
  });

  it('los ids de las celdas se descodifican aunque los ids lleven «|»', () => {
    expect(parseMatrixCell(small, matrixCellId('online', 'web'))).toEqual({ capabilityId: 'online', applicationId: 'web' });
    expect(parseMatrixCell(small, 'cell:online|nada')).toBeUndefined();
    expect(parseMatrixCell(small, 'online')).toBeUndefined();
    const odd = parse({ capabilities: [{ id: 'a|b', name: 'A' }], applications: [{ id: 'c|d', name: 'B' }] });
    expect(parseMatrixCell(odd, matrixCellId('a|b', 'c|d'))).toEqual({ capabilityId: 'a|b', applicationId: 'c|d' });
  });

  it('wrapText parte por palabras y recorta con puntos suspensivos', () => {
    expect(wrapText('Facturación electrónica', 13, 3)).toEqual(['Facturación', 'electrónica']);
    expect(wrapText('uno dos tres cuatro cinco seis', 8, 2)).toEqual(['uno dos', 'tres…']);
    expect(wrapText('', 8, 2)).toEqual([]);
  });
});

describe('exportación de la matriz', () => {
  it('SVG: título, cabeceras, marcas con el color de la criticidad, avisos y clave de colores', async () => {
    const svg = await toSvg(small, 'matrix');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Matriz capacidad × aplicación - Pequeña');
    for (const text of ['>Tienda web</text>', '>Ventas online</text>', '>●</text>', '>○</text>', '>hueco</text>', '>solapamiento</text>', '>Criticidad de la aplicación</text>', '>6/8</text>']) expect(svg).toContain(text);
    expect(svg).toContain('#ffa8a8');
    expect(svg).toContain('#c92a2a');
    expect(svg).toContain('#9c36b5');
    expect(svg).not.toMatch(/<script|href=|@import/);
    expect(await toSvg(small, 'matrix')).toBe(svg);
  });

  it('draw.io: la matriz es una página más, con un nodo por celda y cabecera y el icono solo en las cabeceras', async () => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(small));
    const pages = ([] as Array<Record<string, unknown>>).concat(parsed.mxfile.diagram);
    expect(pages.map((p) => p['@_id'])).toEqual(listViews(small).map((v) => v.id));
    const page = pages.find((p) => p['@_id'] === 'matrix') as { mxGraphModel: { root: { mxCell: Array<Record<string, string>> } } };
    const cells = ([] as Array<Record<string, string>>).concat(page.mxGraphModel.root.mxCell);
    const nodes = cells.filter((c) => c['@_vertex'] && !c['@_id'].startsWith('i-'));
    expect(nodes).toHaveLength(matrixScene(small).layout.nodes.length);
    expect(cells.filter((c) => c['@_id'].startsWith('i-'))).toHaveLength(small.capabilities.length + small.applications.length);
    expect(cells.some((c) => c['@_edge'])).toBe(false);
    const web = cells.find((c) => c['@_id'] === `n-${matrixCellId('online', 'web')}`)!;
    expect(web['@_value']).toBe('●');
    expect(web['@_style']).toContain('fillColor=#ffa8a8');
  });

  it('Mermaid: un diagrama de bloques con una fila por capacidad y las marcas, y se parte en tantas columnas como entradas', () => {
    const text = toMermaid(small, { viewId: 'matrix' });
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('block-beta');
    const columns = Number(/columns (\d+)/.exec(lines[1])![1]);
    expect(columns).toBe(small.applications.length + 2);
    const entries = (line: string): number => (line.match(/\b(?:space:1|[a-z]+\d*(?:_\d+)?\["[^"]*"\])/g) ?? []).length;
    const grid = lines.slice(2, 2 + small.capabilities.length + 2); // cabecera, filas y pie
    expect(grid).toHaveLength(small.capabilities.length + 2);
    for (const line of grid) expect(entries(line), line).toBe(columns);
    expect(text).toContain('r1["› Ventas online"]');
    expect(text).toContain('c1_0["●"]');
    expect(text).toContain('c2_1["○"]');
    expect(text).toContain('t8["0 · hueco"]');
    expect(text).toMatch(/classDef m\d+ fill:#ffa8a8,stroke:#868e96,color:#0f172a/);
    expect(text).toContain('%% ●');
    expect(text).not.toMatch(/<script/);
  });
});

describe('editor: la matriz en el lienzo', () => {
  const project = enterpriseEditor.project(small, 'matrix');
  const edit = (r: ReturnType<typeof enterpriseEditor.update>): EnterpriseDocument => {
    if (!r.ok) throw new Error(r.reason);
    expect(enterpriseModule.schema.safeParse(r.document).success).toBe(true);
    return r.document as EnterpriseDocument;
  };
  const supports = (d: EnterpriseDocument, cap: string, app: string) => d.relations.find((r) => r.kind === 'supports' && r.sourceId === app && r.targetId === cap);

  it('proyecta cabeceras (elementos reales), celdas y totales, con colocación propia y sin aristas', () => {
    expect(project.edges).toEqual([]);
    const kinds = new Map<string, number>();
    for (const n of project.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
    expect(kinds.get('capability')).toBe(small.capabilities.length);
    expect(kinds.get('application')).toBe(small.applications.length);
    expect(kinds.get('cell')).toBe(small.capabilities.length * small.applications.length);
    const layout = enterpriseEditor.layout!(small, 'matrix') as GraphLayout;
    expect(layout.nodes.map((b) => b.id).sort()).toEqual(project.nodes.map((n) => n.id).sort());
    expect(project.nodes.find((n) => n.id === matrixCellId('online', 'web'))).toMatchObject({ label: '●', fill: '#ffa8a8' });
    expect(project.nodes.find((n) => n.id === 'web')).toMatchObject({ kind: 'application', label: 'Tienda web', sublabel: 'crit. crítica' });
    expect(project.nodes.find((n) => n.id === 'wms-nuevo')?.badges).toEqual(['prevista']);
    const notation = (kind: string) => enterpriseEditor.nodeKinds.find((k) => k.kind === kind)!;
    expect(notation('cell')).toMatchObject({ bare: true, addable: false });
    expect(notation('total')).toMatchObject({ bare: true, addable: false });
  });

  it('una celda se lee como «soporta» (con su criterio) y se edita en sus propiedades', () => {
    const id = matrixCellId('cobros', 'pagos');
    expect(enterpriseEditor.read(small, id)).toEqual({ type: 'node', kind: 'cell', values: { support: true, description: 'tarjetas' } });
    expect(enterpriseEditor.read(small, matrixCellId('envios', 'web'))?.values).toEqual({ description: '' });
    expect(enterpriseEditor.fields({ type: 'node', kind: 'cell' }, small).map((f) => [f.key, f.type])).toEqual([['support', 'boolean'], ['description', 'longtext']]);
    expect(enterpriseEditor.read(small, 'total:row:rrhh')).toEqual({ type: 'node', kind: 'total', values: {} });
    expect(enterpriseEditor.fields({ type: 'node', kind: 'total' }, small)).toEqual([]);

    const empty = matrixCellId('envios', 'web');
    const created = edit(enterpriseEditor.update(small, empty, { support: true }));
    expect(supports(created, 'envios', 'web')).toMatchObject({ id: 'web-supports-envios', kind: 'supports' });
    expect(buildMatrix(created).rows.find((r) => r.capability.id === 'envios')!.status).toBe('overlap');
    const described = edit(enterpriseEditor.update(created, empty, { description: ' canal web ' }));
    expect(supports(described, 'envios', 'web')?.description).toBe('canal web');
    // Con el criterio de la que se suma y una principal, la convivencia ya no es un solapamiento.
    expect(buildMatrix(described).rows.find((r) => r.capability.id === 'envios')!.status).toBe('criterion');
    const cleared = edit(enterpriseEditor.update(described, empty, { description: '' }));
    expect(supports(cleared, 'envios', 'web')?.description).toBeUndefined();
    const removed = edit(enterpriseEditor.update(described, empty, { support: undefined }));
    expect(supports(removed, 'envios', 'web')).toBeUndefined();
    expect(enterpriseEditor.update(small, empty, { description: 'algo' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(small, empty, { description: '' })).toMatchObject({ ok: true });
  });

  it('«Soporta ⇄» crea la relación de las celdas que no la tienen y, si todas la tienen, la quita', () => {
    const action = enterpriseEditor.actions!.find((a) => a.id === 'matrix-support')!;
    expect(action.needs).toBe('many');
    expect(action.disabled!(small, ['online'])).toMatch(/celdas de la matriz/);
    const a = matrixCellId('envios', 'web');
    const b = matrixCellId('online', 'web'); // ya la tiene
    expect(action.disabled!(small, [a])).toBeUndefined();
    const added = action.run(small, [a, b]);
    if (!added.ok) throw new Error(added.reason);
    expect(supports(added.document as EnterpriseDocument, 'envios', 'web')).toBeDefined();
    expect(supports(added.document as EnterpriseDocument, 'online', 'web')).toBeDefined();
    expect((added.document as EnterpriseDocument).relations).toHaveLength(small.relations.length + 1);
    const removedAll = action.run(added.document as EnterpriseDocument, [a, b]);
    if (!removedAll.ok) throw new Error(removedAll.reason);
    expect(supports(removedAll.document as EnterpriseDocument, 'envios', 'web')).toBeUndefined();
    expect(supports(removedAll.document as EnterpriseDocument, 'online', 'web')).toBeUndefined();
    expect(enterpriseModule.schema.safeParse(removedAll.document).success).toBe(true);
    expect(action.run(small, ['online'])).toMatchObject({ ok: false });
  });

  it('una celda con soporte solo por un proceso pasa a directa al marcarla y no cambia al desmarcarla si no hay relación directa', () => {
    const action = enterpriseEditor.actions!.find((a) => a.id === 'matrix-support')!;
    const id = matrixCellId('pedidos', 'erp');
    const done = action.run(small, [id]);
    if (!done.ok) throw new Error(done.reason);
    expect(buildMatrix(done.document as EnterpriseDocument).cells.get(cellKey('pedidos', 'erp'))).toMatchObject({ support: 'direct', processIds: ['alta'] });
  });

  it('el doble clic en una celda marca o desmarca el soporte y en otro nodo no hace nada', () => {
    const id = matrixCellId('envios', 'web');
    const on = enterpriseEditor.activate!(small, id, 'matrix');
    if (!on || !on.ok) throw new Error('debía marcarla');
    expect(supports(on.document as EnterpriseDocument, 'envios', 'web')).toBeDefined();
    const off = enterpriseEditor.activate!(on.document as EnterpriseDocument, id, 'matrix');
    if (!off || !off.ok) throw new Error('debía desmarcarla');
    expect(supports(off.document as EnterpriseDocument, 'envios', 'web')).toBeUndefined();
    expect(enterpriseEditor.activate!(small, 'web', 'matrix')).toBeUndefined();
    expect(enterpriseEditor.activate!(small, 'total:all', 'matrix')).toBeUndefined();
  });

  it('borrar una celda quita su relación directa; los totales y las celdas sin relación directa no se borran', () => {
    const removed = enterpriseEditor.remove(small, matrixCellId('online', 'web'));
    if (!removed.ok) throw new Error(removed.reason);
    expect(supports(removed.document as EnterpriseDocument, 'online', 'web')).toBeUndefined();
    expect(enterpriseEditor.remove(small, matrixCellId('envios', 'web'))).toMatchObject({ ok: false, reason: expect.stringContaining('directa') });
    expect(enterpriseEditor.remove(small, 'total:row:rrhh')).toMatchObject({ ok: false, reason: expect.stringContaining('se derivan') });
  });

  it('arrastrar de una capacidad a una aplicación entre las cabeceras crea el soporte, como en el paisaje', () => {
    const connected = enterpriseEditor.addEdge(small, 'supports', 'rrhh', 'web');
    if (!connected.ok) throw new Error(connected.reason);
    expect(supports(connected.document as EnterpriseDocument, 'rrhh', 'web')).toBeDefined();
    expect(buildMatrix(connected.document as EnterpriseDocument).rows.find((r) => r.capability.id === 'rrhh')!.status).toBe('single');
  });

  describe('arrastrar una celda con marca directa a otra mueve su relación', () => {
    const drop = (doc: EnterpriseDocument, from: string, to: string, viewId = 'matrix') => enterpriseEditor.drop!(doc, from, to, viewId);
    const moved = (r: ReturnType<NonNullable<typeof enterpriseEditor.drop>>): { document: EnterpriseDocument; id?: string } => {
      if (!r || !r.ok) throw new Error(r ? r.reason : 'no significaba nada');
      expect(enterpriseModule.schema.safeParse(r.document).success).toBe(true);
      return { document: r.document as EnterpriseDocument, id: r.id };
    };
    const cell = matrixCellId;

    it('la ayuda de la matriz lo dice: la leyenda del lienzo y la pista de «Soporta ⇄»', () => {
      expect(project.legend?.title).toMatch(/Doble clic en una celda.*Arrastra una celda con ● a otra: lo mueve/);
      expect(enterpriseEditor.actions!.find((a) => a.id === 'matrix-support')!.hint).toMatch(/arrastra una celda con marca directa \(●\) a otra/);
      // Solo la matriz lleva esa leyenda.
      expect(enterpriseEditor.project(small, 'capabilities').legend?.title).not.toMatch(/Arrastra/);
    });

    it('en la misma columna cambia la capacidad; en la misma fila, la aplicación; en diagonal, las dos, y siempre es una sola relación que conserva su sitio, su id y sus campos', () => {
      const column = moved(drop(small, cell('online', 'web'), cell('precios', 'web')));
      expect(supports(column.document, 'online', 'web')).toBeUndefined();
      expect(supports(column.document, 'precios', 'web')).toMatchObject({ id: 'a', kind: 'supports', sourceId: 'web', targetId: 'precios' });
      expect(column.id).toBe(cell('precios', 'web'));

      const row = moved(drop(small, cell('envios', 'erp'), cell('envios', 'crm')));
      expect(supports(row.document, 'envios', 'erp')).toBeUndefined();
      expect(supports(row.document, 'envios', 'crm')).toMatchObject({ id: 'h', sourceId: 'crm', targetId: 'envios' });

      // En diagonal y con criterio escrito: la descripción viaja con la relación.
      const diagonal = moved(drop(small, cell('cobros', 'pagos'), cell('rrhh', 'web')));
      expect(supports(diagonal.document, 'cobros', 'pagos')).toBeUndefined();
      expect(supports(diagonal.document, 'rrhh', 'web')).toEqual({ id: 'i', kind: 'supports', sourceId: 'web', targetId: 'rrhh', description: 'tarjetas' });

      for (const { document } of [column, row, diagonal]) {
        // Ni se crea ni se borra nada: la misma cantidad de relaciones, en el mismo orden, y solo cambia la movida.
        expect(document.relations).toHaveLength(small.relations.length);
        expect(document.relations.map((r) => r.id)).toEqual(small.relations.map((r) => r.id));
        expect(document.relations.filter((r, i) => JSON.stringify(r) !== JSON.stringify(small.relations[i]))).toHaveLength(1);
        expect({ ...document, relations: [] }).toEqual({ ...small, relations: [] });
      }
    });

    it('la matriz se recalcula: la celda de origen queda vacía, la de destino directa y los avisos de sus filas cambian', () => {
      const { document } = moved(drop(small, cell('online', 'web'), cell('precios', 'web')));
      const m = buildMatrix(document);
      expect(m.cells.get(cellKey('online', 'web'))).toBeUndefined();
      expect(m.cells.get(cellKey('precios', 'web'))).toMatchObject({ support: 'direct' });
      expect(m.rows.find((r) => r.capability.id === 'online')!.status).toBe('gap');
      expect(m.rows.find((r) => r.capability.id === 'precios')!.status).toBe('single');
      // La agrupación sigue heredando de sus hijas.
      expect(m.cells.get(cellKey('ventas', 'web'))).toMatchObject({ support: 'inherited' });
    });

    it('el id que se generó solo se rehace con la pareja nueva (sin pisar otro) y uno puesto a mano se respeta', () => {
      const marked = edit(enterpriseEditor.update(small, cell('envios', 'web'), { support: true }));
      expect(supports(marked, 'envios', 'web')?.id).toBe('web-supports-envios');
      const { document } = moved(drop(marked, cell('envios', 'web'), cell('rrhh', 'web')));
      expect(supports(document, 'rrhh', 'web')?.id).toBe('web-supports-rrhh');
      expect(document.relations.map((r) => r.id)).toEqual(marked.relations.map((r) => (r.id === 'web-supports-envios' ? 'web-supports-rrhh' : r.id)));

      // Si ese id ya lo lleva otra relación (puesto a mano), se desambigua.
      const taken = parse({ ...marked, relations: [...marked.relations, { id: 'web-supports-rrhh', kind: 'depends-on', sourceId: 'web', targetId: 'erp' }] });
      expect(supports(moved(drop(taken, cell('envios', 'web'), cell('rrhh', 'web'))).document, 'rrhh', 'web')?.id).toBe('web-supports-rrhh-2');

      // El de los importadores y los ejemplos (`--`) también.
      const dashed = parse({ ...marked, relations: marked.relations.map((r) => (r.id === 'web-supports-envios' ? { ...r, id: 'web--supports--envios' } : r)) });
      expect(supports(moved(drop(dashed, cell('envios', 'web'), cell('rrhh', 'web'))).document, 'rrhh', 'web')?.id).toBe('web-supports-rrhh');

      // Con sufijo numérico también es un id generado.
      const suffixed = parse({ ...marked, relations: marked.relations.map((r) => (r.id === 'web-supports-envios' ? { ...r, id: 'web-supports-envios-2' } : r)) });
      expect(supports(moved(drop(suffixed, cell('envios', 'web'), cell('rrhh', 'web'))).document, 'rrhh', 'web')?.id).toBe('web-supports-rrhh');
    });

    it('si la pareja de destino ya tiene la relación no se hace nada y se avisa', () => {
      // «Tienda web» ya soporta «Pedidos» (relación `d`): mover la de «Ventas online» a esa celda la duplicaría.
      const result = drop(small, cell('online', 'web'), cell('pedidos', 'web'));
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('ya soporta') });
      expect((result as { reason: string }).reason).toContain('«Tienda web»');
      expect((result as { reason: string }).reason).toContain('«Pedidos»');
      expect(result).not.toHaveProperty('document');
    });

    it('solo se arrastran las celdas con marca directa: las vacías, las que soportan por un proceso (○) y las heredadas (·) avisan y no cambian nada', () => {
      expect(drop(small, cell('rrhh', 'web'), cell('precios', 'web'))).toMatchObject({ ok: false, reason: expect.stringContaining('vacía') });
      expect(drop(small, cell('pedidos', 'erp'), cell('precios', 'erp'))).toMatchObject({ ok: false, reason: expect.stringMatching(/por un proceso \(○\).*solo se arrastran.*\(●\)/) });
      expect(drop(small, cell('ventas', 'web'), cell('rrhh', 'web'))).toMatchObject({ ok: false, reason: expect.stringMatching(/heredado de una capacidad hija \(·\)/) });
    });

    it('una celda que soporta por un proceso (○) puede recibir el soporte directo: queda directa y conserva sus procesos', () => {
      const { document } = moved(drop(small, cell('online', 'web'), cell('pedidos', 'erp')));
      expect(buildMatrix(document).cells.get(cellKey('pedidos', 'erp'))).toMatchObject({ support: 'direct', processIds: ['alta'] });
      expect(document.relations.filter((r) => r.kind === 'realizes' || r.targetId === 'alta')).toEqual(small.relations.filter((r) => r.kind === 'realizes' || r.targetId === 'alta'));
    });

    it('soltar sobre algo que no es una celda se avisa; fuera de la matriz, con otro nodo arrastrado o sobre sí misma no significa nada', () => {
      expect(drop(small, cell('online', 'web'), 'erp')).toMatchObject({ ok: false, reason: expect.stringContaining('otra celda de la matriz') });
      expect(drop(small, cell('online', 'web'), 'total:all')).toMatchObject({ ok: false, reason: expect.stringContaining('otra celda de la matriz') });
      expect(drop(small, cell('online', 'web'), cell('precios', 'web'), 'landscape')).toBeUndefined();
      expect(enterpriseEditor.drop!(small, cell('online', 'web'), cell('precios', 'web'), undefined)).toBeUndefined();
      expect(drop(small, 'web', cell('precios', 'web'))).toBeUndefined();
      expect(drop(small, 'total:all', cell('precios', 'web'))).toBeUndefined();
      expect(drop(small, cell('online', 'web'), cell('online', 'web'))).toBeUndefined();
    });

    it('la relación movida sigue siendo una aplicación que soporta una capacidad (RELATION_RULES) y el documento valida', () => {
      const { document } = moved(drop(small, cell('cobros', 'pagos'), cell('rrhh', 'web')));
      const relation = supports(document, 'rrhh', 'web')!;
      expect(document.applications.some((a) => a.id === relation.sourceId)).toBe(true);
      expect(document.capabilities.some((c) => c.id === relation.targetId)).toBe(true);
      expect(validateEnterpriseDocument(document)).toMatchObject({ ok: true });
    });
  });

  it('borrar una cabecera quita su fila o su columna y las relaciones', () => {
    const noWeb = enterpriseEditor.remove(small, 'web');
    if (!noWeb.ok) throw new Error(noWeb.reason);
    const m = buildMatrix(noWeb.document as EnterpriseDocument);
    expect(m.columns.some((c) => c.application.id === 'web')).toBe(false);
    expect(m.rows.find((r) => r.capability.id === 'online')!.status).toBe('gap');
  });
});

describe('comando `iark enterprise matrix`', () => {
  const run = (input: unknown, options: Record<string, unknown> = {}): string => {
    const command = enterpriseCommands.find((c) => c.name === 'matrix')!;
    return command.run({ args: [], options, input: JSON.stringify(input) }) as string;
  };
  const smallJson = JSON.parse(JSON.stringify(small)) as unknown;

  it('está entre los informes del módulo y acepta --format', () => {
    const command = enterpriseCommands.find((c) => c.name === 'matrix')!;
    expect(command.kind ?? 'report').toBe('report');
    expect(command.options).toEqual([expect.objectContaining({ flags: '--format <formato>', default: 'table' })]);
  });

  it('tabla Markdown: una fila por capacidad con sangría, marcas, total y estado, y el resumen de avisos', () => {
    const out = run(smallJson);
    const lines = out.split('\n');
    const table = lines.filter((l) => l.startsWith('|'));
    expect(table[0]).toBe('| Capacidad | Tienda web | ERP | CRM | WMS viejo | WMS nuevo | Pagos | Pasarela | Antigua | Suelta | Total | Estado |');
    expect(table[1]).toBe('|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|--:|---|');
    expect(table).toHaveLength(2 + small.capabilities.length + 1);
    for (const line of table) expect(line.split('|').length, line).toBe(table[0].split('|').length);
    expect(out).toContain('|   Ventas online | ● |');
    expect(out).toContain('|   Pedidos | ● | ○ | ● |');
    expect(out).toMatch(/\| Recursos humanos \|( {2}\|){9} 0 \| hueco \|/);
    expect(out).toContain('|   Pedidos |');
    expect(out).toContain('| 3 | solapamiento |');
    expect(out).toContain('Cobertura: 6 de 8 capacidad(es) sin hijas tienen al menos una aplicación.');
    expect(out).toContain('Huecos (capacidad sin aplicación): Precios; Recursos humanos');
    expect(out).toContain('Solapamientos sin criterio (2 o más aplicaciones vigentes): Pedidos (Tienda web, ERP, CRM)');
    expect(out).toContain('Inventario (WMS viejo, WMS nuevo) · transición');
    expect(out).toContain('Aplicaciones que no soportan ninguna capacidad: Suelta');
    expect(out).toContain('Leyenda: ● soporte directo');
  });

  it('CSV: cabecera con las aplicaciones, ruta y nivel de cada capacidad, valores `directa|proceso|heredada` y la fila de totales', () => {
    const out = run(smallJson, { format: 'csv' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Id,Capacidad,Ruta,Nivel,Tienda web,ERP,CRM,WMS viejo,WMS nuevo,Pagos,Pasarela,Antigua,Suelta,Total,Estado');
    expect(lines).toHaveLength(1 + small.capabilities.length + 1);
    for (const line of lines) expect(line.split(',').length, line).toBe(15);
    expect(lines).toContain('online,Ventas online,Ventas › Ventas online,1,directa,,,,,,,,,1,');
    expect(lines).toContain('pedidos,Pedidos,Ventas › Pedidos,1,directa,proceso,directa,,,,,,,3,solapamiento');
    expect(lines).toContain('ventas,Ventas,Ventas,0,heredada,heredada,heredada,,,,,,,3,');
    expect(lines).toContain('rrhh,Recursos humanos,Recursos humanos,0,,,,,,,,,,0,hueco');
    expect(lines[lines.length - 1]).toBe(',Total,,,2,3,1,1,1,2,1,1,0,,');
  });

  it('CSV: entrecomilla lo que lleva comas o comillas', () => {
    const quoted = parse({ capabilities: [{ id: 'c', name: 'Compras, pagos y "otros"' }], applications: [{ id: 'a', name: 'A, B' }] });
    const lines = run(JSON.parse(JSON.stringify(quoted)), { format: 'csv' }).split('\n');
    expect(lines[0]).toBe('Id,Capacidad,Ruta,Nivel,"A, B",Total,Estado');
    expect(lines[1]).toBe('c,"Compras, pagos y ""otros""","Compras, pagos y ""otros""",0,,0,hueco');
  });

  it('rechaza un formato desconocido y avisa si no hay capacidades', () => {
    expect(() => run(smallJson, { format: 'xml' })).toThrow(/Formato inválido «xml»\. Use: table, csv\./);
    expect(run({ version: '1.0', workspace: { name: 'x' } })).toBe('El documento no define capacidades.');
    expect(() => run('{', {})).toThrow();
  });

  it('con el ejemplo: ningún hueco y los cuatro solapamientos', () => {
    const out = run(example);
    expect(out).toContain('Cobertura: 12 de 12 capacidad(es)');
    expect(out).toContain('Huecos (capacidad sin aplicación): ninguno');
    expect(out).toContain('Gestión de pedidos (Tienda online, ERP corporativo); Facturación (ERP corporativo, Facturación electrónica)');
  });
});
