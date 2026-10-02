import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { enterpriseEditor } from './editor';
import { fromMermaid } from './import/fromMermaid';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutValueStreams, toSvg } from './export/render';
import { dependencyGraph, reach, stageCapabilities, streamStages } from './graph';
import { analyzeEnterprise } from './issues';
import { enterpriseJsonSchema, validateEnterpriseDocument } from './schema';
import { type EnterpriseDocument } from './types';
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
