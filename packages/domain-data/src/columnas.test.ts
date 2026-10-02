import { describe, expect, it } from 'vitest';
import example from '../../../examples/ventas-datos.json';
import { dataCommands } from './commands';
import { dataEditor, mappingsToText, parseMappings } from './editor';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { analyzeData } from './issues';
import { columnImpact, parseColumnRef, traceColumnLineage } from './lineage';
import { dataModule } from './module';
import { validateDataDocument } from './schema';
import type { DataDocument } from './types';
import { columnViews, findView } from './views';

const doc = dataModule.schema.parse(example) as DataDocument;
const ids = doc.assets.map((a) => a.id);
const withMappings = (pipelineId: string, mappings: NonNullable<DataDocument['pipelines'][number]['mappings']>): DataDocument => ({
  ...doc,
  pipelines: doc.pipelines.map((p) => (p.id === pipelineId ? { ...p, mappings } : p)),
});
const cols = (steps: Array<{ assetId: string; column: string }>): string[] => steps.map((s) => `${s.assetId}.${s.column}`);

describe('linaje a nivel de columna', () => {
  it('es opcional: un documento sin mapeos sigue siendo válido y no ofrece vistas de columna', () => {
    const plain = { ...doc, pipelines: doc.pipelines.map(({ mappings: _m, ...p }) => p) } as DataDocument;
    expect(validateDataDocument(plain).ok).toBe(true);
    expect(columnViews(plain)).toEqual([]);
    expect(traceColumnLineage(plain, { assetId: 'crm-clientes', column: 'email' }).downstream).toEqual([]);
  });

  it('el esquema exige que el mapeo parta de una entrada y llegue a una salida del pipeline', () => {
    const bad = withMappings('limpieza', [{ from: { assetId: 'silver-ventas', column: 'pais' }, to: { assetId: 'bronze-clientes', column: 'pais' } }]);
    const result = validateDataDocument(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toEqual(['pipelines.2.mappings.0.from.assetId', 'pipelines.2.mappings.0.to.assetId']);
  });

  it('recorre las columnas aguas abajo y aguas arriba por los mapeos encadenados', () => {
    const down = traceColumnLineage(doc, { assetId: 'crm-clientes', column: 'nombre' }, 'downstream').downstream;
    expect(cols(down)).toEqual(['bronze-clientes.nombre', 'silver-ventas.cliente_nombre', 'dwh-dim-cliente.nombre']);
    expect(down.map((s) => s.depth)).toEqual([1, 2, 3]);
    const up = traceColumnLineage(doc, { assetId: 'panel-ventas', column: 'Ventas totales' }, 'upstream').upstream;
    expect(cols(up)).toEqual(['dwh-fact-ventas.importe', 'silver-ventas.importe', 'bronze-pedidos.total', 'erp-pedidos.total']);
    expect(up[0].transform).toBe('suma por mes');
  });

  it('el impacto de una columna nombra los informes y modelos afectados', () => {
    const impact = columnImpact(doc, { assetId: 'erp-pedidos', column: 'total' });
    expect([...impact.consumerIds].sort()).toEqual(['modelo-fuga', 'panel-ventas']);
    expect(impact.assetIds).toContain('silver-ventas');
  });

  it('parseColumnRef resuelve el activo aunque la columna lleve puntos', () => {
    expect(parseColumnRef('crm-clientes.email', ids)).toEqual({ assetId: 'crm-clientes', column: 'email' });
    expect(parseColumnRef('crm-clientes.a.b', ids)).toEqual({ assetId: 'crm-clientes', column: 'a.b' });
    expect(parseColumnRef('no-existe.email', ids)).toBeUndefined();
  });
});

describe('vista de impacto de columna', () => {
  const id = 'column:crm-clientes.email';

  it('se ofrece una vista por cada columna de origen de los mapeos', () => {
    const views = dataModule.views!(doc).map((v) => v.id);
    expect(views).toContain(id);
    expect(views).toContain('column:erp-pedidos.id');
    expect(views).not.toContain('column:bronze-clientes.email');
  });

  it('findView la resuelve y dibuja solo los activos, pipelines y columnas afectadas', () => {
    const view = findView(doc, id);
    expect(view.assetIds.filter((a) => !['crm', 'lake', 'dwh'].includes(a))).toEqual(['crm-clientes', 'bronze-clientes']);
    expect(view.pipelineIds).toEqual(['ingesta-crm']);
    expect(view.column?.byAsset).toEqual({ 'crm-clientes': ['email'], 'bronze-clientes': ['email'] });
    expect(() => findView(doc, 'column:crm-clientes.nada')).toThrow(/no tiene la columna/);
    expect(() => findView(doc, 'column:x.y')).toThrow(/column:<activo>.<columna>/);
  });

  it('el lienzo muestra la ficha de cada activo con la columna de partida resaltada', () => {
    const g = dataEditor.project(doc, 'column:erp-pedidos.total');
    const origin = g.nodes.find((n) => n.id === 'erp-pedidos');
    expect(origin?.lines).toEqual(['● total: numeric']);
    expect(origin?.lineEmphasis).toEqual(['key']);
    const report = g.nodes.find((n) => n.id === 'panel-ventas');
    expect(report?.lines).toEqual(['▸ Ventas totales']);
    expect(report?.lineEmphasis).toEqual(['ref']);
  });

  it('el SVG y Mermaid listan las columnas afectadas', async () => {
    const svg = await toSvg(doc, 'column:erp-pedidos.total');
    expect(svg).toContain('● total: numeric');
    expect(svg).toContain('▸ Ventas totales');
    expect(toMermaid(doc, { viewId: 'column:erp-pedidos.total' })).toContain('▸ importe: numeric');
  });
});

describe('editor: linaje de columnas del pipeline', () => {
  it('el texto de los mapeos se lee, se edita y vuelve igual', () => {
    const read = dataEditor.read(doc, 'pipeline:ingesta-crm');
    const text = String(read?.values.mappingsText);
    expect(text.split('\n')[2]).toBe('crm-clientes.email -> bronze-clientes.email : copia');
    const parsed = parseMappings(text, ids);
    expect('mappings' in parsed && mappingsToText(parsed.mappings)).toBe(text);
  });

  it('actualizar el texto cambia los mapeos; vacío los quita; una línea mala o ajena al pipeline se rechaza', () => {
    const ok = dataEditor.update(doc, 'pipeline:ingesta-crm', { mappingsText: 'crm-clientes.id → bronze-clientes.id' });
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.document.pipelines[0].mappings).toEqual([{ from: { assetId: 'crm-clientes', column: 'id' }, to: { assetId: 'bronze-clientes', column: 'id' } }]);
    const empty = dataEditor.update(doc, 'pipeline:ingesta-crm', { mappingsText: '' });
    if (!empty.ok) throw new Error(empty.reason);
    expect(empty.document.pipelines[0]).not.toHaveProperty('mappings');
    expect(dataEditor.update(doc, 'pipeline:ingesta-crm', { mappingsText: 'esto no es un mapeo' })).toMatchObject({ ok: false });
    expect(dataEditor.update(doc, 'pipeline:ingesta-crm', { mappingsText: 'erp-pedidos.id -> bronze-clientes.id' })).toMatchObject({ ok: false, reason: expect.stringContaining('no es una entrada') });
  });

  it('borrar un activo o una conexión retira los mapeos que lo tocan y el documento sigue siendo válido', () => {
    const a = dataEditor.remove(doc, 'erp-lineas');
    if (!a.ok) throw new Error(a.reason);
    expect(validateDataDocument(a.document).ok).toBe(true);
    const b = dataEditor.remove(doc, 'flow:limpieza:in:bronze-clientes');
    if (!b.ok) throw new Error(b.reason);
    expect(b.document.pipelines.find((p) => p.id === 'limpieza')?.mappings?.some((m) => m.from.assetId === 'bronze-clientes')).toBe(false);
    expect(validateDataDocument(b.document).ok).toBe(true);
    const c = dataEditor.remove(doc, 'bronze-pedidos');
    if (!c.ok) throw new Error(c.reason);
    expect(validateDataDocument(c.document).ok).toBe(true);
  });
});

