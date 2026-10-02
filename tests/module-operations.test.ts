import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  canRender,
  commandInfos,
  exportDocument,
  exportFormats,
  importText,
  isKnownView,
  locateId,
  moduleCapabilities,
  optionInfo,
  renderSvg,
  runCommand,
  splitTraceView,
  viewChoices,
  viewTitle,
} from '@iark/kernel';
import { SOURCES, c4Module, example, securityModule } from '../src/modules-app/testing';

const securityText = example('seguridad-ejemplo.json');

describe('analizar el texto del editor', () => {
  it('distingue vacío, sintaxis, esquema y documento válido con sus reglas de dominio', () => {
    expect(analyzeText(securityModule, '  \n').status).toBe('empty');
    const syntax = analyzeText(securityModule, '{"version":');
    expect(syntax.status).toBe('syntax');
    const schema = analyzeText(securityModule, JSON.stringify({ version: '1.0', workspace: { name: 'X' }, zones: [{ id: 'z', name: 'Z', trust: 'nope' }], assets: [], flows: [] }));
    expect(schema.status).toBe('schema');
    if (schema.status === 'schema') expect(schema.issues[0].path).toContain('zones');
    const ok = analyzeText(securityModule, securityText);
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') {
      expect(ok.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
      expect(ok.issues.some((i) => i.severity === 'warning')).toBe(true);
    }
  });

  it('acepta el JSON dentro de una respuesta con markdown (extractJson)', () => {
    expect(analyzeText(securityModule, '```json\n' + securityText + '\n```').status).toBe('ok');
  });
});

describe('vistas', () => {
  const analysis = analyzeText(securityModule, securityText);
  if (analysis.status !== 'ok') throw new Error('el ejemplo debe ser válido');
  const choices = viewChoices(securityModule, analysis.document);

  it('lista las vistas derivadas y las vistas de traza con sus elementos', () => {
    expect(choices.views.map((v) => v.id)).toEqual(expect.arrayContaining(['dfd', 'threats']));
    expect(choices.traces.map((t) => t.prefix)).toEqual(['blast', 'exposure', 'focus']);
    expect(choices.traces[0].entities.every((e) => e.kind === 'asset')).toBe(true);
    expect(choices.traces[0].entities.some((e) => e.id === 'pedidos-db')).toBe(true);
  });

  it('reconoce las vistas de traza por prefijo y elemento', () => {
    expect(isKnownView(choices, 'dfd')).toBe(true);
    expect(isKnownView(choices, 'blast:pedidos-db')).toBe(true);
    expect(isKnownView(choices, 'blast:no-existe')).toBe(false);
    expect(isKnownView(choices, 'zzz:pedidos-db')).toBe(false);
    expect(isKnownView(choices, 'blast:internet')).toBe(false); // una zona no es un activo
    expect(splitTraceView('blast:pedidos-db')).toEqual({ prefix: 'blast', entityId: 'pedidos-db' });
    expect(splitTraceView('dfd')).toBeUndefined();
    expect(viewTitle(choices, 'blast:pedidos-db')).toContain('Base de pedidos');
    expect(viewTitle(choices, 'dfd')).toBe(choices.views.find((v) => v.id === 'dfd')!.title);
  });

  it('dibuja cada vista y las vistas de traza como SVG', async () => {
    for (const viewId of ['dfd', 'threats', 'blast:pedidos', 'exposure:pedidos-db']) {
      const svg = await renderSvg(securityModule, analysis.document, viewId);
      expect(svg.startsWith('<svg'), viewId).toBe(true);
    }
  });
});

describe('exportar e importar', () => {
  const analysis = analyzeText(securityModule, securityText);
  const document = analysis.status === 'ok' ? analysis.document : undefined;

  it('ofrece JSON y los exportadores del módulo, y rechaza formatos que no tiene', async () => {
    expect(exportFormats(securityModule).map((f) => f.id)).toEqual(['json', 'mermaid', 'svg', 'drawio']);
    const json = await exportDocument(securityModule, document, 'json');
    expect(JSON.parse(json.data).workspace.name).toBe('Seguridad de la tienda en línea');
    const mermaid = await exportDocument(securityModule, document, 'mermaid', { viewId: 'dfd' });
    expect(mermaid.data.startsWith('flowchart')).toBe(true);
    expect(mermaid.extension).toBe('.mmd');
    await expect(exportDocument(securityModule, document, 'pdf')).rejects.toThrow(/no exporta a «pdf»/);
  });

  it('importa Mermaid reconociéndolo por el contenido y explica los formatos desconocidos', async () => {
    const mermaid = (await exportDocument(securityModule, document, 'mermaid', { viewId: 'dfd' })).data;
    const back = await importText(securityModule, mermaid);
    expect(back.importer).toBe('mermaid');
    expect((back.document as { assets: unknown[] }).assets.length).toBeGreaterThan(5);
    await expect(importText(securityModule, 'no soy nada conocido')).rejects.toThrow(/No se reconoce el formato/);
    await expect(importText(securityModule, mermaid, 'drawio')).rejects.toThrow(/no importa «drawio»/);
  });
});

