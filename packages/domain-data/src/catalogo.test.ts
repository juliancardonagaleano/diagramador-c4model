import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { dataAiSpec, generatedToData, systemPrompt, toGenerated } from './ai/generation';
import { dataCommands } from './commands';
import { toDdl } from './ddl';
import { dataEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutView, termLines, toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { analyzeData } from './issues';
import { linkId, listLinks, pruneCatalog } from './links';
import { dataModule } from './module';
import { formatDataIssues, validateDataDocument } from './schema';
import { exportViews, findView, listViews, viewRefs } from './views';
import type { DataAsset, DataDocument, GlossaryTerm } from './types';

const raw = readFileSync('examples/datos-catalogo.json', 'utf8');
const ventasRaw = readFileSync('examples/ventas-datos.json', 'utf8');
const parse = (input: unknown): DataDocument => {
  const r = validateDataDocument(input);
  if (!r.ok) throw new Error(formatDataIssues(r.issues));
  return r.document;
};
const doc = parse(JSON.parse(raw));
const ventas = parse(JSON.parse(ventasRaw));
const messages = (d: DataDocument): string[] => analyzeData(d).map((i) => i.message);
const errorsOf = (input: unknown): string => {
  const r = validateDataDocument(input);
  return r.ok ? '' : formatDataIssues(r.issues);
};
const asset = (d: DataDocument, id: string): DataAsset => d.assets.find((a) => a.id === id)!;
const term = (d: DataDocument, id: string): GlossaryTerm => (d.terms ?? []).find((t) => t.id === id)!;
/** Aplica una edición del editor que se espera correcta y devuelve el documento resultante (siempre válido). */
function edited(result: ReturnType<typeof dataEditor.addNode>): DataDocument {
  if (!result.ok) throw new Error(result.reason);
  expect(validateDataDocument(result.document).ok).toBe(true);
  return result.document;
}
/** Un documento mínimo con un producto, una API, un glosario y un término. */
const base = (extra: Partial<DataDocument> = {}): DataDocument =>
  parse({
    assets: [
      { id: 'db', kind: 'database', name: 'DB', owner: 'Equipo' },
      { id: 't1', kind: 'table', name: 'T1', parentId: 'db', columns: [{ name: 'id' }, { name: 'email', pii: true }] },
      { id: 't2', kind: 'table', name: 'T2', parentId: 'db' },
    ],
    ...extra,
  });

describe('catálogo: esquema', () => {
  it('el ejemplo del catálogo es válido, completo y no deja avisos', () => {
    expect(doc.assets.filter((a) => ['data-product', 'data-api', 'glossary'].includes(a.kind)).map((a) => a.kind)).toEqual(['data-product', 'data-product', 'data-api', 'glossary']);
    expect(doc.terms?.map((t) => t.id)).toEqual(['cliente', 'venta', 'ingresos', 'fuga']);
    expect(analyzeData(doc)).toEqual([]);
    expect(listLinks(doc).map((l) => l.id)).toContain('publishes:ventas-360>dwh-fact-ventas');
  });

  it('es compatible: un documento 1.0 sin catálogo no cambia (sin términos, sin puertos y con las mismas vistas)', () => {
    expect(ventas.version).toBe('1.0');
    expect(ventas.terms).toBeUndefined();
    expect(JSON.stringify(ventas)).not.toMatch(/inputPorts|outputPorts|exposes|"terms"/);
    expect(listViews(ventas).map((v) => v.id)).toEqual(['lineage', 'erd', 'domain:ventas', 'domain:clientes', 'domain:plataforma']);
    expect(parse(JSON.parse(JSON.stringify(ventas)))).toEqual(ventas);
    // los campos del catálogo son todos opcionales: un producto, una API o un glosario mínimos son válidos
    expect(parse({ assets: [{ id: 'p', kind: 'data-product', name: 'P' }, { id: 'a', kind: 'data-api', name: 'A' }, { id: 'g', kind: 'glossary', name: 'G' }] }).assets).toHaveLength(3);
    expect(parse({ terms: [{ id: 'x', name: 'X' }] }).terms).toEqual([{ id: 'x', name: 'X' }]);
  });

  it('rechaza puertos, exposiciones y términos mal formados', () => {
    const bad = {
      assets: [
        { id: 'db', kind: 'database', name: 'DB', inputPorts: ['db'], outputPorts: ['db'] },
        { id: 't', kind: 'table', name: 'T', exposes: ['db'] },
        { id: 'g', kind: 'glossary', name: 'G' },
        { id: 'p', kind: 'data-product', name: 'P', inputPorts: ['t', 'g', 'nada', 't'], outputPorts: ['t', 'p'] },
        { id: 'p2', kind: 'data-product', name: 'P2', exposes: ['t'] },
        { id: 'a', kind: 'data-api', name: 'A', exposes: ['g', 'a2', 'a'] },
        { id: 'a2', kind: 'data-api', name: 'A2' },
      ],
      terms: [
        { id: 'x', name: 'X', glossaryId: 't', links: [{ assetId: 'g' }, { assetId: 'nada' }, { assetId: 't', column: 'c' }, { assetId: 't', column: 'c' }] },
        { id: 'x', name: 'Repetido' },
        { id: 't', name: 'Con id de activo' },
        { id: 'y', name: 'Y', glossaryId: 'fantasma' },
      ],
    };
    const text = errorsOf(bad);
    for (const fragment of [
      'Solo un producto de datos tiene inputPorts, pero "db" es de tipo "database"',
      'Solo una API de datos tiene exposes, pero "t" es de tipo "table"',
      'Solo un producto de datos tiene outputPorts',
      'Un glosario no es un puerto de producto',
      'referencia un activo inexistente en inputPorts: "nada"',
      'repite "t" en inputPorts',
      'no puede consumir y publicar el mismo activo: "t"',
      'Un producto no puede ser puerto de sí mismo',
      'Una API no expone un glosario',
      'Una API no expone a otra API',
      'Id de término duplicado: "x"',
      'El término "t" repite el id de un activo',
      'referencia un glosario inexistente: "fantasma"',
      'Un término solo pertenece a un glosario',
      'enlaza un activo inexistente: "nada"',
      'Un término se enlaza con activos de datos',
      'enlaza dos veces "t.c"',
    ]) expect(text, fragment).toContain(fragment);
    // un protocolo y un estado fuera del catálogo se rechazan por el enum
    expect(errorsOf({ assets: [{ id: 'a', kind: 'data-api', name: 'A', protocol: 'ftp' }] })).toMatch(/assets\.0\.protocol/);
    expect(errorsOf({ terms: [{ id: 'z', name: 'Z', status: 'listo' }] })).toMatch(/terms\.0\.status/);
    expect(errorsOf({ assets: [{ id: 'a', kind: 'catalogo', name: 'A' }] })).toMatch(/assets\.0\.kind/);
  });

  it('el JSON Schema publica los tipos y campos nuevos y los ficheros de schema/ están al día', () => {
    const schema = JSON.stringify(dataModule.jsonSchema());
    for (const fragment of ['data-product', 'data-api', 'glossary', 'inputPorts', 'outputPorts', 'exposes', 'freshness', 'protocol', 'endpoint', '"terms"']) expect(schema).toContain(fragment);
    // los ficheros publicados añaden `$id` y `title` a lo que genera el módulo
    expect(JSON.parse(readFileSync('schema/data-document.schema.json', 'utf8'))).toMatchObject(JSON.parse(schema));
    expect(JSON.parse(readFileSync('schema/data-generation.schema.json', 'utf8'))).toMatchObject(JSON.parse(JSON.stringify(dataAiSpec.generationJsonSchema())));
  });
});

describe('catálogo: avisos de gobierno', () => {
  const issuesOf = (d: DataDocument) => analyzeData(d).filter((i) => i.elementId !== undefined);

  it('un producto sin dueño, sin salidas, sin SLA ni contrato se avisa; con todo, no', () => {
    const d = base({ assets: [...base().assets, { id: 'p', kind: 'data-product', name: 'Ventas' }] });
    const m = messages(d);
    expect(m).toContain('Producto de datos «Ventas» no tiene dueño (owner): nadie responde de su calidad ni de su SLA.');
    expect(m).toContain('Producto de datos «Ventas» no publica ningún activo: sin puertos de salida no ofrece nada.');
    expect(m).toContain('Producto de datos «Ventas» no declara puertos de entrada: no se sabe de dónde salen sus datos.');
    expect(m).toContain('Producto de datos «Ventas» no declara su frescura ni su SLA.');
    expect(m).toContain('Producto de datos «Ventas» no tiene contrato de datos (contractId).');
    expect(issuesOf(d).find((i) => i.elementId === 'p' && i.message.includes('dueño'))?.severity).toBe('warning');
    expect(issuesOf(d).find((i) => i.elementId === 'p' && i.message.includes('frescura'))?.severity).toBe('info');
    // el dueño puede venir del contenedor de dominio; un producto completo no tiene avisos propios
    expect(analyzeData(doc).filter((i) => ['ventas-360', 'analitica-fuga', 'api-ventas', 'glosario-ventas'].includes(i.elementId ?? ''))).toEqual([]);
  });

  it('una API sin dueño, sin contrato o sin nada que exponer se avisa', () => {
    const d = base({ assets: [...base().assets, { id: 'a', kind: 'data-api', name: 'API clientes' }] });
    const m = messages(d);
    expect(m).toContain('API de datos «API clientes» no tiene dueño (owner): nadie responde de su disponibilidad ni de sus cambios.');
    expect(m).toContain('API de datos «API clientes» no expone ningún activo.');
    expect(m).toContain('API de datos «API clientes» no tiene contrato de datos (contractId): quien la consume no sabe qué esperar.');
    expect(m).toContain('API de datos «API clientes» no declara su protocolo.');
    expect(issuesOf(d).find((i) => i.elementId === 'a' && i.message.includes('contrato'))?.severity).toBe('warning');
  });

  it('un producto o una API que sirve datos sensibles sin clasificación suficiente se avisa', () => {
    const d = base();
    const sensitive = { ...d, assets: d.assets.map((a) => (a.id === 't1' ? { ...a, classification: 'restricted' as const } : a)) };
    const open = { ...sensitive, assets: [...sensitive.assets, { id: 'p', kind: 'data-product' as const, name: 'P', owner: 'E', outputPorts: ['t1'], classification: 'internal' as const }, { id: 'a', kind: 'data-api' as const, name: 'A', owner: 'E', exposes: ['t1'] }] };
    const m = messages(open);
    expect(m).toContain('Producto de datos «P» está clasificado como interna pero publica Tabla «T1» (clasificado como restringida): como mínimo debería ser restringida.');
    expect(m).toContain('API de datos «A» expone Tabla «T1» (clasificado como restringida) pero no declara su clasificación.');
    const ok = { ...open, assets: open.assets.map((a) => (a.kind === 'data-product' || a.kind === 'data-api' ? { ...a, classification: 'restricted' as const } : a)) };
    expect(messages(ok).some((x) => x.includes('clasificación') || x.includes('está clasificado'))).toBe(false);
  });

  it('un término aprobado sin enlace, sin definición o sin responsable es un aviso; un borrador, solo información', () => {
    const d = base({
      assets: [...base().assets, { id: 'g', kind: 'glossary', name: 'Glosario', owner: 'Gobierno' }],
      terms: [
        { id: 'ok', name: 'Bueno', definition: 'Definido', owner: 'Ana', status: 'approved', glossaryId: 'g', links: [{ assetId: 't1', column: 'id' }] },
        { id: 'vacio', name: 'Vacío', status: 'approved', glossaryId: 'g' },
        { id: 'borrador', name: 'Borrador', glossaryId: 'g' },
        { id: 'viejo', name: 'Viejo', definition: 'Ya no se usa', owner: 'Ana', status: 'deprecated', glossaryId: 'g', links: [{ assetId: 't2' }] },
        { id: 'viejo-sin-enlace', name: 'Retirado', definition: 'Retirado', owner: 'Ana', status: 'deprecated', glossaryId: 'g' },
      ],
    });
    const found = (id: string) => analyzeData(d).filter((i) => i.elementId === id);
    expect(found('ok')).toEqual([]);
    expect(found('vacio').map((i) => [i.severity, i.message])).toEqual([
      ['warning', 'Término «Vacío» no está enlazado a ningún activo ni columna.'],
      ['warning', 'Término «Vacío» no tiene definición.'],
      ['warning', 'Término «Vacío» no tiene responsable (owner).'],
    ]);
    expect(found('borrador').every((i) => i.severity === 'info')).toBe(true);
    expect(found('borrador')).toHaveLength(3);
    expect(found('viejo').map((i) => i.message)).toEqual(['Término «Viejo» está obsoleto pero sigue enlazado a 1 activo(s) o columna(s).']);
    expect(found('viejo-sin-enlace')).toEqual([]);
  });

  it('avisa de términos repetidos, columnas que no existen, términos sin glosario, glosarios vacíos y glosarios en un pipeline', () => {
    const d = base({
      assets: [...base().assets, { id: 'g', kind: 'glossary', name: 'Glosario' }, { id: 'g2', kind: 'glossary', name: 'Vacío' }],
      pipelines: [{ id: 'p', name: 'Carga', kind: 'batch', inputs: ['t1'], outputs: ['t2'] }],
      terms: [
        { id: 'a', name: 'Cliente', definition: 'x', owner: 'Ana', status: 'approved', glossaryId: 'g', links: [{ assetId: 't1', column: 'inexistente' }] },
        { id: 'b', name: ' cliente ', definition: 'x', owner: 'Ana', status: 'approved', glossaryId: 'g', links: [{ assetId: 't1' }] },
        { id: 'c', name: 'Suelto', definition: 'x', owner: 'Ana', status: 'approved', links: [{ assetId: 't1' }] },
      ],
    });
    const m = messages(d);
    expect(m).toContain('Término «Cliente» enlaza la columna «inexistente», que Tabla «T1» no declara.');
    expect(m).toContain('Término « cliente » está definido dos veces en el glosario «Glosario» (también como «a»).');
    expect(m).toContain('Término «Suelto» no pertenece a ningún glosario.');
    expect(m).toContain('Glosario «Vacío» no tiene términos.');
  });

  it('un glosario no guarda datos: un pipeline que lo lea o lo escriba se avisa y el editor no deja conectarlo', () => {
    const d: DataDocument = parse({ assets: [{ id: 'g', kind: 'glossary', name: 'Glosario' }, { id: 't', kind: 'table', name: 'T' }], pipelines: [{ id: 'p', name: 'Carga', kind: 'batch', inputs: ['g'], outputs: ['t'] }, { id: 'q', name: 'Vuelca', kind: 'batch', inputs: ['t'], outputs: ['g'] }] });
    expect(messages(d)).toContain('El pipeline «Carga» lee Glosario «Glosario», que define términos y no guarda datos.');
    expect(messages(d)).toContain('El pipeline «Vuelca» escribe Glosario «Glosario», que define términos y no guarda datos.');
    expect(dataEditor.canConnect?.(d, 'pipeline', 'g', 't')).toMatch(/define términos, no guarda datos/);
    expect(dataEditor.canConnect?.(d, 'pipeline', 't', 'g')).toMatch(/define términos, no guarda datos/);
  });
});

describe('catálogo: vistas', () => {
  it('el mapa de productos dibuja productos y APIs con sus puertos, y los activos del otro extremo como contexto', () => {
    const view = findView(doc, 'products');
    expect(view.type).toBe('products');
    expect(view.assetIds).toEqual(expect.arrayContaining(['ventas-360', 'analitica-fuga', 'api-ventas', 'silver-ventas', 'dwh-fact-ventas', 'dwh-dim-cliente', 'modelo-fuga']));
    expect(view.assetIds).not.toContain('glosario-ventas');
    expect(view.linkIds).toEqual(listLinks(doc).filter((l) => l.kind !== 'defines').map((l) => l.id));
    // todo lo que se publica, se consume o se expone ya está en el foco: nada se dibuja como contexto
    expect(view.contextIds).toEqual([]);
    expect(view.pipelineIds).toEqual([]);
    expect(view.termIds).toEqual([]);
  });

  it('la vista del glosario dibuja sus términos y los activos a los que se enlazan', () => {
    const view = findView(doc, 'glossary');
    expect(view.type).toBe('glossary');
    expect(view.termIds).toEqual(['cliente', 'venta', 'ingresos', 'fuga']);
    expect(view.assetIds).toEqual(expect.arrayContaining(['glosario-ventas', 'crm-clientes', 'dwh-fact-ventas', 'panel-ventas']));
    expect(view.linkIds).toEqual(listLinks(doc).filter((l) => l.kind === 'defines').map((l) => l.id));
    // los activos enlazados son contexto de la vista; el glosario es su foco
    expect(view.contextIds).toEqual(expect.arrayContaining(['crm-clientes', 'dwh-fact-ventas']));
    expect(view.contextIds).not.toContain('glosario-ventas');
  });

  it('un producto con puertos no ensucia el linaje, y un activo suelto del catálogo sigue estando en él', () => {
    const lineage = findView(doc, 'lineage');
    expect(lineage.assetIds).not.toContain('ventas-360');
    expect(lineage.assetIds).not.toContain('glosario-ventas');
    expect(lineage.assetIds).not.toContain('api-ventas');
    const lone = parse({ assets: [{ id: 'p', kind: 'data-product', name: 'P' }, { id: 't', kind: 'table', name: 'T' }], pipelines: [] });
    expect(findView(lone, 'lineage').assetIds).toEqual(['p', 't']);
    expect(listViews(lone).map((v) => v.id)).toEqual(['lineage', 'products']);
  });

  it('las vistas de dominio incluyen las flechas de puertos de sus productos', () => {
    const view = findView(doc, 'domain:ventas');
    expect(view.linkIds).toEqual(expect.arrayContaining(['publishes:ventas-360>api-ventas', 'consumes:silver-ventas>ventas-360', 'exposes:dwh-fact-ventas>api-ventas']));
    expect(view.assetIds).toContain('ventas-360');
  });
});

describe('catálogo: editor', () => {
  it('la paleta ofrece los tipos nuevos con su figura y las relaciones del catálogo', () => {
    const kinds = dataEditor.nodeKinds;
    expect(kinds.find((k) => k.kind === 'data-product')).toMatchObject({ label: 'Producto de datos', shape: 'cube' });
    expect(kinds.find((k) => k.kind === 'data-api')).toMatchObject({ label: 'API de datos', shape: 'pill' });
    expect(kinds.find((k) => k.kind === 'glossary')).toMatchObject({ label: 'Glosario', shape: 'bar' });
    expect(kinds.find((k) => k.kind === 'term')).toMatchObject({ label: 'Término' });
    expect(dataEditor.edgeKinds.map((e) => e.kind)).toEqual(expect.arrayContaining(['publishes', 'consumes', 'exposes', 'defines']));
    expect(dataEditor.edgeKinds.find((e) => e.kind === 'defines')).toMatchObject({ line: 'dashed', head: 'open' });
  });

  it('el grafo de cada vista lleva los nodos de catálogo, los términos dentro de su glosario y las flechas con su etiqueta', () => {
    const products = dataEditor.project(doc, 'products');
    expect(products.nodes.find((n) => n.id === 'ventas-360')).toMatchObject({ kind: 'data-product' });
    expect(products.nodes.find((n) => n.id === 'ventas-360')?.sublabel).toContain('frescura 24 h');
    expect(products.edges.find((e) => e.id === 'consumes:silver-ventas>ventas-360')).toMatchObject({ kind: 'consumes', source: 'silver-ventas', target: 'ventas-360', label: 'entrada' });
    expect(products.edges.find((e) => e.id === 'exposes:dwh-fact-ventas>api-ventas')?.label).toBe('expuesto en');
    const glossary = dataEditor.project(doc, 'glossary');
    expect(glossary.nodes.find((n) => n.id === 'cliente')).toMatchObject({ kind: 'term', parentId: 'glosario-ventas' });
    expect(glossary.nodes.find((n) => n.id === 'fuga')?.badges).toContain('borrador');
    expect(glossary.edges.find((e) => e.id === 'defines:ingresos>dwh-fact-ventas')?.label).toBe('importe');
    // una API sin contrato lleva su aviso en el nodo
    const noContract = { ...doc, assets: doc.assets.map((a) => (a.id === 'api-ventas' ? { ...a, contractId: undefined } : a)) };
    expect(dataEditor.project(noContract, 'products').nodes.find((n) => n.id === 'api-ventas')?.badges).toContain('⚠ sin contrato');
  });

  it('los formularios de cada tipo ofrecen sus campos propios', () => {
    const keys = (kind: string, type: 'node' | 'edge' = 'node') => dataEditor.fields({ type, kind }, doc).map((f) => f.key);
    expect(keys('data-product')).toEqual(expect.arrayContaining(['name', 'owner', 'freshness', 'sla', 'contractId']));
    expect(keys('data-product')).not.toContain('protocol');
    expect(keys('data-api')).toEqual(expect.arrayContaining(['protocol', 'endpoint', 'contractId']));
    expect(keys('glossary')).toEqual(expect.arrayContaining(['name', 'owner']));
    expect(keys('term')).toEqual(['name', 'definition', 'status', 'owner', 'glossaryId', 'synonyms']);
    expect(keys('defines', 'edge')).toEqual(['column']);
    expect(dataEditor.read(doc, 'cliente')).toMatchObject({ type: 'node', kind: 'term', values: { name: 'Cliente', status: 'approved' } });
    expect(dataEditor.read(doc, 'defines:ingresos>dwh-fact-ventas')).toEqual({ type: 'edge', kind: 'defines', values: { column: 'importe' } });
    expect(dataEditor.read(doc, 'ventas-360')).toMatchObject({ kind: 'data-product' });
  });

  it('crea productos, APIs, glosarios y términos desde la paleta; el término nace en el glosario elegido o en el único que hay', () => {
    let d = edited(dataEditor.addNode(base(), 'data-product', 'Ventas 360'));
    d = edited(dataEditor.addNode(d, 'data-api', 'API de ventas'));
    d = edited(dataEditor.addNode(d, 'glossary', 'Glosario de ventas'));
    expect(d.assets.slice(-3).map((a) => [a.id, a.kind])).toEqual([['ventas-360', 'data-product'], ['api-de-ventas', 'data-api'], ['glosario-de-ventas', 'glossary']]);
    d = edited(dataEditor.addNode(d, 'term', 'Cliente'));
    expect(term(d, 'cliente')).toEqual({ id: 'cliente', name: 'Cliente', glossaryId: 'glosario-de-ventas' });
    // con dos glosarios, el término nace en el seleccionado
    d = edited(dataEditor.addNode(d, 'glossary', 'Finanzas'));
    d = edited(dataEditor.addNode(d, 'term', 'Margen', 'finanzas'));
    expect(term(d, 'margen').glossaryId).toBe('finanzas');
    d = edited(dataEditor.addNode(d, 'term', 'Otro', 'cliente'));
    expect(term(d, 'otro').glossaryId).toBe('glosario-de-ventas');
    d = edited(dataEditor.addNode(d, 'term', 'Sin glosario'));
    expect(term(d, 'sin-glosario').glossaryId).toBeUndefined();
    // los ids no chocan con los de un activo
    d = edited(dataEditor.addNode(d, 'term', 'Ventas 360'));
    expect(d.terms?.map((t) => t.id)).toContain('ventas-360-2');
  });

  it('«Publica», «Consume» y «Expone» crean puertos y exposiciones, y los ids de las flechas son estables', () => {
    let d = edited(dataEditor.addNode(base(), 'data-product', 'P'));
    d = edited(dataEditor.addNode(d, 'data-api', 'A'));
    const published = dataEditor.addEdge(d, 'publishes', 'p', 't1');
    expect(published).toMatchObject({ ok: true, id: 'publishes:p>t1' });
    d = edited(published);
    const consumed = dataEditor.addEdge(d, 'consumes', 't2', 'p');
    expect(consumed).toMatchObject({ ok: true, id: 'consumes:t2>p' });
    d = edited(consumed);
    // «Expone» vale en los dos sentidos
    d = edited(dataEditor.addEdge(d, 'exposes', 'a', 't1'));
    d = edited(dataEditor.addEdge(d, 'exposes', 't2', 'a'));
    expect(asset(d, 'p')).toMatchObject({ outputPorts: ['t1'], inputPorts: ['t2'] });
    expect(asset(d, 'a').exposes).toEqual(['t1', 't2']);
    expect(listLinks(d).map((l) => l.id)).toEqual(['consumes:t2>p', 'publishes:p>t1', 'exposes:t1>a', 'exposes:t2>a']);
    // borrar la flecha quita el puerto, y el campo queda ausente cuando se vacía
    d = edited(dataEditor.remove(d, 'consumes:t2>p'));
    expect(asset(d, 'p').inputPorts).toBeUndefined();
    d = edited(dataEditor.remove(d, 'exposes:t1>a'));
    expect(asset(d, 'a').exposes).toEqual(['t2']);
  });

  it('explica por qué no se puede unir cada pareja', () => {
    let d = edited(dataEditor.addNode(base(), 'data-product', 'P'));
    d = edited(dataEditor.addNode(d, 'data-api', 'A'));
    d = edited(dataEditor.addNode(d, 'glossary', 'G'));
    d = edited(dataEditor.addNode(d, 'term', 'Término'));
    d = edited(dataEditor.addEdge(d, 'publishes', 'p', 't1'));
    const why = (kind: string, s: string, t: string) => dataEditor.canConnect?.(d, kind, s, t);
    expect(why('publishes', 't1', 't2')).toMatch(/sale de un producto de datos/);
    expect(why('consumes', 't1', 't2')).toMatch(/llega a un producto de datos/);
    expect(why('publishes', 'p', 'g')).toMatch(/Un glosario no es un puerto/);
    expect(why('publishes', 'p', 't1')).toMatch(/ya publica/);
    expect(why('consumes', 't1', 'p')).toMatch(/ya publica.*entrada y salida/);
    expect(why('publishes', 'p', 'p')).toMatch(/consigo mismo/);
    expect(why('exposes', 't1', 't2')).toMatch(/«Expone» une una API de datos con un activo/);
    expect(why('exposes', 'a', 'g')).toMatch(/no expone un glosario/);
    expect(why('exposes', 'a', 'p')).toBeUndefined();
    expect(why('defines', 'terminos', 't1')).toMatch(/no existe/);
    expect(why('defines', 'termino', 'g')).toMatch(/no con glosario|Un término se enlaza con activos de datos/);
    expect(why('defines', 'termino', 't1')).toBeUndefined();
    // un término no es un nodo de pipeline ni de entidad-relación
    expect(why('pipeline', 'termino', 't1')).toMatch(/no participa en pipelines/);
    expect(why('1:N', 't1', 'termino')).toMatch(/no participa en pipelines/);
    // los pipelines no se conectan con productos
    expect(why('publishes', 'p', 'pipeline:x')).toBeDefined();
    expect(dataEditor.addEdge(d, 'publishes', 't1', 't2')).toMatchObject({ ok: false });
  });

  it('«Define» enlaza un término con un activo; la columna se valida contra las que declara y no cambia el id de la flecha', () => {
    let d = edited(dataEditor.addNode(base(), 'glossary', 'G'));
    d = edited(dataEditor.addNode(d, 'term', 'Correo'));
    const linked = dataEditor.addEdge(d, 'defines', 'correo', 't1');
    expect(linked).toMatchObject({ ok: true, id: 'defines:correo>t1' });
    d = edited(linked);
    expect(term(d, 'correo').links).toEqual([{ assetId: 't1' }]);
    // el mismo activo solo se enlaza otra vez a una columna concreta
    expect(dataEditor.canConnect?.(d, 'defines', 'correo', 't1')).toMatch(/ya está enlazado/);
    expect(dataEditor.update(d, 'defines:correo>t1', { column: 'telefono' })).toMatchObject({ ok: false, reason: expect.stringContaining('no tiene la columna «telefono»') });
    d = edited(dataEditor.update(d, 'defines:correo>t1', { column: 'email' }));
    expect(term(d, 'correo').links).toEqual([{ assetId: 't1', column: 'email' }]);
    expect(dataEditor.project(d, 'glossary').edges.find((e) => e.id === 'defines:correo>t1')?.label).toBe('email');
    // con una columna ya fijada se puede enlazar otra del mismo activo (id con sufijo) y no se pueden repetir
    const second = dataEditor.addEdge(d, 'defines', 'correo', 't1');
    expect(second).toMatchObject({ ok: true, id: 'defines:correo>t1#2' });
    d = edited(second);
    expect(dataEditor.update(d, 'defines:correo>t1#2', { column: 'email' })).toMatchObject({ ok: false });
    d = edited(dataEditor.update(d, 'defines:correo>t1#2', { column: 'id' }));
    expect(term(d, 'correo').links).toEqual([{ assetId: 't1', column: 'email' }, { assetId: 't1', column: 'id' }]);
    // quitar la columna deja el enlace sin columna; borrar la flecha quita el enlace
    d = edited(dataEditor.update(d, 'defines:correo>t1', { column: '' }));
    expect(term(d, 'correo').links?.[0]).toEqual({ assetId: 't1' });
    d = edited(dataEditor.remove(d, 'defines:correo>t1#2'));
    d = edited(dataEditor.remove(d, 'defines:correo>t1'));
    expect(term(d, 'correo').links).toBeUndefined();
  });

  it('edita términos y activos del catálogo y rechaza valores inválidos', () => {
    let d = edited(dataEditor.update(doc, 'fuga', { status: 'approved', owner: '', synonyms: ['abandono'], definition: 'Nueva' }));
    expect(term(d, 'fuga')).toMatchObject({ status: 'approved', synonyms: ['abandono'], definition: 'Nueva' });
    expect(term(d, 'fuga').owner).toBeUndefined();
    expect(dataEditor.update(d, 'fuga', { status: 'raro' })).toMatchObject({ ok: false });
    expect(dataEditor.update(d, 'fuga', { name: ' ' })).toMatchObject({ ok: false });
    expect(dataEditor.update(d, 'fuga', { glossaryId: 'fantasma' })).toMatchObject({ ok: false });
    expect(dataEditor.update(d, 'fuga', { glossaryId: 'dwh-dim-cliente' })).toMatchObject({ ok: false });
    d = edited(dataEditor.update(d, 'ventas-360', { freshness: '12 h', sla: '', owner: 'Equipo X' }));
    expect(asset(d, 'ventas-360')).toMatchObject({ freshness: '12 h', owner: 'Equipo X' });
    expect(asset(d, 'ventas-360').sla).toBeUndefined();
    expect(dataEditor.update(d, 'api-ventas', { protocol: 'ftp' })).toMatchObject({ ok: false });
    expect(dataEditor.update(d, 'api-ventas', { contractId: 'nada' })).toMatchObject({ ok: false });
    d = edited(dataEditor.update(d, 'api-ventas', { protocol: 'graphql', endpoint: 'https://api.acme.com/graphql' }));
    expect(asset(d, 'api-ventas')).toMatchObject({ protocol: 'graphql', endpoint: 'https://api.acme.com/graphql' });
  });

  it('borrar un activo limpia los puertos, las exposiciones y los enlaces que lo apuntan; borrar un glosario, sus términos', () => {
    const d = edited(dataEditor.remove(doc, 'dwh-fact-ventas'));
    expect(asset(d, 'ventas-360').outputPorts).toEqual(['dwh-dim-cliente', 'api-ventas']);
    expect(asset(d, 'api-ventas').exposes).toBeUndefined();
    expect(term(d, 'ingresos').links).toEqual([{ assetId: 'panel-ventas' }]);
    expect(term(d, 'venta').links).toEqual([{ assetId: 'erp-pedidos', column: 'id' }]);
    const g = edited(dataEditor.remove(doc, 'glosario-ventas'));
    expect(g.terms).toEqual([]);
    const t = edited(dataEditor.remove(doc, 'cliente'));
    expect(t.terms?.map((x) => x.id)).toEqual(['venta', 'ingresos', 'fuga']);
    // borrar el contenedor arrastra a sus tablas y todo lo que las apunta
    const erp = edited(dataEditor.remove(doc, 'dwh'));
    expect(erp.assets.some((a) => a.id === 'dwh-fact-ventas')).toBe(false);
    expect(asset(erp, 'ventas-360').outputPorts).toEqual(['api-ventas']);
    expect(pruneCatalog(ventas, new Set(['crm']))).not.toHaveProperty('terms');
  });

  it('el id de un activo nuevo no choca con el de un término', () => {
    const d = edited(dataEditor.addNode(doc, 'table', 'Cliente'));
    expect(d.assets.some((a) => a.id === 'cliente-2')).toBe(true);
  });
});

describe('catálogo: acciones sobre la selección', () => {
  const action = (id: string) => dataEditor.actions!.find((a) => a.id === id)!;

  it('«Agrupar en producto» crea un producto que publica la selección con el dominio y el dueño más comunes', () => {
    const a = action('group-product');
    expect(a.disabled?.(doc, ['glosario-ventas'])).toMatch(/Selecciona uno o varios activos/);
    const run = a.run(doc, ['dwh-dim-cliente', 'silver-ventas'], 'Clientes y ventas');
    expect(run).toMatchObject({ ok: true, id: 'clientes-y-ventas' });
    if (!run.ok) return;
    expect(validateDataDocument(run.document).ok).toBe(true);
    expect(asset(run.document, 'clientes-y-ventas')).toMatchObject({ kind: 'data-product', name: 'Clientes y ventas', outputPorts: ['silver-ventas', 'dwh-dim-cliente'] });
    expect(a.run(doc, ['silver-ventas'], '  ')).toMatchObject({ ok: false });
    // el producto existente se amplía (sin duplicar ni pasar una entrada a salida)
    const again = a.run(doc, ['silver-ventas', 'dwh-fact-ventas', 'modelo-fuga'], 'ventas 360');
    expect(again).toMatchObject({ ok: true, id: 'ventas-360' });
    if (again.ok) expect(asset(again.document, 'ventas-360').outputPorts).toEqual(['dwh-fact-ventas', 'dwh-dim-cliente', 'api-ventas', 'modelo-fuga']);
    expect(a.prompt?.suggestions?.(doc)).toEqual(['Ventas 360', 'Analítica de fuga']);
  });

  it('«Enlazar término» une los términos y los activos seleccionados sin duplicar enlaces', () => {
    const a = action('link-term');
    expect(a.disabled?.(doc, ['dwh-dim-cliente'])).toMatch(/Selecciona uno o varios términos/);
    expect(a.disabled?.(doc, ['fuga'])).toMatch(/activos con los que se enlazan/);
    expect(a.disabled?.(doc, ['cliente', 'dwh-dim-cliente'])).toMatch(/ya están enlazados/);
    const run = a.run(doc, ['fuga', 'cliente', 'dwh-dim-cliente', 'silver-ventas']);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(validateDataDocument(run.document).ok).toBe(true);
    // en el orden del documento
    expect(term(run.document, 'fuga').links).toEqual([{ assetId: 'modelo-fuga' }, { assetId: 'silver-ventas' }, { assetId: 'dwh-dim-cliente' }]);
    expect(term(run.document, 'cliente').links).toEqual([...term(doc, 'cliente').links!, { assetId: 'silver-ventas' }]);
    expect(a.run(doc, ['cliente', 'dwh-dim-cliente'])).toMatchObject({ ok: false });
  });
});

describe('catálogo: exportación', () => {
  it('SVG: producto, API y glosario con su figura y sus flechas etiquetadas, y los términos uniformes', async () => {
    const products = await toSvg(doc, 'products');
    expect(products).toContain('PRODUCTO DE DATOS');
    expect(products).toContain('API DE DATOS');
    expect(products).toContain('frescura 24 h');
    expect(products).toContain('https://api.acme.com/ventas/v1');
    expect(products).toContain('>entrada<');
    expect(products).toContain('>salida<');
    expect(products).toContain('>expuesto en<');
    const glossary = await toSvg(doc, 'glossary');
    expect(glossary).toContain('Glosario: Ventas y clientes');
    expect(glossary).toContain('TÉRMINO');
    expect(glossary).toContain('>importe<');
    // todos los términos miden lo mismo de ancho y su definición se parte en líneas en vez de cortarse
    const { layout } = await layoutView(doc, 'glossary');
    const widths = new Set(layout.nodes.filter((n) => (doc.terms ?? []).some((t) => t.id === n.id)).map((n) => n.width));
    expect(widths.size).toBe(1);
    const lines = termLines(term(doc, 'fuga'));
    expect(lines).toEqual(['Fuga de clientes', 'Cliente que deja de comprar durante', 'doce meses seguidos', 'borrador · Ciencia de datos']);
    expect(termLines({ id: 'x', name: 'X', definition: 'palabra '.repeat(20) }).at(-1)).toMatch(/…$/);
    // el dominio mantiene sus productos y la API en el mismo diagrama
    expect(await toSvg(doc, 'domain:ventas')).toContain('Ventas 360');
  });

  it('draw.io: términos, glosario y flechas de catálogo apuntan a celdas existentes', async () => {
    const xml = await toDrawio(doc);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const pages = ([] as unknown[]).concat(parsed.mxfile.diagram) as Array<{ '@_name': string; mxGraphModel: { root: { mxCell: Array<Record<string, string>> } } }>;
    expect(pages).toHaveLength(exportViews(doc).length);
    for (const page of pages) {
      const cells = page.mxGraphModel.root.mxCell;
      const ids = new Set(cells.map((c) => c['@_id']));
      for (const c of cells.filter((x) => x['@_edge'])) {
        expect(ids.has(c['@_source'])).toBe(true);
        expect(ids.has(c['@_target'])).toBe(true);
      }
    }
    expect(xml).toContain('Ventas 360');
    expect(xml).toContain('Fuga de clientes');
    expect(xml).toContain('expuesto en');
    expect(xml).toContain('importe');
  });

  it('Mermaid: ida y vuelta del mapa de productos con puertos, protocolo y SLA', () => {
    const source = toMermaid(doc, { viewId: 'products' });
    expect(source).toContain(':::dataProduct');
    expect(source).toContain(':::dataApi');
    expect(source).toContain('classDef dataProduct');
    expect(source).toContain('-.->|"expuesto en"|');
    const { document, warnings } = fromMermaid(source);
    expect(warnings).toEqual([]);
    const product = asset(document, 'ventas-360');
    expect(product).toMatchObject({ kind: 'data-product', name: 'Ventas 360', inputPorts: ['silver-ventas'], outputPorts: ['dwh-fact-ventas', 'dwh-dim-cliente', 'api-ventas'], freshness: '24 h', sla: '99,5 % de disponibilidad · soporte L-V', technology: 'dbt + Snowflake' });
    expect(asset(document, 'analitica-fuga')).toMatchObject({ inputPorts: ['dwh-dim-cliente', 'dwh-fact-ventas'], outputPorts: ['modelo-fuga'] });
    expect(asset(document, 'api-ventas')).toMatchObject({ kind: 'data-api', protocol: 'rest', endpoint: 'https://api.acme.com/ventas/v1', exposes: ['dwh-fact-ventas'], technology: 'Kong + FastAPI' });
    // las flechas del catálogo no se importan como pipelines
    expect(document.pipelines).toEqual([]);
    expect(listLinks(document).map((l) => l.id).sort()).toEqual(listLinks(doc).filter((l) => l.kind !== 'defines').map((l) => l.id).sort());
  });

  it('Mermaid: ida y vuelta del glosario con sus términos, estados y columnas enlazadas', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'glossary' }));
    expect(warnings).toEqual([]);
    expect(document.terms?.map((t) => t.id)).toEqual(['cliente', 'venta', 'ingresos', 'fuga']);
    expect(term(document, 'cliente')).toMatchObject({ name: 'Cliente', definition: 'Persona o empresa que ha realizado al menos una compra', status: 'approved', owner: 'Equipo CRM', glossaryId: 'glosario-ventas', links: [{ assetId: 'crm-clientes', column: 'id' }, { assetId: 'dwh-dim-cliente', column: 'cliente_key' }] });
    expect(term(document, 'fuga')).toMatchObject({ status: 'draft', links: [{ assetId: 'modelo-fuga' }] });
    expect(term(document, 'ingresos').links).toEqual([{ assetId: 'dwh-fact-ventas', column: 'importe' }, { assetId: 'panel-ventas' }]);
    expect(asset(document, 'glosario-ventas')).toMatchObject({ kind: 'glossary', name: 'Ventas y clientes' });
    expect(document.pipelines).toEqual([]);
  });

  it('Mermaid: reconoce las clases del catálogo escritas a mano y avisa de lo que no encaja', () => {
    const source = `flowchart LR
    t["Tabla"]
    p["Producto<br/>frescura 1 h"]:::producto
    a["API<br/>GraphQL<br/>https://x.dev/g"]:::api
    g["Glosario"]:::glosario
    p -->|"salida"| t
    a -.->|"expuesto en"| t
    t --> g`;
    const { document, warnings } = fromMermaid(source);
    expect(asset(document, 'p')).toMatchObject({ kind: 'data-product', freshness: '1 h', outputPorts: ['t'] });
    expect(asset(document, 'a')).toMatchObject({ kind: 'data-api', protocol: 'graphql', endpoint: 'https://x.dev/g' });
    expect(asset(document, 'g').kind).toBe('glossary');
    expect(warnings.join('\n')).toMatch(/glosario/i);
    expect(validateDataDocument(document).ok).toBe(true);
  });

  it('el módulo declara los términos como entidades', () => {
    expect(dataModule.entities!(doc).filter((e) => e.kind === 'term').map((e) => e.id)).toEqual(['cliente', 'venta', 'ingresos', 'fuga']);
    expect(dataModule.validate(doc)).toEqual([]);
  });
});