describe('avisos de linaje de columnas', () => {
  it('el ejemplo no genera avisos de columnas', () => {
    expect(analyzeData(doc).filter((i) => /columna/.test(i.message))).toEqual([]);
  });

  it('avisa de un mapeo a una columna que el activo no declara (los informes sin columnas aceptan cualquier nombre)', () => {
    const bad = withMappings('ingesta-crm', [{ from: { assetId: 'crm-clientes', column: 'telefono' }, to: { assetId: 'bronze-clientes', column: 'tel' } }]);
    const messages = analyzeData(bad).filter((i) => i.elementId === 'ingesta-crm' && /columna/.test(i.message));
    expect(messages.map((i) => i.severity)).toEqual(['warning', 'warning']);
    expect(messages[0].message).toContain('«telefono»');
    const free = withMappings('publica-panel', [{ from: { assetId: 'dwh-fact-ventas', column: 'importe' }, to: { assetId: 'panel-ventas', column: 'Lo que sea' } }]);
    expect(analyzeData(free).filter((i) => i.elementId === 'publica-panel' && /columna/.test(i.message))).toEqual([]);
  });

  it('avisa de datos personales que llegan a una columna sin marcar, salvo si el pipeline anonimiza', () => {
    const leak = withMappings('carga-dimension', [{ from: { assetId: 'silver-ventas', column: 'cliente_nombre' }, to: { assetId: 'dwh-dim-cliente', column: 'pais' } }]);
    const found = analyzeData(leak).filter((i) => i.elementId === 'dwh-dim-cliente' && /no está marcada como PII/.test(i.message));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    const anonymized = { ...leak, pipelines: leak.pipelines.map((p) => (p.id === 'carga-dimension' ? { ...p, anonymizes: true } : p)) } as DataDocument;
    expect(analyzeData(anonymized).filter((i) => /no está marcada como PII/.test(i.message))).toEqual([]);
  });
});

describe('comando column-impact', () => {
  const run = (arg: string): string => String(dataCommands.find((c) => c.name === 'column-impact')!.run({ args: [arg], options: {}, input: JSON.stringify(example) } as never));

  it('imprime las columnas dependientes, los informes y los responsables', () => {
    const out = run('erp-pedidos.total');
    expect(out).toContain('Impacto de la columna pedidos.total');
    expect(out).toContain('Panel de ventas.Ventas totales');
    expect(out).toContain('Informes y modelos afectados: Panel de ventas, Modelo de fuga de clientes');
    expect(() => run('nada.x')).toThrow(/activo y una columna/);
  });
});