describe('comandos', () => {
  it('interpreta las opciones de commander', () => {
    expect(optionInfo({ flags: '--status <estado>', description: 'x' })).toMatchObject({ key: 'status', takesValue: true });
    expect(optionInfo({ flags: '--gaps', description: 'x' })).toMatchObject({ key: 'gaps', takesValue: false });
    expect(optionInfo({ flags: '-o, --out-file <archivo>', description: 'x' })).toMatchObject({ key: 'outFile', takesValue: true });
    expect(optionInfo({ flags: '--today [fecha]', description: 'x' }).takesValue).toBe(true);
    expect(() => optionInfo({ flags: '-x', description: 'x' })).toThrow();
  });

  it('separa los informes de las conversiones entre módulos', () => {
    const infos = commandInfos(securityModule);
    expect(infos.filter((c) => c.kind === 'report').map((c) => c.name)).toEqual(['risks', 'heatmap', 'stride', 'standards', 'exposure']);
    expect(infos.filter((c) => c.kind === 'convert').map((c) => c.name)).toEqual(['from-integration', 'from-platform']);
  });

  it('ejecuta un informe con el documento del editor, con opciones y con errores claros', async () => {
    const all = await runCommand(securityModule, 'risks', { input: securityText });
    expect(all.kind).toBe('report');
    expect(all.output).toContain('| Riesgo | Amenaza |');
    const open = await runCommand(securityModule, 'risks', { input: securityText, options: { status: 'open' } });
    expect(open.output.split('\n').filter((l) => l.startsWith('| ')).length).toBeLessThan(all.output.split('\n').filter((l) => l.startsWith('| ')).length);
    await expect(runCommand(securityModule, 'risks', { input: securityText, options: { status: 'raro' } })).rejects.toThrow(/Estado inválido/);
    await expect(runCommand(securityModule, 'risks', {})).rejects.toThrow(/Falta la entrada/);
    await expect(runCommand(securityModule, 'nope', {})).rejects.toThrow(/no tiene el comando «nope»/);
  });

  it('exige los argumentos obligatorios y convierte el documento de otro módulo con sus avisos', async () => {
    const data = SOURCES.find((s) => s.id === 'data')!;
    const dataModule = await data.load();
    await expect(runCommand(dataModule, 'lineage', { input: example('ventas-datos.json') })).rejects.toThrow(/Falta el argumento «activo»/);
    const converted = await runCommand(securityModule, 'from-integration', { input: example('pedidos-integracion.json') });
    expect(converted.kind).toBe('convert');
    expect(analyzeText(securityModule, converted.output).status).toBe('ok');
    expect(Array.isArray(converted.warnings)).toBe(true);
  });
});

describe('capacidades', () => {
  it.each(SOURCES.map((s) => s.id))('%s declara lo que el banco de trabajo necesita para ofrecerlo', async (id) => {
    const module = await SOURCES.find((s) => s.id === id)!.load();
    const caps = moduleCapabilities(module);
    expect(caps.id).toBe(id);
    expect(caps.render).toBe(true);
    expect(caps.exportFormats.map((f) => f.id)).toEqual(expect.arrayContaining(['json', 'svg', 'mermaid']));
    expect(caps.importFormats.map((f) => f.id)).toContain('mermaid');
    expect(caps.commands.length).toBeGreaterThan(0);
    expect(caps.ai).toBe(true);
    // el ejemplo del repositorio es válido para su módulo
    const analysis = analyzeText(module, await SOURCES.find((s) => s.id === id)!.example!());
    expect(analysis.status).toBe('ok');
    if (analysis.status === 'ok') expect(viewChoices(module, analysis.document).views.length).toBeGreaterThan(0);
  });

  it('C4 también se dibuja en el banco de trabajo (exportador SVG con las figuras del lienzo), además de su editor principal', () => {
    expect(canRender(c4Module)).toBe(true);
    expect(moduleCapabilities(c4Module).render).toBe(true);
  });
});

describe('localizar un elemento en el texto', () => {
  it('encuentra el id entre comillas y no confunde prefijos', () => {
    const text = '{ "id": "pedidos-db" }\n{ "id": "pedidos" }';
    expect(locateId(text, 'pedidos')).toEqual({ index: text.indexOf('"id": "pedidos" '), length: '"id": "pedidos"'.length });
    expect(locateId(text, 'nada')).toBeUndefined();
    expect(locateId('{ "id": "a.b" }', 'a.b')).toBeDefined();
  });
});
