import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type { Box, EdgeRoute, GraphLayout } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { enterpriseEditor } from './editor';
import { fromMermaid } from './import/fromMermaid';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutValueStreams, toSvg, type RenderedEdge } from './export/render';
import { refineOrder } from './export/valueStreamRoutes';
import { dependencyGraph, reach, stageCapabilities, streamStages } from './graph';
import { analyzeEnterprise } from './issues';
import { enterpriseJsonSchema, validateEnterpriseDocument } from './schema';
import { drawnEnds, type EnterpriseDocument } from './types';
import { findView, listViews, traceView, viewRefs } from './views';

const parse = (input: unknown): EnterpriseDocument => {
  const r = validateEnterpriseDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};
const doc = parse(JSON.parse(readFileSync('examples/empresa-flujo-de-valor.json', 'utf8')));
const messages = (d: EnterpriseDocument): string[] => analyzeEnterprise(d, { today: new Date('2026-06-15T00:00:00Z') }).map((i) => i.message);
const edit = (result: ReturnType<typeof enterpriseEditor.addNode>): EnterpriseDocument => {
  if (!result.ok) throw new Error(result.reason);
  return result.document as EnterpriseDocument;
};

describe('flujos de valor y servicios de negocio: modelo', () => {
  it('son opcionales: un documento de la versión 1.0 sin ellos sigue siendo válido', () => {
    const bare = parse({ version: '1.0', workspace: { name: 'x' }, capabilities: [{ id: 'a', name: 'A' }] });
    expect(bare.valueStreams).toEqual([]);
    expect(bare.valueStages).toEqual([]);
    expect(bare.businessServices).toEqual([]);
    expect(listViews(bare).some((v) => v.type === 'value-stream')).toBe(false);
    const schema = enterpriseJsonSchema() as { required?: string[] };
    expect(schema.required ?? []).not.toContain('valueStreams');
  });

  it('valida etapas (flujo existente), ids únicos entre tipos y las relaciones enables y exposes', () => {
    const base = {
      capabilities: [{ id: 'cap', name: 'Cap' }],
      processes: [{ id: 'p', name: 'P' }],
      valueStreams: [{ id: 'f', name: 'F' }],
      valueStages: [{ id: 'e', name: 'E', streamId: 'f' }],
      businessServices: [{ id: 's', name: 'S' }],
    };
    expect(validateEnterpriseDocument({ ...base, relations: [{ id: 'r1', kind: 'enables', sourceId: 'cap', targetId: 'e' }, { id: 'r2', kind: 'exposes', sourceId: 's', targetId: 'p' }, { id: 'r3', kind: 'exposes', sourceId: 's', targetId: 'cap' }] }).ok).toBe(true);
    const failures = (d: unknown): string => JSON.stringify((validateEnterpriseDocument(d) as { issues?: unknown }).issues ?? []);
    expect(failures({ ...base, valueStages: [{ id: 'e', name: 'E', streamId: 'nope' }] })).toContain('flujo de valor inexistente');
    expect(failures({ ...base, valueStages: [{ id: 'e', name: 'E', streamId: 'cap' }] })).toContain('debe ser un flujo de valor');
    expect(failures({ ...base, businessServices: [{ id: 'cap', name: 'S' }] })).toContain('Id duplicado');
    expect(failures({ ...base, relations: [{ id: 'r', kind: 'enables', sourceId: 'e', targetId: 'cap' }] })).toContain('no puede unir');
    expect(failures({ ...base, relations: [{ id: 'r', kind: 'exposes', sourceId: 'p', targetId: 's' }] })).toContain('solo admite');
    expect(failures({ ...base, valueStreams: [{ id: 'f', name: 'F', ownerId: 'cap' }] })).toContain('debe ser una unidad');
  });

  it('el ejemplo trae un flujo con cinco etapas en orden y capacidades que las habilitan', () => {
    const stages = streamStages(doc).get('pedido-a-entrega')!;
    expect(stages.map((s) => s.id)).toEqual(['descubrir', 'pedir', 'preparar', 'entregar', 'posventa']);
    expect(stageCapabilities(doc).get('pedir')!.map((c) => c.id).sort()).toEqual(['cobros', 'gestion-pedidos']);
    expect(messages(doc)).toEqual([]);
  });

  it('una etapa depende de las capacidades que la habilitan y un servicio de lo que expone (impacto)', () => {
    const graph = dependencyGraph(doc);
    expect(graph.leansOn.get('pedir')).toEqual(expect.arrayContaining(['gestion-pedidos', 'cobros']));
    const impacted = reach(graph, 'gestion-pedidos', 'dependents').map((s) => s.id);
    expect(impacted).toContain('pedir');
    expect(reach(graph, 'distribucion', 'dependents').map((s) => s.id)).toContain('envio-a-domicilio');
    expect(traceView(doc, 'pedir', 'depends').elementIds).toContain('gestion-pedidos');
    expect(() => traceView(doc, 'pedido-a-entrega')).toThrow();
  });
});

describe('flujos de valor: reglas de gobierno', () => {
  it('avisa de etapas sin capacidad, flujos sin etapas y servicios que no exponen nada', () => {
    const next: EnterpriseDocument = {
      ...doc,
      valueStreams: [...doc.valueStreams, { id: 'vacio', name: 'Flujo vacío' }],
      valueStages: [...doc.valueStages, { id: 'huerfana', name: 'Etapa huérfana', streamId: 'pedido-a-entrega' }],
      businessServices: [...doc.businessServices, { id: 'ocioso', name: 'Servicio ocioso' }],
    };
    const found = analyzeEnterprise(next, { today: new Date('2026-06-15T00:00:00Z') });
    expect(found.find((i) => i.elementId === 'huerfana')).toMatchObject({ severity: 'warning', message: expect.stringContaining('no está habilitada por ninguna capacidad') });
    expect(found.find((i) => i.elementId === 'vacio')?.message).toContain('no tiene etapas');
    expect(found.find((i) => i.elementId === 'ocioso')?.message).toContain('no expone ningún proceso ni capacidad');
  });
});

describe('flujos de valor: vistas', () => {
  it('la vista value-stream existe solo con flujos, tras el mapa de capacidades, y reúne flujos, etapas y capacidades', () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id).slice(0, 3)).toEqual(['capabilities', 'value-stream', 'landscape']);
    const view = findView(doc, 'value-stream');
    expect(view.type).toBe('value-stream');
    expect(view.elementIds).toEqual(expect.arrayContaining(['pedido-a-entrega', 'descubrir', 'posventa', 'cobros', 'atencion-cliente']));
    expect(view.elementIds).not.toContain('compras');
    expect(view.relationIds).toHaveLength(7);
    expect(viewRefs(doc).some((v) => v.id === 'value-stream')).toBe(true);
  });

  it('el paisaje incluye los servicios y las etapas habilitadas; las etapas sueltas solo salen en la vista del flujo', () => {
    const landscape = findView(doc, 'landscape');
    expect(landscape.elementIds).toEqual(expect.arrayContaining(['compra-online', 'pedir']));
    expect(landscape.elementIds).not.toContain('pedido-a-entrega');
    const loose: EnterpriseDocument = { ...doc, valueStages: [...doc.valueStages, { id: 'suelta', name: 'Suelta', streamId: 'pedido-a-entrega' }] };
    expect(findView(loose, 'landscape').elementIds).not.toContain('suelta');
    expect(findView(loose, 'value-stream').elementIds).toContain('suelta');
  });

  it('el flujo de una unidad incluye sus etapas por el responsable del flujo', () => {
    expect(findView(doc, 'unit:operaciones').elementIds).toEqual(expect.arrayContaining(['pedir', 'envio-a-domicilio']));
  });

  it('la colocación pone las etapas en cadena (misma fila, de izquierda a derecha) con sus capacidades debajo y sin solapes', () => {
    const { layout, titles, edges } = layoutValueStreams(doc);
    const stages = ['descubrir', 'pedir', 'preparar', 'entregar', 'posventa'].map((id) => layout.nodes.find((n) => n.id === id)!);
    expect(new Set(stages.map((s) => s.y)).size).toBe(1);
    for (let i = 1; i < stages.length; i += 1) expect(stages[i].x).toBeGreaterThanOrEqual(stages[i - 1].x + stages[i - 1].width);
    const stream = layout.groups.find((g) => g.id === 'pedido-a-entrega')!;
    expect(titles.get('pedido-a-entrega')).toBe('Del pedido a la entrega');
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(stream.x);
      expect(n.x + n.width).toBeLessThanOrEqual(stream.x + stream.width);
      expect(n.y + n.height).toBeLessThanOrEqual(stream.y + stream.height);
    }
    const caps = layout.nodes.filter((n) => !stages.includes(n));
    expect(caps.length).toBe(7);
    for (const c of caps) expect(c.y).toBeGreaterThan(stages[0].y + stages[0].height);
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const [a, b] = [layout.nodes[i], layout.nodes[j]];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
    expect(layout.edges).toHaveLength(7);
    expect(edges.get('cobros--enables--pedir')).toMatchObject({ source: 'pedir', target: 'cobros' });
  });

  it('un flujo sin etapas se dibuja como nodo suelto y no rompe el SVG', async () => {
    const next: EnterpriseDocument = { ...doc, valueStreams: [...doc.valueStreams, { id: 'vacio', name: 'Flujo vacío' }] };
    expect(layoutValueStreams(next).layout.nodes.some((n) => n.id === 'vacio')).toBe(true);
    expect(await toSvg(next, 'value-stream')).toContain('Flujo vacío');
  });
});