describe('catálogo: IA', () => {
  it('el prompt explica los tipos nuevos y el esquema de salida añade los términos', () => {
    const prompt = systemPrompt();
    for (const fragment of ['"data-product"', '"inputPorts"', '"outputPorts"', '"data-api"', '"exposes"', '"glossary"', '"terms"']) expect(prompt).toContain(fragment);
    const schema = dataAiSpec.generationJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('terms');
    const text = JSON.stringify(schema);
    for (const fragment of ['inputPorts', 'outputPorts', 'exposes', 'freshness', 'protocol', 'endpoint', 'synonyms']) expect(text).toContain(fragment);
  });

  it('la salida estructurada con nulls vuelve a un documento válido y completo', () => {
    const generated = toGenerated(doc);
    expect(generated.terms).toHaveLength(4);
    expect(generated.assets.find((a) => a.id === 'ventas-360')).toMatchObject({ inputPorts: ['silver-ventas'], freshness: '24 h', exposes: null, protocol: null });
    const back = generatedToData(generated);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // la especificación no incluye `ref` ni `contractId` (se conservan al refinar) ni los contratos
    const strip = (d: DataDocument) => ({ ...d, contracts: undefined, assets: d.assets.map(({ ref: _ref, contractId: _contractId, ...a }) => a) });
    expect(strip(back.document)).toEqual(JSON.parse(JSON.stringify(strip(doc))));
    // un documento sin glosario no declara `terms`
    const plain = generatedToData(toGenerated(ventas));
    expect(plain.ok && plain.document.terms).toBeUndefined();
    // los errores de catálogo se devuelven como incidencias legibles
    const broken = { ...generated, assets: generated.assets.map((a) => (a.id === 'ventas-360' ? { ...a, outputPorts: ['fantasma'] } : a)) };
    const failed = generatedToData(broken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues).toContain('referencia un activo inexistente en outputPorts');
    expect(dataAiSpec.user('Añade un término', doc)).toContain('"glossaryId": "glosario-ventas"');
  });
});