describe('flujos de valor: exportación', () => {
  it('SVG: chevrones en cadena dentro del recuadro del flujo, con el color de la capa de negocio', async () => {
    const svg = await toSvg(doc, 'value-stream');
    expect(svg).toContain('Del pedido a la entrega');
    expect(svg).toContain('Pedir y pagar');
    expect(svg).toContain('pedido confirmado');
    expect(svg).toContain('#ffd43b'); // relleno de las etapas
    expect(svg).toContain('Gestión de pedidos');
    expect((svg.match(/<svg/g) ?? []).length).toBe(1);
  });

  it('SVG: el servicio de negocio se dibuja con su audiencia en el paisaje', async () => {
    const svg = await toSvg(doc, 'landscape');
    expect(svg).toContain('Compra online');
    expect(svg).toContain('Clientes particulares');
    expect(svg).toContain('SERVICIO DE NEGOCIO');
  });

  it('Mermaid: un subgraph por flujo con las etapas unidas en orden y sus capacidades', () => {
    const text = toMermaid(doc, { viewId: 'value-stream' });
    expect(text).toContain('flowchart LR');
    expect(text).toContain('subgraph pedido_a_entrega["Del pedido a la entrega"]');
    expect(text).toContain('descubrir ==> pedir');
    expect(text).toContain('entregar ==> posventa');
    expect(text).toContain('pedir -.-> cobros');
    expect(text).toContain(':::stage');
    expect(toMermaid(doc, { viewId: 'landscape' })).toContain(':::service');
  });

  it('draw.io: una página para los flujos con etapas como chevrones y capacidades enlazadas', async () => {
    const xml = await toDrawio(doc);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml);
    const pages = [parsed.mxfile.diagram].flat();
    const page = pages.find((p: { '@_id': string }) => p['@_id'] === 'value-stream');
    expect(page).toBeDefined();
    expect(xml).toContain('id="n-pedir"');
    expect(xml).toContain('source="n-pedir" target="n-cobros"');
  });
});

describe('flujos de valor: editor', () => {
  it('la paleta ofrece flujo, etapa y servicio, y las relaciones enables y exposes con sus reglas', () => {
    const kinds = new Map(enterpriseEditor.nodeKinds.map((k) => [k.kind, k]));
    expect(kinds.get('stage')).toMatchObject({ shape: 'chevron', fill: '#ffd43b' });
    expect(kinds.get('service')).toMatchObject({ shape: 'pill' });
    expect(kinds.get('stream')?.label).toBe('Flujo de valor');
    for (const k of ['stream', 'stage', 'service']) expect(kinds.get(k)?.icon?.length).toBeGreaterThan(0);
    expect(enterpriseEditor.edgeKinds.map((k) => k.kind)).toEqual(expect.arrayContaining(['enables', 'exposes']));
    // En cualquier sentido del arrastre, el origen del modelo es la capacidad (enables) o el servicio (exposes).
    expect(enterpriseEditor.canConnect!(doc, 'enables', 'pedir', 'compras')).toBeUndefined();
    expect(enterpriseEditor.canConnect!(doc, 'enables', 'compras', 'pedir')).toBeUndefined();
    expect(enterpriseEditor.canConnect!(doc, 'enables', 'gestion-pedidos', 'pedir')).toMatch(/ya existe/);
    expect(enterpriseEditor.canConnect!(doc, 'enables', 'tienda-web', 'pedir')).toMatch(/capacidad → etapa/);
    expect(enterpriseEditor.canConnect!(doc, 'exposes', 'precios-promociones', 'envio-a-domicilio')).toBeUndefined();
    const added = edit(enterpriseEditor.addEdge(doc, 'enables', 'pedir', 'compras'));
    expect(added.relations.at(-1)).toMatchObject({ kind: 'enables', sourceId: 'compras', targetId: 'pedir' });
    expect(validateEnterpriseDocument(added).ok).toBe(true);
  });

  it('proyecta los flujos como grupos con sus etapas y las capacidades enlazadas, con la colocación propia', () => {
    const g = enterpriseEditor.project(doc, 'value-stream');
    expect(g.nodes.find((n) => n.id === 'pedido-a-entrega')).toMatchObject({ kind: 'stream', stroke: '#a07800' });
    expect(g.nodes.find((n) => n.id === 'pedir')).toMatchObject({ kind: 'stage', parentId: 'pedido-a-entrega', sublabel: 'pedido confirmado' });
    expect(g.nodes.find((n) => n.id === 'cobros')).toMatchObject({ kind: 'capability' });
    expect(g.nodes.find((n) => n.id === 'cobros')?.parentId).toBeUndefined();
    expect(g.edges.find((e) => e.id === 'cobros--enables--pedir')).toMatchObject({ kind: 'enables', source: 'pedir', target: 'cobros' });
    const layout = enterpriseEditor.layout!(doc, 'value-stream');
    expect(layout && !(layout instanceof Promise) && layout.groups.some((b) => b.id === 'pedido-a-entrega')).toBe(true);
  });

  it('crea etapas en el flujo seleccionado, tras la etapa seleccionada o creando el primer flujo', () => {
    const empty: EnterpriseDocument = { ...doc, valueStreams: [], valueStages: [], relations: doc.relations.filter((r) => r.kind !== 'enables') };
    const first = edit(enterpriseEditor.addNode(empty, 'stage', 'Cotizar'));
    expect(first.valueStreams).toHaveLength(1);
    expect(first.valueStages[0]).toMatchObject({ id: 'cotizar', streamId: first.valueStreams[0].id });
    expect(validateEnterpriseDocument(first).ok).toBe(true);

    const end = edit(enterpriseEditor.addNode(doc, 'stage', 'Cierre', 'pedido-a-entrega'));
    expect(streamStages(end).get('pedido-a-entrega')!.map((s) => s.id).at(-1)).toBe('cierre');
    const middle = edit(enterpriseEditor.addNode(doc, 'stage', 'Verificar', 'pedir'));
    expect(streamStages(middle).get('pedido-a-entrega')!.map((s) => s.id)).toEqual(['descubrir', 'pedir', 'verificar', 'preparar', 'entregar', 'posventa']);

    const stream = edit(enterpriseEditor.addNode(doc, 'stream', 'Del lead al cliente'));
    expect(stream.valueStreams.at(-1)).toMatchObject({ id: 'del-lead-al-cliente' });
    const service = edit(enterpriseEditor.addNode(doc, 'service', 'Recogida en tienda'));
    expect(service.businessServices.at(-1)).toMatchObject({ id: 'recogida-en-tienda' });
    expect(validateEnterpriseDocument(service).ok).toBe(true);
  });

  it('edita etapas, flujos y servicios (el flujo de una etapa tiene que ser un flujo) y los lee para el formulario', () => {
    const fields = (kind: string): string[] => enterpriseEditor.fields({ type: 'node', kind }, doc).map((f) => f.key);
    expect(fields('stage')).toEqual(expect.arrayContaining(['name', 'streamId', 'value']));
    expect(fields('stream')).toEqual(expect.arrayContaining(['ownerId', 'stakeholder']));
    expect(fields('service')).toEqual(expect.arrayContaining(['ownerId', 'audience']));
    expect(enterpriseEditor.read(doc, 'pedir')).toMatchObject({ type: 'node', kind: 'stage', values: { value: 'pedido confirmado' } });
    const renamed = edit(enterpriseEditor.update(doc, 'pedir', { name: 'Pedir', value: '' }));
    expect(renamed.valueStages.find((s) => s.id === 'pedir')).toEqual({ id: 'pedir', name: 'Pedir', streamId: 'pedido-a-entrega' });
    expect(enterpriseEditor.update(doc, 'pedir', { streamId: 'cobros' })).toMatchObject({ ok: false });
    const audience = edit(enterpriseEditor.update(doc, 'compra-online', { audience: 'Empresas' }));
    expect(audience.businessServices.find((s) => s.id === 'compra-online')?.audience).toBe('Empresas');
  });

  it('«Etapa ◂» y «Etapa ▸» reordenan dentro del flujo y avisan en los extremos', () => {
    const earlier = enterpriseEditor.actions!.find((a) => a.id === 'stage-earlier')!;
    const later = enterpriseEditor.actions!.find((a) => a.id === 'stage-later')!;
    const moved = earlier.run(doc, ['pedir']);
    if (!moved.ok) throw new Error(moved.reason);
    expect(streamStages(moved.document).get('pedido-a-entrega')!.map((s) => s.id).slice(0, 3)).toEqual(['pedir', 'descubrir', 'preparar']);
    const back = later.run(moved.document, ['pedir']);
    if (!back.ok) throw new Error(back.reason);
    expect(streamStages(back.document).get('pedido-a-entrega')!.map((s) => s.id)).toEqual(['descubrir', 'pedir', 'preparar', 'entregar', 'posventa']);
    expect(earlier.disabled!(doc, ['descubrir'])).toMatch(/primera/);
    expect(later.disabled!(doc, ['posventa'])).toMatch(/última/);
    expect(earlier.disabled!(doc, ['pedir'])).toBeUndefined();
    expect(earlier.disabled!(doc, ['compras'])).toMatch(/etapa/);
    expect(earlier.run(doc, ['descubrir'])).toMatchObject({ ok: false });
  });

  it('borrar un flujo borra sus etapas y las relaciones de estas; borrar una unidad deja libres sus flujos y servicios', () => {
    const removed = enterpriseEditor.remove(doc, 'pedido-a-entrega');
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.document.valueStages).toEqual([]);
    expect(removed.document.relations.some((r) => r.kind === 'enables')).toBe(false);
    expect(validateEnterpriseDocument(removed.document).ok).toBe(true);
    const unit = enterpriseEditor.remove(doc, 'logistica');
    if (!unit.ok) throw new Error(unit.reason);
    const owner = enterpriseEditor.remove(doc, 'operaciones');
    if (!owner.ok) throw new Error(owner.reason);
    expect(owner.document.valueStreams[0]).not.toHaveProperty('ownerId');
    expect(unit.document.businessServices.find((s) => s.id === 'envio-a-domicilio')?.ownerId).toBeUndefined();
    expect(validateEnterpriseDocument(unit.document).ok).toBe(true);
  });

  it('«Agrupar por unidad» da responsable a flujos y servicios y no toca las etapas', () => {
    const action = enterpriseEditor.actions!.find((a) => a.id === 'group-by-unit')!;
    const out = action.run(doc, ['pedido-a-entrega', 'compra-online', 'pedir'], 'Finanzas');
    if (!out.ok) throw new Error(out.reason);
    expect(out.document.valueStreams[0].ownerId).toBe('finanzas');
    expect(out.document.businessServices.find((s) => s.id === 'compra-online')?.ownerId).toBe('finanzas');
    expect(out.document.valueStages.find((s) => s.id === 'pedir')).not.toHaveProperty('ownerId');
  });
});

describe('unidad dibujable: arista hacia una unidad que no se ve en la vista', () => {
  it('el paisaje del lienzo dibuja todas las unidades (también las que solo son responsables) y se les puede arrastrar una asignación', () => {
    const g = enterpriseEditor.project(doc, 'landscape');
    for (const u of doc.units) expect(g.nodes.find((n) => n.id === u.id)).toMatchObject({ kind: 'unit' });
    // Una unidad responsable de elementos no se dibuja en el SVG (solo las que participan en una relación)…
    expect(findView(doc, 'landscape').elementIds).not.toContain('plataforma');
    // …pero en el lienzo se puede arrastrar «alta de pedido → Equipo Plataforma» y crea la asignación (origen del modelo: la unidad).
    const linked = edit(enterpriseEditor.addEdge(doc, 'assigned-to', 'alta-pedido', 'plataforma'));
    expect(linked.relations.at(-1)).toMatchObject({ kind: 'assigned-to', sourceId: 'plataforma', targetId: 'alta-pedido' });
    expect(enterpriseEditor.project(linked, 'landscape').edges.some((e) => e.source === 'plataforma' && e.target === 'alta-pedido')).toBe(true);
    // Los demás tipos de vista conservan su contenido.
    expect(enterpriseEditor.project(doc, 'capabilities').nodes.some((n) => n.kind === 'unit')).toBe(false);
  });
});

describe('flujos de valor: importación desde Mermaid', () => {
  it('ida y vuelta de la vista de flujos: el flujo, sus etapas en orden, su valor y las capacidades que las habilitan', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'value-stream' }));
    expect(warnings).toEqual([]);
    expect(document.valueStreams).toEqual([{ id: 'pedido-a-entrega', name: 'Del pedido a la entrega' }]);
    expect(document.valueStages.map((s) => [s.id, s.streamId, s.value])).toEqual(doc.valueStages.map((s) => [s.id, s.streamId, s.value]));
    const signature = (r: { kind: string; sourceId: string; targetId: string }): string => `${r.kind}|${r.sourceId}|${r.targetId}`;
    expect(document.relations.map(signature).sort()).toEqual(doc.relations.filter((r) => r.kind === 'enables').map(signature).sort());
    expect(document.capabilities.map((c) => c.id).sort()).toEqual([...new Set(doc.relations.filter((r) => r.kind === 'enables').map((r) => r.sourceId))].sort());
  });

  it('ida y vuelta del paisaje con servicios: audiencia y relaciones exposes; las etapas van a un flujo por defecto', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'landscape' }));
    expect(warnings).toEqual([]);
    expect(document.businessServices.map((s) => [s.id, s.audience])).toEqual([['compra-online', 'Clientes particulares'], ['envio-a-domicilio', 'Clientes particulares']]);
    expect(document.relations.filter((r) => r.kind === 'exposes')).toHaveLength(3);
    expect(document.valueStreams).toHaveLength(1);
    expect(document.valueStages.map((s) => s.id).sort()).toEqual([...doc.valueStages.map((s) => s.id)].sort());
  });
});

// --- Colocación sin cruces ---------------------------------------------------------------------------------------------