describe('catálogo: comandos', () => {
  const run = (name: string, input: unknown, options: Record<string, unknown> = {}) => dataCommands.find((c) => c.name === name)!.run({ args: [], options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

  it('products lista productos y APIs con su dueño, frescura, SLA, puertos y contrato', () => {
    const text = run('products', raw);
    expect(text).toContain('| Producto | Dominio | Dueño | Frescura | SLA | Entradas | Salidas | APIs | Contrato |');
    expect(text).toContain('| Ventas 360 | Ventas | Equipo Ventas | 24 h | 99,5 % de disponibilidad · soporte L-V | plata: ventas | fact_ventas; dim_cliente; API de ventas | API de ventas | Contrato de Ventas 360 |');
    expect(text).toContain('| API | Protocolo | Dirección | Dueño | Expone | Contrato |');
    expect(text).toContain('| API de ventas | REST | https://api.acme.com/ventas/v1 | Equipo Ventas | fact_ventas | Contrato de la API de ventas |');
    expect(run('products', ventasRaw)).toBe('No hay productos ni APIs de datos.');
  });

  it('glossary lista los términos con su estado, responsable y los activos y columnas a los que se enlazan', () => {
    const text = run('glossary', raw);
    expect(text).toContain('| Término | Glosario | Definición | Estado | Responsable | Enlazado a |');
    expect(text).toContain('| Ingresos | Ventas y clientes | Importe de las ventas sin impuestos en un periodo | aprobado | Finanzas | fact_ventas.importe; Panel de ventas |');
    expect(run('glossary', ventasRaw)).toBe('No hay términos en el glosario.');
  });

  it('las entradas que no son datos válidos terminan en un error de módulo', () => {
    expect(() => run('products', { assets: [{ id: 'a', kind: 'raro', name: 'A' }] })).toThrow(/Documento de datos inválido/);
    expect(() => run('glossary', 'no es json')).toThrow();
  });
});

describe('catálogo: convivencia con el ERD UML, los motores y el DDL', () => {
  const withColumns = (): DataDocument => {
    const d = base();
    return parse({
      ...d,
      assets: [
        ...d.assets,
        { id: 'p', kind: 'data-product', name: 'Producto con columnas', owner: 'E', columns: [{ name: 'id', type: 'int' }], outputPorts: ['t1'] },
        { id: 'a', kind: 'data-api', name: 'API con columnas', owner: 'E', columns: [{ name: 'id', type: 'int' }], exposes: ['t1'] },
        { id: 'g', kind: 'glossary', name: 'Glosario con columnas', columns: [{ name: 'id', type: 'int' }] },
      ],
      relations: [{ id: 'r', sourceId: 't1', targetId: 't2', cardinality: '1:N', sourceMin: 0, targetMin: 1 }],
    });
  };

  it('las vistas del catálogo se listan junto a las del ERD (pata de gallo y UML), los dominios y los mapas de calor', () => {
    expect(listViews(doc).map((v) => v.id).slice(0, 4)).toEqual(['lineage', 'erd', 'products', 'glossary']);
    const refs = viewRefs(doc);
    expect(refs.map((v) => v.id).slice(0, 6)).toEqual(['lineage', 'erd', 'erd:uml', 'products', 'glossary', 'domain:ventas']);
    expect(refs.find((v) => v.id === 'erd:uml')).toMatchObject({ variantOf: 'erd', variantLabel: 'UML' });
    expect(refs.find((v) => v.id === 'products')).toEqual({ id: 'products', title: 'Productos de datos - Catálogo de datos de ventas' });
    expect(refs.map((v) => v.id)).toEqual(expect.arrayContaining(['calor:clasificacion', 'domain:plataforma']));
    expect(exportViews(doc).map((v) => v.id).slice(0, 5)).toEqual(['lineage', 'erd', 'erd:uml', 'products', 'glossary']);
    // la variante UML sigue sin catálogo y con multiplicidades
    expect(findView(doc, 'erd:uml')).toMatchObject({ type: 'erd', notation: 'uml', linkIds: [], termIds: [] });
  });

  it('los productos, las APIs y los glosarios no entran en el ERD (pata de gallo ni UML) aunque declaren columnas', () => {
    const d = withColumns();
    for (const id of ['erd', 'erd:uml']) {
      const view = findView(d, id);
      expect(view.assetIds).toEqual(expect.arrayContaining(['t1', 't2']));
      expect(view.assetIds.filter((x) => ['p', 'a', 'g'].includes(x))).toEqual([]);
      expect(dataEditor.project(d, id).nodes.map((n) => n.id)).not.toEqual(expect.arrayContaining(['p']));
    }
    for (const [viewId, header] of [['erd', 'erDiagram'], ['erd:uml', 'classDiagram']] as const) {
      const mermaid = toMermaid(d, { viewId });
      expect(mermaid).toContain(header);
      expect(mermaid).not.toMatch(/Producto con columnas|API con columnas|Glosario con columnas/);
    }
  });

  it('el DDL solo genera las tablas, no los productos, las APIs ni los glosarios', () => {
    const d = withColumns();
    const { text } = toDdl(d);
    expect(text).toContain('T1');
    expect(text).not.toMatch(/Producto con columnas|API con columnas|Glosario con columnas/);
    // tampoco cuando se pide por el activo: un contenedor genera sus tablas
    expect(toDdl(d, { assetId: 'db' }).text).not.toMatch(/Producto con columnas/);
  });

  describe('DDL de un producto, una API o un glosario (--asset)', () => {
    /** Nombres físicos de las tablas del script, en orden. */
    const tables = (d: DataDocument, assetId: string): string[] => [...toDdl(d, { assetId }).text.matchAll(/^CREATE TABLE (\S+) \(/gm)].map((m) => m[1]);

    it('una API de datos genera las tablas de lo que expone', () => {
      expect(tables(doc, 'api-ventas')).toEqual(['fact_ventas']);
    });

    it('un producto de datos genera las de sus puertos de entrada y de salida; los que no son tablas no añaden nada', () => {
      // Entrada: silver-ventas; salidas: dwh-fact-ventas, dwh-dim-cliente y api-ventas (que no tiene tablas propias: se sustituye por lo que expone).
      expect(tables(doc, 'ventas-360')).toEqual(['plata_ventas', 'dim_cliente', 'fact_ventas']);
      // Salida: un modelo sin columnas.
      expect(tables(doc, 'analitica-fuga')).toEqual(['dim_cliente', 'fact_ventas']);
      expect(toDdl(doc, { assetId: 'analitica-fuga' }).warnings).toEqual([expect.stringMatching(/^Sin motor declarado/)]);
    });

    it('un glosario genera las de los activos con términos enlazados, sean a una columna o a todo el activo', () => {
      expect(tables(doc, 'glosario-ventas')).toEqual(['clientes', 'pedidos', 'dim_cliente', 'fact_ventas']);
      // Solo cuentan los términos de ese glosario.
      const otro = parse({ ...doc, assets: [...doc.assets, { id: 'g2', kind: 'glossary', name: 'Otro' }], terms: [...(doc.terms ?? []), { id: 'x', name: 'X', glossaryId: 'g2', links: [{ assetId: 'erp-lineas' }] }] });
      expect(tables(otro, 'g2')).toEqual(['lineas_de_pedido']);
      expect(tables(otro, 'glosario-ventas')).toEqual(['clientes', 'pedidos', 'dim_cliente', 'fact_ventas']);
    });

    it('el activo de un puerto que es un contenedor aporta todas sus tablas, cada una en el dialecto de su motor', () => {
      const d = parse({ ...ventas, assets: [...ventas.assets, { id: 'p', kind: 'data-product', name: 'P', owner: 'x', inputPorts: ['erp'], outputPorts: ['dwh-fact-ventas'] }] });
      expect(tables(d, 'p')).toEqual(['pedidos', 'lineas_de_pedido', 'fact_ventas']);
      const { text } = toDdl(d, { assetId: 'p' });
      expect(text).toMatch(/^-- PostgreSQL\n/);
      expect(text).toContain('-- Snowflake\n');
    });

    it('los productos, las APIs y los glosarios no generan tabla propia aunque declaren columnas', () => {
      const d = withColumns();
      for (const id of ['p', 'a', 'g']) expect(toDdl(d, { assetId: id }).text).not.toMatch(/Producto con columnas|API con columnas|Glosario con columnas/);
      expect(tables(d, 'p')).toEqual(['T1']);
      expect(tables(d, 'a')).toEqual(['T1']);
      expect(tables(d, 'g')).toEqual([]);
    });

    it('un producto y una API que se enlazan entre sí no cuelgan el recorrido', () => {
      const d = parse({
        ...doc,
        assets: doc.assets.map((a) => (a.id === 'api-ventas' ? { ...a, exposes: ['dwh-fact-ventas', 'ventas-360'] } : a)),
      });
      expect(tables(d, 'api-ventas')).toEqual(['plata_ventas', 'dim_cliente', 'fact_ventas']);
      expect(tables(d, 'ventas-360')).toEqual(['plata_ventas', 'dim_cliente', 'fact_ventas']);
    });

    it('sin tablas a las que llegar, avisa de qué activo no las tiene', () => {
      const vacio = parse({ assets: [{ id: 'p', kind: 'data-product', name: 'P' }, { id: 'a', kind: 'data-api', name: 'A' }, { id: 'g', kind: 'glossary', name: 'G' }, { id: 'r', kind: 'report', name: 'R' }] , terms: [{ id: 't', name: 'T', glossaryId: 'g', links: [{ assetId: 'r' }] }] });
      expect(toDdl(vacio, { assetId: 'p' }).warnings).toEqual(['«P» no tiene tablas con columnas: ninguno de los activos de sus puertos de entrada y de salida las tiene.']);
      expect(toDdl(vacio, { assetId: 'a' }).warnings).toEqual(['«A» no tiene tablas con columnas: ninguno de los activos que expone las tiene.']);
      expect(toDdl(vacio, { assetId: 'g' }).warnings).toEqual(['«G» no tiene tablas con columnas: ninguno de los activos enlazados desde sus términos las tiene.']);
      expect(toDdl(vacio, { assetId: 'p' }).text).toBe('');
    });

    it('un contenedor y una tabla siguen filtrando como antes y un id que no existe da el error con todos los activos, los del catálogo incluidos', () => {
      expect(tables(doc, 'erp')).toEqual(['pedidos', 'lineas_de_pedido']);
      expect(tables(doc, 'erp-pedidos')).toEqual(['pedidos']);
      expect(() => toDdl(doc, { assetId: 'nada' })).toThrow(/No existe el activo «nada»\. Activos: crm, .*ventas-360, analitica-fuga, api-ventas, glosario-ventas\./);
    });

    it('iark data ddl --asset lo usa y la ayuda lo documenta', () => {
      const command = dataCommands.find((c) => c.name === 'ddl')!;
      const out = command.run({ args: [], options: { asset: 'glosario-ventas' }, input: raw, warn: () => undefined }) as string;
      expect(out).toContain('CREATE TABLE dim_cliente (');
      expect(out).not.toContain('CREATE TABLE lineas_de_pedido (');
      const help = command.options!.find((o) => o.flags.startsWith('--asset'))!.description;
      expect(help).toContain('con un producto de datos, las de los activos de sus puertos de entrada y de salida');
      expect(help).toContain('con una API de datos, las de los activos que expone');
      expect(help).toContain('con un glosario, las de los activos con términos enlazados');
    });
  });

  it('un contrato de un producto o una API declara su motor como el de cualquier activo', () => {
    const d = parse({
      ...base(),
      assets: [...base().assets, { id: 'a', kind: 'data-api', name: 'API', owner: 'E', exposes: ['t1'], contractId: 'c', engine: 'postgresql' }],
      contracts: [{ id: 'c', name: 'Contrato', format: 'odcs', content: 'kind: DataContract\napiVersion: v3.0.2\nid: c\nstatus: active\nschema:\n  - name: ventas\n    properties:\n      - name: id\n        logicalType: integer\n' }],
    });
    expect(analyzeData(d).filter((i) => i.elementId === 'a' && i.message.includes('contrato'))).toEqual([]);
    expect(toDdl(d, { contractId: 'c' }).text).toContain('ventas');
  });

  it('el generado por IA conserva las multiplicidades de las relaciones junto a los términos', () => {
    const d = parse({ ...withColumns(), terms: [{ id: 'x', name: 'X', links: [{ assetId: 't1', column: 'id' }] }] });
    const back = generatedToData(toGenerated(d));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.document.relations[0]).toMatchObject({ sourceMin: 0, targetMin: 1 });
    expect(back.document.terms).toEqual(d.terms);
  });
});

describe('catálogo: enlaces', () => {
  it('el id de un enlace es estable: tipo, origen y destino, con sufijo desde el segundo del mismo par', () => {
    expect(linkId('publishes', 'p', 't')).toBe('publishes:p>t');
    expect(linkId('defines', 'x', 'a', 1)).toBe('defines:x>a');
    expect(linkId('defines', 'x', 'a', 2)).toBe('defines:x>a#2');
  });

  it('un puerto, una exposición o un enlace a un activo que no existe se omite', () => {
    const d: DataDocument = { ...base(), assets: [...base().assets, { id: 'p', kind: 'data-product', name: 'P', outputPorts: ['fantasma', 't1'] }], terms: [{ id: 'x', name: 'X', links: [{ assetId: 'fantasma' }, { assetId: 't2', column: 'c' }, { assetId: 't2' }] }] };
    expect(listLinks(d).map((l) => l.id)).toEqual(['publishes:p>t1', 'defines:x>t2', 'defines:x>t2#2']);
  });
});