type Point = { x: number; y: number };
type Meeting = 'none' | 'cross' | 'touch' | 'overlap';
type Ends = Map<string, { source: string; target: string }>;

const turn = (a: Point, b: Point, c: Point): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const between = (a: Point, b: Point, p: Point): boolean => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);

/** Cómo se encuentran dos tramos: se cruzan en un punto interior a los dos, se tocan en un punto o comparten un trozo de línea. */
function meeting(a1: Point, a2: Point, b1: Point, b2: Point): Meeting {
  const [o1, o2, o3, o4] = [turn(a1, a2, b1), turn(a1, a2, b2), turn(b1, b2, a1), turn(b1, b2, a2)];
  if (o1 * o2 < 0 && o3 * o4 < 0) return 'cross';
  if (o1 === 0 && o2 === 0) {
    const axis = a1.x !== a2.x || b1.x !== b2.x ? 'x' : 'y';
    const [a0, a9] = [a1[axis], a2[axis]].sort((m, n) => m - n);
    const [b0, b9] = [b1[axis], b2[axis]].sort((m, n) => m - n);
    const [from, to] = [Math.max(a0, b0), Math.min(a9, b9)];
    return from < to ? 'overlap' : from === to ? 'touch' : 'none';
  }
  const touching = (o1 === 0 && between(a1, a2, b1)) || (o2 === 0 && between(a1, a2, b2)) || (o3 === 0 && between(b1, b2, a1)) || (o4 === 0 && between(b1, b2, a2));
  return touching ? 'touch' : 'none';
}

/**
 * Cruces de una colocación: pares de tramos de dos aristas distintas que se cortan. Dos aristas que comparten extremo (salen
 * de la misma etapa o llegan a la misma capacidad) pueden compartir el tramo vertical, así que entre ellas solo cuenta el
 * corte limpio; entre las demás cuenta también que una toque a otra o se monte sobre ella.
 */
function edgeCrossings(routes: EdgeRoute[], ends: Ends): number {
  let count = 0;
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const [a, b] = [ends.get(routes[i].id)!, ends.get(routes[j].id)!];
      const shared = a.source === b.source || a.target === b.target || a.source === b.target || a.target === b.source;
      for (let s = 1; s < routes[i].points.length; s += 1) {
        for (let t = 1; t < routes[j].points.length; t += 1) {
          const m = meeting(routes[i].points[s - 1], routes[i].points[s], routes[j].points[t - 1], routes[j].points[t]);
          if (m === 'cross' || (m !== 'none' && !shared)) count += 1;
        }
      }
    }
  }
  return count;
}

const crossingsOf = (d: EnterpriseDocument): number => {
  const { layout, edges } = layoutValueStreams(d);
  return edgeCrossings(layout.edges, edges);
};

/** El rótulo de un recuadro ocupa su esquina superior izquierda: hasta 28 px de alto y, a 6,2 px por carácter de «❯ Flujo de valor: nombre», hasta donde llegue. */
const LABEL_BOTTOM = 28;
const labelBox = (group: Box, name: string): Box => ({ id: `rótulo:${group.id}`, x: group.x + 12, y: group.y + 4, width: Math.ceil((name.length + 18) * 6.2), height: LABEL_BOTTOM - 4 });

/** ¿Pasa el tramo (horizontal o vertical) por el interior de la caja? Rozar su borde o acabar en él, como al llegar a un nodo, no cuenta. */
function crossesBox(a: Point, b: Point, box: Box): boolean {
  return Math.min(a.x, b.x) < box.x + box.width && Math.max(a.x, b.x) > box.x && Math.min(a.y, b.y) < box.y + box.height && Math.max(a.y, b.y) > box.y;
}

/** Tramos de las aristas que atraviesan un nodo o el rótulo de un recuadro, como «arista → nodo». */
function routeHits({ layout, titles }: { layout: GraphLayout; titles: Map<string, string> }): string[] {
  const obstacles = [...layout.nodes, ...layout.groups.map((g) => labelBox(g, titles.get(g.id) ?? ''))];
  const found: string[] = [];
  for (const route of layout.edges) {
    for (let i = 1; i < route.points.length; i += 1) {
      for (const box of obstacles) if (crossesBox(route.points[i - 1], route.points[i], box)) found.push(`${route.id} → ${box.id}`);
    }
  }
  return found;
}

/**
 * La colocación anterior, solo para comparar: cada capacidad bajo su primera etapa, en el orden de aparición y empujada a la
 * derecha si choca con la anterior, y cada arista con un codo a poca altura de la etapa (las que suben, en diagonal).
 */
function previousLayout(d: EnterpriseDocument): { routes: EdgeRoute[]; ends: Ends } {
  const [stageH, capH, stageGap, title, pad, gap] = [76, 72, 4, 38, 14, 14];
  const stages = streamStages(d);
  const enabling = stageCapabilities(d);
  const stageW = Math.min(260, Math.max(180, Math.ceil(Math.max(0, ...d.valueStages.map((x) => x.name.length)) * 7.2 + 56)));
  const capW = Math.max(160, stageW - 20);
  const placed = new Set<string>();
  const spots = new Map<string, Box>();
  let y = 0;
  for (const stream of d.valueStreams) {
    const list = stages.get(stream.id)!;
    if (list.length === 0) {
      y += stageH + gap * 2;
      continue;
    }
    list.forEach((stage, i) => spots.set(stage.id, { id: stage.id, x: pad + i * (stageW + stageGap), y: y + title, width: stageW, height: stageH }));
    const caps: Array<{ id: string; center: number }> = [];
    list.forEach((stage, i) => {
      for (const c of enabling.get(stage.id) ?? []) if (!placed.has(c.id) && !caps.some((k) => k.id === c.id)) caps.push({ id: c.id, center: pad + i * (stageW + stageGap) + stageW / 2 });
    });
    let next = pad;
    for (const c of caps) {
      const x = Math.max(next, c.center - capW / 2);
      spots.set(c.id, { id: c.id, x, y: y + title + stageH + 44, width: capW, height: capH });
      placed.add(c.id);
      next = x + capW + gap;
    }
    y += title + stageH + (caps.length > 0 ? 44 + capH : 0) + pad + gap * 2;
  }
  const routes: EdgeRoute[] = [];
  const ends: Ends = new Map();
  let lane = 0;
  for (const r of d.relations.filter((x) => x.kind === 'enables')) {
    const { from, to } = drawnEnds(r);
    const [a, b] = [spots.get(from), spots.get(to)];
    if (!a || !b) continue;
    const [ax, bx, mid] = [a.x + a.width / 2, b.x + b.width / 2, a.y + a.height + 8 + (lane++ % 4) * 5];
    routes.push({ id: r.id, points: b.y > a.y ? [{ x: ax, y: a.y + a.height }, { x: ax, y: mid }, { x: bx, y: mid }, { x: bx, y: b.y }] : [{ x: ax, y: a.y }, { x: bx, y: b.y + b.height }] });
    ends.set(r.id, { source: from, target: to });
  }
  return { routes, ends };
}

/** Flujos sintéticos: cada flujo es la lista de sus etapas y `enables`, las etapas que habilita cada capacidad (en el orden en que se declaran). */
function streamsDoc(streams: string[][], enables: Record<string, string[]>): EnterpriseDocument {
  return parse({
    version: '1.0',
    workspace: { name: 'Prueba' },
    capabilities: Object.keys(enables).map((id) => ({ id, name: id })),
    valueStreams: streams.map((_, i) => ({ id: `flujo-${i}`, name: `Flujo ${i}` })),
    valueStages: streams.flatMap((list, i) => list.map((id) => ({ id, name: id, streamId: `flujo-${i}` }))),
    relations: Object.entries(enables).flatMap(([cap, list]) => list.map((stage) => ({ id: `${cap}--enables--${stage}`, kind: 'enables', sourceId: cap, targetId: stage }))),
  });
}

/** Generador pseudoaleatorio con semilla (mulberry32): las pruebas son deterministas. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Entre 1 y `flows` flujos de 2 a 7 etapas; cada etapa tiene 1 o 2 capacidades, de las cuales un `share` de ellas (por defecto un 30 %) ya
 * las habilita otra etapa (en el mismo flujo o en otro). Con `empty`, ese porcentaje de los flujos no tiene etapas.
 */
function sharedCapabilities(next: () => number, { flows = 3, share = 0.3, empty = 0 }: { flows?: number; share?: number; empty?: number } = {}): EnterpriseDocument {
  const streams: string[][] = [];
  let stage = 0;
  for (let i = 0, n = 1 + Math.floor(next() * flows); i < n; i += 1) {
    streams.push(empty > 0 && next() < empty ? [] : Array.from({ length: 2 + Math.floor(next() * 6) }, () => `e${stage++}`));
  }
  const enables: Record<string, string[]> = {};
  const add = (cap: string, id: string): void => void (enables[cap] = [...new Set([...(enables[cap] ?? []), id])]);
  for (const id of streams.flat()) {
    for (let i = 0, n = 1 + Math.floor(next() * 1.8); i < n; i += 1) {
      const known = Object.keys(enables);
      add(known.length > 0 && next() < share ? known[Math.floor(next() * known.length)] : `c${known.length}`, id);
    }
  }
  return streamsDoc(streams, enables);
}

/** Cada capacidad habilita una sola etapa (de 0 a 3 por etapa), en 1 a 3 flujos. */
function exclusiveCapabilities(next: () => number): EnterpriseDocument {
  const streams: string[][] = [];
  let stage = 0;
  for (let i = 0, n = 1 + Math.floor(next() * 3); i < n; i += 1) streams.push(Array.from({ length: 1 + Math.floor(next() * 7) }, () => `e${stage++}`));
  const enables: Record<string, string[]> = {};
  for (const id of streams.flat()) for (let i = 0, n = Math.floor(next() * 4); i < n; i += 1) enables[`c${Object.keys(enables).length}`] = [id];
  return streamsDoc(streams, enables);
}

describe('flujos de valor: colocación sin cruces', () => {
  it('la métrica cuenta los cortes, los toques y los solapes, y deja que las aristas de un mismo extremo compartan tramo', () => {
    const route = (id: string, ...points: Array<[number, number]>): EdgeRoute => ({ id, points: points.map(([x, y]) => ({ x, y })) });
    const ends: Ends = new Map([['a', { source: 'e1', target: 'c1' }], ['b', { source: 'e2', target: 'c2' }], ['c', { source: 'e1', target: 'c3' }]]);
    expect(edgeCrossings([route('a', [0, 0], [0, 10], [100, 10]), route('b', [50, 0], [50, 30])], ends)).toBe(1); // el vertical de b corta el horizontal de a
    expect(edgeCrossings([route('a', [0, 0], [0, 10], [100, 10], [100, 30]), route('b', [50, 0], [50, 20], [150, 20], [150, 30])], ends)).toBe(2); // y el de a corta el de b
    expect(edgeCrossings([route('a', [0, 0], [0, 10], [40, 10], [40, 30]), route('b', [60, 0], [60, 10], [100, 10], [100, 30])], ends)).toBe(0);
    expect(edgeCrossings([route('a', [0, 0], [0, 10], [100, 10], [100, 30]), route('b', [50, 0], [50, 10], [150, 10], [150, 30])], ends)).toBeGreaterThan(0); // misma pista, se montan
    expect(edgeCrossings([route('a', [0, 0], [0, 20], [40, 20], [40, 30]), route('c', [0, 0], [0, 10], [80, 10], [80, 30])], ends)).toBe(0); // salen de la misma etapa: comparten el tramo de salida
    expect(edgeCrossings([route('a', [0, 0], [0, 10], [40, 10], [40, 30]), route('c', [0, 0], [0, 20], [80, 20], [80, 30])], ends)).toBe(1); // pero la más corta no puede girar encima de la larga
    expect(edgeCrossings([route('a', [0, 0], [0, 20], [-40, 20], [-40, 30]), route('b', [30, 0], [30, 10], [-40, 10], [-40, 30])], ends)).toBeGreaterThan(0); // no comparten extremo y se pisan
  });

  it('en el ejemplo ninguna arista se corta ni se monta sobre otra (la colocación anterior tenía varias)', () => {
    const { layout, edges } = layoutValueStreams(doc);
    expect(edgeCrossings(layout.edges, edges)).toBe(0);
    const before = previousLayout(doc);
    expect(edgeCrossings(before.routes, before.ends)).toBeGreaterThan(0);
  });

  it('las capacidades se ordenan por el baricentro de sus etapas y la compartida queda bajo el centro de ellas', () => {
    const d = streamsDoc([['e0', 'e1', 'e2', 'e3', 'e4']], { tercera: ['e3'], compartida: ['e0', 'e4'], segunda: ['e1'] });
    const { layout } = layoutValueStreams(d);
    const box = (id: string): Box => layout.nodes.find((n) => n.id === id)!;
    const centerX = (id: string): number => box(id).x + box(id).width / 2;
    expect(['segunda', 'compartida', 'tercera'].map((id) => box(id).x)).toEqual(['segunda', 'compartida', 'tercera'].map((id) => box(id).x).sort((a, b) => a - b));
    expect(centerX('compartida')).toBe(centerX('e2'));
    expect(centerX('segunda')).toBe(centerX('e1'));
    expect(centerX('tercera')).toBe(centerX('e3'));
    expect(crossingsOf(d)).toBeLessThanOrEqual(2);
  });

  it('en los empates conserva el orden de capacidades del documento', () => {
    const order = (names: string[]): string[] => {
      const d = streamsDoc([['e0', 'e1']], Object.fromEntries(names.map((n) => [n, ['e0']])));
      return layoutValueStreams(d).layout.nodes.filter((n) => names.includes(n.id)).sort((a, b) => a.x - b.x).map((n) => n.id);
    };
    expect(order(['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
    expect(order(['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
    // Dos capacidades con el mismo baricentro pero distintas etapas: manda el orden del documento.
    const tie = streamsDoc([['e0', 'e1', 'e2']], { y: ['e1'], x: ['e0', 'e2'] });
    expect(layoutValueStreams(tie).layout.nodes.filter((n) => n.id === 'x' || n.id === 'y').sort((a, b) => a.x - b.x).map((n) => n.id)).toEqual(['y', 'x']);
  });

  it('cada arista baja de la etapa a la capacidad con tramos horizontales y verticales, y cada flujo ocupa su recuadro', () => {
    const cases = [
      doc,
      streamsDoc([['e0', 'e1', 'e2', 'e3', 'e4', 'e5']], { a: ['e0'], b: ['e1'], c: ['e2'], crm: ['e0', 'e2'], clientes: ['e0', 'e3', 'e5'], d: ['e3'], e: ['e4'], f: ['e5'] }),
      streamsDoc([['p0', 'p1', 'p2'], [], ['q0', 'q1'], ['r0', 'r1', 'r2']], { pedidos: ['p0'], cobros: ['p1', 'r1'], envio: ['p2'], clientes: ['p0', 'r0', 'q0'], soloR: ['r2'] }),
    ];
    for (const d of cases) {
      const { layout, edges } = layoutValueStreams(d);
      const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
      expect(layout.edges).toHaveLength(d.relations.filter((r) => r.kind === 'enables').length);
      for (const route of layout.edges) {
        const { source, target } = edges.get(route.id)!;
        const [from, to] = [boxes.get(source)!, boxes.get(target)!];
        const up = to.y < from.y;
        const [first, last] = [route.points[0], route.points[route.points.length - 1]];
        // Sale por el centro del borde de la etapa y llega por el centro del borde de la capacidad.
        expect(first).toEqual({ x: from.x + from.width / 2, y: up ? from.y : from.y + from.height });
        expect(last).toEqual({ x: to.x + to.width / 2, y: up ? to.y + to.height : to.y });
        expect(route.sides).toEqual(up ? { source: 'top', target: 'bottom' } : { source: 'bottom', target: 'top' });
        for (let i = 1; i < route.points.length; i += 1) expect(route.points[i].x === route.points[i - 1].x || route.points[i].y === route.points[i - 1].y).toBe(true);
        // Las que bajan van rectas o con un codo; las que suben, rectas o con uno o más (por un pasillo libre): siempre un número par de puntos.
        expect(route.points.length === 2 ? first.x === last.x : up ? route.points.length % 2 === 0 : route.points.length === 4).toBe(true);
      }
      for (const group of layout.groups) {
        const members = d.valueStages.filter((s) => s.streamId === group.id).map((s) => boxes.get(s.id)!);
        for (const n of members) {
          expect(n.x).toBeGreaterThanOrEqual(group.x);
          expect(n.x + n.width).toBeLessThanOrEqual(group.x + group.width);
          expect(n.y).toBeGreaterThanOrEqual(group.y);
          expect(n.y + n.height).toBeLessThanOrEqual(group.y + group.height);
        }
      }
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          const [a, b] = [layout.nodes[i], layout.nodes[j]];
          expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
        }
      }
    }
  });

  it('con capacidades compartidas por etapas no contiguas no hay más cruces que con la colocación anterior', () => {
    const cases: Array<[string, EnterpriseDocument]> = [
      ['en los extremos', streamsDoc([['e0', 'e1', 'e2', 'e3', 'e4']], { a: ['e0'], b: ['e1'], c: ['e2'], d: ['e3'], e: ['e4'], comun: ['e0', 'e4'] })],
      ['una por etapa y dos transversales', streamsDoc([['e0', 'e1', 'e2', 'e3', 'e4', 'e5']], { captacion: ['e0'], scoring: ['e1'], precios: ['e2'], crm: ['e0', 'e2'], clientes: ['e0', 'e3', 'e5'], legal: ['e3'], onboarding: ['e4'], retencion: ['e5'] })],
      ['todas compartidas', streamsDoc([['e0', 'e1', 'e2']], { x: ['e0', 'e2'], y: ['e0', 'e1', 'e2'], z: ['e1', 'e2'] })],
      ['entre dos flujos', streamsDoc([['p0', 'p1', 'p2'], ['q0', 'q1', 'q2', 'q3']], { pedidos: ['p0'], cobros: ['p1', 'q1'], envio: ['p2', 'q3'], clientes: ['p0', 'q0', 'q2'], precios: ['q0'] })],
    ];
    for (const [name, d] of cases) {
      const before = previousLayout(d);
      expect(crossingsOf(d), name).toBeLessThanOrEqual(edgeCrossings(before.routes, before.ends));
    }
  });

  it('sin capacidades compartidas no hay ningún cruce, con uno o varios flujos', () => {
    const next = random(11);
    for (let i = 0; i < 150; i += 1) {
      const d = exclusiveCapabilities(next);
      if (d.capabilities.length > 0) expect(crossingsOf(d), JSON.stringify(d.relations.map((r) => r.id))).toBe(0);
    }
  });

  it('con capacidades compartidas nunca hay más cruces que con la colocación anterior (casos con semilla) y casi siempre hay menos', () => {
    const next = random(7);
    let fewer = 0;
    const total = 150;
    for (let i = 0; i < total; i += 1) {
      const d = sharedCapabilities(next);
      const before = previousLayout(d);
      const [now, was] = [crossingsOf(d), edgeCrossings(before.routes, before.ends)];
      expect(now, JSON.stringify(d.relations.map((r) => r.id))).toBeLessThanOrEqual(was);
      if (now < was) fewer += 1;
    }
    expect(fewer).toBeGreaterThan(total * 0.9);
  });

  it('el resultado es determinista: el mismo documento da la misma colocación, también por el editor', () => {
    const again = parse(JSON.parse(readFileSync('examples/empresa-flujo-de-valor.json', 'utf8')));
    const first = layoutValueStreams(doc);
    expect(layoutValueStreams(again)).toEqual(first);
    expect(JSON.stringify(layoutValueStreams(again))).toBe(JSON.stringify(first));
    expect(enterpriseEditor.layout!(again, 'value-stream')).toEqual(first.layout);
    const d = sharedCapabilities(random(3));
    expect(layoutValueStreams(d)).toEqual(layoutValueStreams(parse(JSON.parse(JSON.stringify(d)))));
  });

  it('varios flujos: la capacidad que ya dibuja un flujo anterior se queda donde estaba y las aristas de los flujos siguientes suben hasta ella', () => {
    const d = streamsDoc([['p0', 'p1'], [], ['q0', 'q1']], { pedidos: ['p0'], clientes: ['p1', 'q0'], propia: ['q1'] });
    const { layout } = layoutValueStreams(d);
    const box = (id: string): Box => layout.nodes.find((n) => n.id === id)!;
    const group = (id: string): Box => layout.groups.find((g) => g.id === id)!;
    expect(layout.nodes.some((n) => n.id === 'flujo-1')).toBe(true); // el flujo vacío es un nodo suelto
    expect(layout.nodes.filter((n) => n.id === 'clientes')).toHaveLength(1);
    expect(box('clientes').y).toBeLessThan(box('q0').y);
    expect(box('propia').y).toBeGreaterThan(box('q1').y);
    const up = layout.edges.find((e) => e.id === 'clientes--enables--q0')!;
    expect(up.sides).toEqual({ source: 'top', target: 'bottom' });
    // Sale de q0, que queda bajo el rótulo del flujo, así que gira bajo el rótulo hacia un pasillo a la derecha del flujo vacío, sube por él
    // y gira en el hueco que queda bajo el primer flujo para llegar a «clientes» por debajo.
    expect(up.points).toHaveLength(6);
    const [out, strip, aisle, lane] = [up.points[0], up.points[1], up.points[2], up.points[3]];
    expect(out).toEqual({ x: box('q0').x + box('q0').width / 2, y: box('q0').y });
    expect(strip.y).toBeGreaterThanOrEqual(group('flujo-2').y + LABEL_BOTTOM);
    expect(strip.y).toBeLessThan(box('q0').y);
    expect(aisle.x).toBeGreaterThan(box('flujo-1').x + box('flujo-1').width);
    expect(lane.y).toBeGreaterThanOrEqual(group('flujo-0').y + group('flujo-0').height);
    expect(lane.y).toBeLessThanOrEqual(box('flujo-1').y);
    expect(up.points[5]).toEqual({ x: box('clientes').x + box('clientes').width / 2, y: box('clientes').y + box('clientes').height });
    expect(crossingsOf(d)).toBe(0);
    expect(routeHits(layoutValueStreams(d))).toEqual([]);
  });
});

// --- Rutas de más de un codo -----------------------------------------------------------------------------------------------

const shared = parse(JSON.parse(readFileSync('tests/fixtures/empresa-flujos-compartidos.json', 'utf8')));
const SHARED_EDGE = 'gestion-clientes--enables--acompanar';

/** Entre 3 y 5 flujos, alguno sin etapas, con capacidades que habilitan etapas de varios flujos (muchas veces no adyacentes). */
const acrossFlows = (next: () => number): EnterpriseDocument => sharedCapabilities(next, { flows: 3, share: 0.35, empty: 0.15 });

describe('flujos de valor: rutas que suben por un pasillo libre', () => {
  it('la métrica de pisadas cuenta los tramos que atraviesan un nodo o un rótulo, y no los que los bordean o acaban en su borde', () => {
    const box = (id: string, x: number, y: number, width: number, height: number): Box => ({ id, x, y, width, height });
    const layout = (points: Array<[number, number]>): { layout: GraphLayout; titles: Map<string, string> } => ({
      layout: { nodes: [box('n', 100, 100, 80, 60)], groups: [box('g', 0, 0, 400, 300)], edges: [{ id: 'e', points: points.map(([x, y]) => ({ x, y })) }], width: 400, height: 300 },
      titles: new Map([['g', 'Flujo']]),
    });
    expect(routeHits(layout([[140, 50], [140, 200]]))).toEqual(['e → n']); // atraviesa el nodo
    expect(routeHits(layout([[140, 160], [140, 250]]))).toEqual([]); // sale por su borde inferior
    expect(routeHits(layout([[140, 250], [140, 160]]))).toEqual([]); // llega a su borde inferior
    expect(routeHits(layout([[100, 50], [100, 250]]))).toEqual([]); // roza su lado
    expect(routeHits(layout([[60, 130], [300, 130]]))).toEqual(['e → n']); // lo cruza en horizontal
    expect(routeHits(layout([[30, 0], [30, 250]]))).toEqual(['e → rótulo:g']); // el rótulo, arriba a la izquierda
    expect(routeHits(layout([[300, 0], [300, 250]]))).toEqual([]);
    expect(routeHits(layout([[0, 40], [380, 40]]))).toEqual([]); // bajo el rótulo
  });

  it('la capacidad compartida por el primer y el tercer flujo sube por un pasillo a la derecha del segundo, sin pisar nada ni cortarse con otra', async () => {
    const result = layoutValueStreams(shared);
    const { layout, edges } = result;
    const box = (id: string): Box => layout.nodes.find((n) => n.id === id)!;
    const group = (id: string): Box => layout.groups.find((g) => g.id === id)!;
    const route = layout.edges.find((e) => e.id === SHARED_EDGE)!;
    expect(edges.get(SHARED_EDGE)).toMatchObject({ source: 'acompanar', target: 'gestion-clientes' });
    // «Acompañar» es la primera etapa del tercer flujo, bajo el rótulo: sale hacia arriba, gira bajo el rótulo, sube por el pasillo y gira
    // en el hueco que hay entre el primer y el segundo flujo para llegar por debajo a la capacidad.
    expect(route.points).toHaveLength(6);
    const [out, strip, bottom, aisleTop, lane, end] = [route.points[0], route.points[1], route.points[2], route.points[3], route.points[4], route.points[5]];
    expect(out).toEqual({ x: box('acompanar').x + box('acompanar').width / 2, y: box('acompanar').y });
    expect(strip.y).toBeGreaterThanOrEqual(group('atender').y + LABEL_BOTTOM);
    expect(strip.y).toBeLessThan(box('acompanar').y);
    expect(bottom.x).toBeGreaterThan(group('emitir').x + group('emitir').width);
    expect(bottom).toEqual({ x: aisleTop.x, y: strip.y });
    expect(lane.y).toBeGreaterThanOrEqual(group('captar').y + group('captar').height);
    expect(lane.y).toBeLessThanOrEqual(group('emitir').y);
    expect(end).toEqual({ x: box('gestion-clientes').x + box('gestion-clientes').width / 2, y: box('gestion-clientes').y + box('gestion-clientes').height });
    for (let i = 1; i < route.points.length; i += 1) expect(route.points[i].x === route.points[i - 1].x || route.points[i].y === route.points[i - 1].y).toBe(true);
    // El pasillo cabe en el dibujo, y no hay pisadas ni cruces.
    expect(layout.width).toBeGreaterThan(bottom.x);
    expect(routeHits(result)).toEqual([]);
    expect(edgeCrossings(layout.edges, edges)).toBe(0);
    // Las demás aristas siguen con un solo codo como antes.
    for (const other of layout.edges.filter((e) => e.id !== SHARED_EDGE)) expect(other.points.length).toBeLessThanOrEqual(4);
  });

  it('el SVG y draw.io pintan la ruta tal cual: el SVG, con sus seis puntos; draw.io, con los cuatro intermedios y los lados por los que sale y llega', async () => {
    const route = layoutValueStreams(shared).layout.edges.find((e) => e.id === SHARED_EDGE)!;
    const svg = await toSvg(shared, 'value-stream');
    const d = route.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    expect(svg).toContain(`<path d="${d}"`);
    const xml = await toDrawio(shared);
    const cell = xml.match(new RegExp(`<mxCell id="e-${SHARED_EDGE}"[^>]*>(.*?)</mxCell>`))!;
    expect(cell[0]).toContain('exitX=0.5;exitY=0;');
    expect(cell[0]).toContain('entryX=0.5;entryY=1;');
    expect(cell[0].match(/<mxPoint /g)).toHaveLength(4);
    expect(cell[0]).toContain(`<mxPoint x="${route.points[1].x}" y="${route.points[1].y}"/>`);
    // Las que bajan salen por abajo y llegan por arriba.
    expect(xml).toMatch(/id="e-marketing--enables--atraer"[^>]*exitX=0.5;exitY=1;[^>]*entryX=0.5;entryY=0;/);
  });

  it('las aristas que salen de una misma etapa comparten pasillo y las de etapas distintas del mismo flujo suben por pasillos distintos', () => {
    // «x» la habilitan «p0» y dos etapas del último flujo (a dos de distancia, con otro flujo de por medio) y «y», «p1» y la última de ellas. La primera
    // etapa de ese flujo queda bajo el rótulo y sube por un pasillo lateral; la segunda queda a la derecha de todo y sube recta.
    const d = streamsDoc([['p0', 'p1'], ['m0'], ['q0', 'q1']], { x: ['p0', 'q0', 'q1'], y: ['p1', 'q1'], z: ['m0'] });
    const result = layoutValueStreams(d);
    const route = (id: string): Array<{ x: number; y: number }> => result.layout.edges.find((e) => e.id === id)!.points;
    // El pasillo es la columna del tramo vertical más largo.
    const aisle = (id: string): number => {
      const points = route(id);
      const long = points.slice(1).map((p, i) => ({ x: p.x, length: Math.abs(p.y - points[i].y), flat: p.x !== points[i].x })).filter((s) => !s.flat);
      return long.sort((a, b) => b.length - a.length)[0].x;
    };
    expect(aisle('x--enables--q1')).toBe(aisle('y--enables--q1')); // dos aristas de «q1»: un solo pasillo
    expect(aisle('x--enables--q0')).not.toBe(aisle('x--enables--q1')); // y otra etapa, otro pasillo
    expect(route('x--enables--q0')).toHaveLength(6);
    expect(routeHits(result)).toEqual([]);
    expect(edgeCrossings(result.layout.edges, result.edges)).toBe(0);
  });

  it('sin capacidades compartidas, o con un solo flujo, la colocación no cambia: un solo codo, sin franja bajo el rótulo y con el recuadro del tamaño de siempre', () => {
    const { layout } = layoutValueStreams(doc);
    expect(layout.groups).toEqual([{ id: 'pedido-a-entrega', x: 0, y: 0, width: 1274, height: 244 }]);
    expect(layout.nodes.find((n) => n.id === 'pedir')).toEqual({ id: 'pedir', x: 435, y: 38, width: 186, height: 76 });
    expect(layout.edges.find((e) => e.id === 'cobros--enables--pedir')!.points).toEqual([{ x: 528, y: 114 }, { x: 528, y: 131 }, { x: 637, y: 131 }, { x: 637, y: 158 }]);
    expect(layout.width).toBe(1274);
    expect(routeHits(layoutValueStreams(doc))).toEqual([]);
  });

  it('con una subida que no estorba el rótulo (la etapa queda a su derecha) sube recta, sin pasillo', () => {
    // La etapa de más a la derecha de un flujo ancho no tiene el rótulo encima.
    const d = streamsDoc([['p0', 'p1'], ['q0', 'q1', 'q2', 'q3', 'q4']], { arriba: ['p0', 'q4'], otra: ['q0'] });
    const result = layoutValueStreams(d);
    const route = result.layout.edges.find((e) => e.id === 'arriba--enables--q4')!;
    expect(route.points).toHaveLength(4);
    const stage = result.layout.nodes.find((n) => n.id === 'q4')!;
    expect(route.points[0].x).toBe(stage.x + stage.width / 2);
    expect(route.points[1].x).toBe(route.points[0].x);
    expect(routeHits(result)).toEqual([]);
  });

  it('ninguna arista atraviesa un nodo ni el rótulo de un recuadro, con flujos adyacentes o no, vacíos de por medio y capacidades compartidas (casos con semilla)', () => {
    const next = random(17);
    let withAisle = 0;
    let withLeft = 0;
    let withGap = 0;
    for (let i = 0; i < 300; i += 1) {
      const d = acrossFlows(next);
      const result = layoutValueStreams(d);
      const hits = routeHits(result);
      expect(hits, JSON.stringify(d.relations.map((r) => r.id))).toEqual([]);
      const { layout } = result;
      for (const route of layout.edges) {
        for (let k = 1; k < route.points.length; k += 1) expect(route.points[k].x === route.points[k - 1].x || route.points[k].y === route.points[k - 1].y).toBe(true);
        for (const p of route.points) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(layout.width);
        }
      }
      if (layout.edges.some((e) => e.points.length > 4)) withAisle += 1;
      // Un pasillo a la izquierda de los flujos queda dentro del lienzo: todo se desplaza para dejarle sitio.
      if (layout.edges.some((e) => e.points.some((p) => p.x < Math.min(...layout.groups.map((g) => g.x))))) withLeft += 1;
      // Los que suben llegan por debajo de la capacidad y salen por encima de la etapa.
      const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
      for (const route of layout.edges) {
        const { source, target } = result.edges.get(route.id)!;
        if (boxes.get(target)!.y < boxes.get(source)!.y) {
          const [first, last] = [route.points[0], route.points[route.points.length - 1]];
          expect(first.y).toBe(boxes.get(source)!.y);
          expect(last.y).toBe(boxes.get(target)!.y + boxes.get(target)!.height);
        }
      }
      if (d.valueStreams.some((s) => !d.valueStages.some((x) => x.streamId === s.id))) withGap += 1;
    }
    // La prueba no es vacía: muchas colocaciones tienen rutas con varios codos y flujos sin etapas de por medio.
    expect(withAisle).toBeGreaterThan(100);
    expect(withLeft).toBeGreaterThan(10);
    expect(withGap).toBeGreaterThan(30);
  });

  it('con capacidades compartidas por flujos no adyacentes las rutas largas no cuestan más cruces que la colocación anterior (casos con semilla)', () => {
    const next = random(29);
    for (let i = 0; i < 150; i += 1) {
      const d = acrossFlows(next);
      const before = previousLayout(d);
      expect(crossingsOf(d), JSON.stringify(d.relations.map((r) => r.id))).toBeLessThanOrEqual(edgeCrossings(before.routes, before.ends));
    }
  });

  it('con rutas largas el resultado es determinista: el mismo documento da la misma colocación', () => {
    for (const seed of [4, 8, 15]) {
      const d = acrossFlows(random(seed));
      const again = parse(JSON.parse(JSON.stringify(d)));
      expect(JSON.stringify(layoutValueStreams(again))).toBe(JSON.stringify(layoutValueStreams(d)));
    }
    expect(JSON.stringify(layoutValueStreams(shared))).toBe(JSON.stringify(layoutValueStreams(parse(JSON.parse(readFileSync('tests/fixtures/empresa-flujos-compartidos.json', 'utf8'))))));
  });
});

describe('flujos de valor: orden de las capacidades por búsqueda local', () => {
  /** Etapas e0..e5 de un flujo y cinco capacidades que habilitan varias de ellas: el baricentro las ordena con 14 cruces y la búsqueda local deja 9. */
  const dense = (): EnterpriseDocument => streamsDoc([['e0', 'e1', 'e2', 'e3', 'e4', 'e5']], { c0: ['e2', 'e3'], c1: ['e0', 'e4', 'e5'], c2: ['e2', 'e5'], c3: ['e3'], c4: ['e3'] });
  const crossingsWith = (d: EnterpriseDocument, refine: boolean): number => {
    const { layout, edges } = layoutValueStreams(d, { refine });
    return edgeCrossings(layout.edges, edges);
  };
  const orderOf = (d: EnterpriseDocument, refine: boolean): string[] =>
    layoutValueStreams(d, { refine }).layout.nodes.filter((n) => d.capabilities.some((c) => c.id === n.id)).sort((a, b) => a.x - b.x).map((n) => n.id);

  it('mejora el orden por baricentro cuando hay etapas no contiguas', () => {
    const d = dense();
    expect(crossingsWith(d, false)).toBe(14);
    expect(crossingsWith(d, true)).toBe(9);
    expect(orderOf(d, true)).not.toEqual(orderOf(d, false));
    // Sigue siendo una permutación de las mismas capacidades.
    expect([...orderOf(d, true)].sort()).toEqual([...orderOf(d, false)].sort());
  });

  it('nunca da más cruces que el baricentro simple y casi siempre hay casos donde da menos (flujos con capacidades compartidas, con semilla)', () => {
    let fewer = 0;
    for (const [seed, options] of [[7, {}], [21, { flows: 5, share: 0.25 }], [33, { flows: 5, share: 0.5 }], [5, { flows: 5, share: 0.3, empty: 0.2 }]] as const) {
      const next = random(seed);
      for (let i = 0; i < 100; i += 1) {
        const d = sharedCapabilities(next, options);
        const [simple, refined] = [crossingsWith(d, false), crossingsWith(d, true)];
        expect(refined, JSON.stringify(d.relations.map((r) => r.id))).toBeLessThanOrEqual(simple);
        if (refined < simple) fewer += 1;
      }
    }
    expect(fewer).toBeGreaterThan(10);
  });

  it('es estable: si el baricentro ya es el mejor orden, no se mueve nada, y en los empates se queda el del documento', () => {
    const tidy = streamsDoc([['e0', 'e1', 'e2']], { a: ['e0'], b: ['e1'], c: ['e2'] });
    expect(orderOf(tidy, true)).toEqual(['a', 'b', 'c']);
    expect(layoutValueStreams(tidy)).toEqual(layoutValueStreams(tidy, { refine: false }));
    const tie = streamsDoc([['e0', 'e1']], { b: ['e0'], a: ['e0'], c: ['e0'] });
    expect(orderOf(tie, true)).toEqual(['b', 'a', 'c']);
  });

  it('refineOrder: nunca empeora el orden de partida, no se mueve en los empates, respeta el tope de pasadas y da siempre lo mismo', () => {
    const next = random(3);
    for (let i = 0; i < 200; i += 1) {
      const n = 2 + Math.floor(next() * 7);
      const cost = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(next() * 4)));
      const order = Array.from({ length: n }, (_, k) => k);
      const total = (o: number[]): number => o.reduce((sum, a, p) => sum + o.slice(p + 1).reduce((s, b) => s + cost[a][b], 0), 0);
      const refined = refineOrder(order, (a, b) => cost[a][b]);
      expect(total(refined)).toBeLessThanOrEqual(total(order));
      expect([...refined].sort((a, b) => a - b)).toEqual(order);
      expect(refineOrder(order, (a, b) => cost[a][b])).toEqual(refined);
      expect(refineOrder(order, (a, b) => cost[a][b], 0)).toEqual(order);
    }
    expect(refineOrder([0, 1, 2, 3], () => 1)).toEqual([0, 1, 2, 3]);
    // Un par al revés se corrige con una sola pasada.
    expect(refineOrder([0, 1], (a, b) => (a < b ? 1 : 0))).toEqual([1, 0]);
  });
});
