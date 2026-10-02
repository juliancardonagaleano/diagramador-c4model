import { describe, expect, it } from 'vitest';
import example from '../../../examples/empresa-arquitectura.json';
import { enterpriseEditor } from './editor';
import { enterpriseModule } from './module';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { dependencyGraph, reach } from './graph';
import type { EnterpriseDocument } from './types';
import { findView, listViews } from './views';

const doc = enterpriseModule.schema.parse(example) as EnterpriseDocument;
const valid = (d: EnterpriseDocument): boolean => enterpriseModule.schema.safeParse(d).success;

/** El ejemplo con una aplicación compuesta, un proceso más y las relaciones nuevas (composición, flujo, disparo, asignación). */
const extended: EnterpriseDocument = {
  ...doc,
  processes: [...doc.processes, { id: 'preparacion-pedido', name: 'Preparación de pedido', ownerId: 'logistica' }],
  applications: [
    ...doc.applications.map((a) => (a.id === 'portal-proveedores' ? { ...a, endOfLife: '2026-12' } : a.id === 'wms-legacy' ? { ...a, endOfLife: '2027-03' } : a)),
    { id: 'erp-facturacion', name: 'ERP · módulo de facturación', technology: 'SAP S/4HANA', ownerId: 'finanzas', criticality: 'high' },
  ],
  relations: [
    ...doc.relations,
    { id: 'erp--composes--erp-facturacion', kind: 'composes', sourceId: 'erp', targetId: 'erp-facturacion' },
    { id: 'erp-facturacion--flows-to--facturacion-electronica', kind: 'flows-to', sourceId: 'erp-facturacion', targetId: 'facturacion-electronica', description: 'facturas a emitir' },
    { id: 'alta-pedido--triggers--preparacion-pedido', kind: 'triggers', sourceId: 'alta-pedido', targetId: 'preparacion-pedido' },
    { id: 'ventas--assigned-to--alta-pedido', kind: 'assigned-to', sourceId: 'ventas', targetId: 'alta-pedido' },
    { id: 'logistica--assigned-to--preparacion-pedido', kind: 'assigned-to', sourceId: 'logistica', targetId: 'preparacion-pedido' },
  ],
};

describe('editor empresarial', () => {
  it('el mapa de capacidades anida las capacidades, colorea las hojas por madurez y trae su propia colocación en cuadrícula', () => {
    const g = enterpriseEditor.project(doc, 'capabilities');
    expect(g.nodes.length).toBe(doc.capabilities.length);
    expect(g.edges).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'ventas-online')).toMatchObject({ parentId: 'gestion-comercial', fill: '#d8f5a2', badges: ['madurez 4/5'] });
    expect(g.nodes.find((n) => n.id === 'gestion-comercial')?.fill).toBeUndefined();
    const layout = enterpriseEditor.layout!(doc, 'capabilities');
    expect(layout && !(layout instanceof Promise) && layout.groups.some((b) => b.id === 'gestion-comercial')).toBe(true);
    expect(enterpriseEditor.layout!(doc, 'landscape')).toBeUndefined();
  });

  it('el paisaje dibuja capacidad → aplicación → tecnología con las relaciones en el sentido de la dependencia', () => {
    const g = enterpriseEditor.project(doc, 'landscape');
    const kinds = new Set(g.nodes.map((n) => n.kind));
    expect(kinds.has('application') && kinds.has('technology')).toBe(true);
    // El lienzo dibuja todas las unidades en el paisaje (para poder arrastrarles una asignación).
    expect(g.nodes.filter((n) => n.kind === 'unit')).toHaveLength(doc.units.length);
    expect(g.edges.find((e) => e.id === 'tienda-web--supports--ventas-online')).toMatchObject({ kind: 'supports', source: 'ventas-online', target: 'tienda-web' });
    const app = g.nodes.find((n) => n.id === 'tienda-web');
    expect(app?.sublabel).toBeTruthy();
  });

  it('las relaciones respetan las reglas del modelo en cualquier sentido del arrastre', () => {
    expect(enterpriseEditor.canConnect!(doc, 'supports', 'ventas-online', 'tienda-web')).toContain('ya existe');
    expect(enterpriseEditor.canConnect!(doc, 'runs-on', 'ventas-online', 'tienda-web')).toMatch(/se ejecuta en/);
    const added = enterpriseEditor.addEdge(doc, 'realizes', 'gestion-clientes', 'alta-pedido');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const created = added.document.relations.find((r) => r.id === added.id)!;
    expect(created).toMatchObject({ kind: 'realizes', sourceId: 'alta-pedido', targetId: 'gestion-clientes' });
    expect(valid(added.document)).toBe(true);
    const wrong = enterpriseEditor.update(added.document, created.id, { kind: 'runs-on' });
    expect(wrong).toMatchObject({ ok: false });
  });

  it('añadir, editar (madurez como número, padre sin ciclos) y borrar una capacidad arrastra su subárbol y sus relaciones', () => {
    const added = enterpriseEditor.addNode(doc, 'capability', 'Fidelización', 'gestion-comercial');
    expect(added.ok && added.document.capabilities.find((c) => c.id === added.id)).toMatchObject({ name: 'Fidelización', parentId: 'gestion-comercial' });
    if (!added.ok) return;
    const edited = enterpriseEditor.update(added.document, added.id!, { maturity: '3', importance: 'core', ownerId: 'ventas' });
    expect(edited.ok && edited.document.capabilities.find((c) => c.id === added.id)).toMatchObject({ maturity: 3, importance: 'core', ownerId: 'ventas' });
    if (!edited.ok) return;
    expect(valid(edited.document)).toBe(true);
    expect(enterpriseEditor.read(edited.document, added.id!)?.values.maturity).toBe('3');
    expect(enterpriseEditor.update(edited.document, 'gestion-comercial', { parentId: 'ventas-online' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(edited.document, added.id!, { ownerId: 'tienda-web' })).toMatchObject({ ok: false });

    const removed = enterpriseEditor.remove(edited.document, 'gestion-comercial');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.document.capabilities.some((c) => c.id === 'ventas-online' || c.id === added.id)).toBe(false);
    expect(removed.document.relations.some((r) => r.targetId === 'ventas-online')).toBe(false);
    expect(valid(removed.document)).toBe(true);
  });

  it('una aplicación nueva se edita con sus campos propios y se enlaza por URN', () => {
    const added = enterpriseEditor.addNode(doc, 'application', 'CRM nuevo');
    if (!added.ok) throw new Error('no se añadió');
    const fields = enterpriseEditor.fields({ type: 'node', kind: 'application' }, doc).map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(['lifecycle', 'criticality', 'external', 'ref']));
    const edited = enterpriseEditor.update(added.document, added.id!, { lifecycle: 'planned', criticality: 'high', external: true, ref: 'urn:iark:c4:crm' });
    if (!edited.ok) throw new Error(edited.reason);
    expect(valid(edited.document)).toBe(true);
    const removed = enterpriseEditor.remove(edited.document, added.id!);
    expect(removed.ok && removed.document.applications.length).toBe(doc.applications.length);
  });

  it('los colores siguen las capas de ArchiMate (negocio amarillo, aplicación azul, tecnología verde) y cada tipo lleva su icono', async () => {
    const kinds = new Map(enterpriseEditor.nodeKinds.map((k) => [k.kind, k]));
    expect(kinds.get('capability')?.fill).toBe('#ffec99');
    expect(kinds.get('process')?.fill).toBe('#ffe066');
    expect(kinds.get('application')?.fill).toBe('#74c0fc');
    expect(kinds.get('technology')?.fill).toBe('#8ce99a');
    for (const k of ['capability', 'process', 'application', 'technology', 'unit']) expect(kinds.get(k)?.icon?.length).toBeGreaterThan(0);
    const svg = await toSvg(doc, 'landscape');
    expect(svg).toContain('fill="#74c0fc"');
    expect(svg).toContain('fill="#8ce99a"');
    expect(svg).toContain(`<path d="${kinds.get('application')!.icon![0]}"`); // icono del tipo en la esquina
    const drawio = await toDrawio(doc);
    expect(drawio).toContain('image=data:image/svg+xml,');
    expect(drawio).toContain('fillColor=#74c0fc');
    expect(toMermaid(doc, { viewId: 'landscape' })).toContain('classDef application fill:#74c0fc');
  });

  it('el mapa de capacidades se colorea por madurez, importancia, criticidad o ciclo de vida, con su leyenda', async () => {
    const refs = enterpriseModule.views!(doc);
    expect(refs.filter((v) => v.variantOf === 'capabilities').map((v) => v.id)).toEqual(['capabilities:importance', 'capabilities:criticality', 'capabilities:lifecycle']);
    expect(listViews(doc).some((v) => v.id.includes(':') && v.type === 'capabilities')).toBe(false); // las variantes no se exportan por lotes
    const node = (viewId: string, id: string) => enterpriseEditor.project(doc, viewId).nodes.find((n) => n.id === id)!;
    expect(enterpriseEditor.project(doc, 'capabilities').legend?.title).toBe('Color: madurez');
    // «Gestión de inventario» la soportan el WMS heredado (en retirada, criticidad alta) y el nuevo (previsto).
    expect(node('capabilities:criticality', 'gestion-inventario')).toMatchObject({ fill: '#ffd8a8', badges: ['criticidad alta'] });
    expect(node('capabilities:lifecycle', 'gestion-inventario')).toMatchObject({ fill: '#ffd8a8', badges: ['aplicaciones con una en retirada'] });
    expect(node('capabilities:importance', 'ventas-online')).toMatchObject({ fill: '#b197fc', badges: ['diferenciadora'] });
    expect(node('capabilities:lifecycle', 'ventas-online')).toMatchObject({ fill: '#b2f2bb' });
    const legend = enterpriseEditor.project(doc, 'capabilities:criticality').legend!;
    expect(legend.items.map((i) => i.label)).toEqual(['baja', 'media', 'alta', 'crítica', 'sin aplicación']);
    expect(findView(doc, 'capabilities:criticality').colorBy).toBe('criticality');
    expect(() => findView(doc, 'capabilities:nada')).toThrow(/No existe la vista/);
    const svg = await toSvg(doc, 'capabilities:criticality');
    expect(svg).toContain('Color: criticidad de las aplicaciones');
    expect(svg).toContain('fill="#ffd8a8"');
  });

  it('las relaciones nuevas (composición, flujo, asignación y disparo) respetan las reglas y se dibujan con flecha propia', async () => {
    const doc = extended;
    expect(valid(doc)).toBe(true);
    const kinds = new Map(enterpriseEditor.edgeKinds.map((k) => [k.kind, k]));
    expect(kinds.get('composes')).toMatchObject({ tail: 'diamond', arrowEnd: false });
    expect(kinds.get('assigned-to')).toMatchObject({ tail: 'dot' });
    expect(kinds.get('triggers')).toMatchObject({ head: 'open' });
    expect(kinds.get('flows-to')).toMatchObject({ line: 'dashed' });

    // Asignación: arrastrando en cualquier sentido, el origen del modelo es la unidad.
    const assigned = enterpriseEditor.addEdge(doc, 'assigned-to', 'cierre-mensual', 'finanzas');
    if (!assigned.ok) throw new Error(assigned.reason);
    expect(assigned.document.relations.find((r) => r.id === assigned.id)).toMatchObject({ kind: 'assigned-to', sourceId: 'finanzas', targetId: 'cierre-mensual' });
    expect(valid(assigned.document)).toBe(true);
    expect(enterpriseEditor.canConnect!(doc, 'assigned-to', 'tienda-web', 'ventas')).toMatch(/unidad → proceso/);
    expect(enterpriseEditor.canConnect!(doc, 'assigned-to', 'ventas', 'alta-pedido')).toContain('ya existe');
    expect(enterpriseEditor.canConnect!(doc, 'composes', 'ventas-online', 'gestion-pedidos')).toMatch(/se compone de/);
    expect(enterpriseEditor.canConnect!(doc, 'triggers', 'tienda-web', 'erp')).toMatch(/proceso → proceso/);
    expect(enterpriseEditor.canConnect!(doc, 'flows-to', 'tienda-web', 'kubernetes')).toMatch(/fluye hacia/);

    const triggered = enterpriseEditor.addEdge(doc, 'triggers', 'cierre-mensual', 'devoluciones');
    expect(triggered.ok && valid(triggered.document)).toBe(true);
    expect(enterpriseEditor.addEdge(doc, 'composes', 'erp-facturacion', 'tienda-web').ok).toBe(true);
    expect(enterpriseEditor.update(doc, 'erp-facturacion--flows-to--facturacion-electronica', { kind: 'composes' })).toMatchObject({ ok: true });
    expect(enterpriseEditor.update(doc, 'erp-facturacion--flows-to--facturacion-electronica', { kind: 'assigned-to' })).toMatchObject({ ok: false });

    // Las unidades con una asignación se dibujan en el paisaje, con su arista; quien recibe un disparo depende de quien lo lanza.
    const landscape = enterpriseEditor.project(doc, 'landscape');
    expect(landscape.nodes.find((n) => n.id === 'ventas')).toMatchObject({ kind: 'unit' });
    expect(landscape.edges.find((e) => e.id === 'ventas--assigned-to--alta-pedido')).toMatchObject({ kind: 'assigned-to', source: 'ventas', target: 'alta-pedido' });
    expect(landscape.nodes.find((n) => n.id === 'finanzas')).toMatchObject({ kind: 'unit' });
    expect(landscape.edges.some((e) => e.source === 'finanzas' || e.target === 'finanzas')).toBe(false);
    const graph = dependencyGraph(doc);
    expect(reach(graph, 'alta-pedido', 'dependents').map((s) => s.id)).toContain('preparacion-pedido');

    const svg = await toSvg(doc, 'landscape');
    expect(svg).toContain('marker-end="url(#arrow-open)"'); // disparo
    expect(svg).toMatch(/<path d="M0 0 L6 -4 L12 0 L6 4 z"/); // rombo de la composición
    expect(svg).toContain('<circle cx="4" cy="0" r="4"'); // punto de la asignación
    const drawio = await toDrawio(doc);
    expect(drawio).toContain('startArrow=diamondThin');
    expect(drawio).toContain('startArrow=oval');
    expect(drawio).toContain('endArrow=open');
  });

  it('las aplicaciones guardan coste anual, usuarios y estrategia de modernización, y el editor valida los valores', () => {
    const fields = enterpriseEditor.fields({ type: 'node', kind: 'application' }, doc).map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(['annualCost', 'users', 'strategy', 'endOfLife']));
    const edited = enterpriseEditor.update(doc, 'crm', { annualCost: '250000', users: '130', strategy: 'migrate' });
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.document.applications.find((a) => a.id === 'crm')).toMatchObject({ annualCost: 250000, users: 130, strategy: 'migrate' });
    expect(valid(edited.document)).toBe(true);
    expect(enterpriseEditor.read(edited.document, 'crm')?.values).toMatchObject({ annualCost: 250000, strategy: 'migrate' });
    const cleared = enterpriseEditor.update(edited.document, 'crm', { annualCost: '', strategy: '' });
    expect(cleared.ok && cleared.document.applications.find((a) => a.id === 'crm')).not.toHaveProperty('annualCost');
    expect(enterpriseEditor.update(doc, 'crm', { annualCost: '-5' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(doc, 'crm', { users: 'muchos' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(doc, 'crm', { users: '2.5' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(doc, 'crm', { endOfLife: 'pronto' })).toMatchObject({ ok: false });
    const crm = enterpriseEditor.project(doc, 'landscape').nodes.find((n) => n.id === 'crm')!;
    expect(crm.badges).toEqual(expect.arrayContaining(['estrategia conservar']));
    expect(crm.sublabel).toBe('Salesforce · 240 k/año · 120 usuarios');
    // Un documento sin estos campos sigue siendo válido (campos opcionales, misma versión).
    expect(enterpriseModule.schema.safeParse({ version: '1.0', workspace: { name: 'x' }, applications: [{ id: 'a', name: 'A' }] }).success).toBe(true);
    expect(enterpriseModule.schema.safeParse({ version: '1.0', workspace: { name: 'x' }, applications: [{ id: 'a', name: 'A', strategy: 'jubilar' }] }).success).toBe(false);
  });

  it('la hoja de ruta reparte en columnas lo que sale de soporte o se retira', async () => {
    const doc = extended;
    expect(findView(doc, 'roadmap').type).toBe('roadmap');
    const graph = enterpriseEditor.project(doc, 'roadmap');
    const columns = graph.nodes.filter((n) => n.kind === 'period').map((n) => n.label);
    expect(columns).toEqual(['Fin de soporte 2026', 'Fin de soporte 2027', 'Fin de soporte 2034', 'Sin fecha', 'Previstas']);
    expect(graph.nodes.find((n) => n.id === 'portal-proveedores')).toMatchObject({ parentId: 'roadmap:2026', badges: expect.arrayContaining(['estrategia migrar']) });
    expect(graph.nodes.find((n) => n.id === 'hana')).toMatchObject({ parentId: 'roadmap:2034', badges: ['soporte hasta 2034-12'] });
    expect(graph.nodes.find((n) => n.id === 'oracle-11g')).toMatchObject({ parentId: 'roadmap:undated' });
    expect(graph.nodes.find((n) => n.id === 'wms-nuevo')).toMatchObject({ parentId: 'roadmap:planned' });
    expect(graph.nodes.some((n) => n.id === 'crm')).toBe(false);
    const layout = enterpriseEditor.layout!(doc, 'roadmap');
    expect(layout && !(layout instanceof Promise) && layout.groups.length).toBe(5);
    expect(enterpriseEditor.read(doc, 'roadmap:2027')).toMatchObject({ kind: 'period' });
    expect(await toSvg(doc, 'roadmap')).toContain('Fin de soporte 2027');
    expect(toMermaid(doc, { viewId: 'roadmap' })).toContain('subgraph roadmap_2027["Fin de soporte 2027"]');
    expect(await toDrawio(doc)).toContain('value="Fin de soporte 2027"');
  });

  it('«Agrupar por unidad» da un responsable a la selección (y crea la unidad si no existe)', () => {
    const action = enterpriseEditor.actions!.find((a) => a.id === 'group-by-unit')!;
    expect(action.disabled!(doc, ['ventas'])).toBeTruthy();
    expect(action.disabled!(doc, ['crm', 'erp'])).toBeUndefined();
    expect(action.prompt!.initial!(doc, ['crm', 'motor-precios'])).toBe('Ventas');
    expect(action.prompt!.suggestions!(doc)).toContain('Logística');
    const moved = action.run(doc, ['crm', 'ventas-online'], 'logística');
    if (!moved.ok) throw new Error(moved.reason);
    expect(moved.id).toBe('logistica');
    expect(moved.document.applications.find((a) => a.id === 'crm')?.ownerId).toBe('logistica');
    expect(moved.document.capabilities.find((c) => c.id === 'ventas-online')?.ownerId).toBe('logistica');
    expect(moved.document.units).toHaveLength(doc.units.length);
    const created = action.run(doc, ['crm'], 'Nuevo equipo');
    if (!created.ok) throw new Error(created.reason);
    expect(created.document.units.at(-1)).toMatchObject({ id: 'nuevo-equipo', name: 'Nuevo equipo' });
    expect(valid(created.document)).toBe(true);
    expect(action.run(doc, ['crm'], '  ')).toMatchObject({ ok: false });
  });

  it('«Reemplazar aplicación» crea la sucesora prevista, hereda lo que soporta y deja la antigua en retirada', () => {
    const action = enterpriseEditor.actions!.find((a) => a.id === 'replace-application')!;
    expect(action.disabled!(doc, ['alta-pedido'])).toBeTruthy();
    expect(action.disabled!(doc, ['crm'])).toBeUndefined();
    const replaced = action.run(doc, ['crm'], 'CRM nuevo');
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.id).toBe('crm-nuevo');
    const next = replaced.document;
    expect(next.applications.find((a) => a.id === 'crm')).toMatchObject({ lifecycle: 'sunset', strategy: 'replace' });
    expect(next.applications.find((a) => a.id === 'crm-nuevo')).toMatchObject({ lifecycle: 'planned', ownerId: 'ventas', criticality: 'high' });
    const supported = next.relations.filter((r) => r.kind === 'supports' && r.sourceId === 'crm-nuevo').map((r) => r.targetId);
    expect(supported.sort()).toEqual(['devoluciones', 'fidelizacion', 'gestion-clientes']);
    expect(valid(next)).toBe(true);
    expect(action.run(doc, ['crm'], '')).toMatchObject({ ok: false });
  });

  it('una unidad se dibuja, se edita (padre sin ciclos) y al borrarla deja libres a sus elementos', () => {
    const added = enterpriseEditor.addNode(doc, 'unit', 'Soporte');
    if (!added.ok) throw new Error(added.reason);
    const shown = enterpriseEditor.project(added.document, 'landscape').nodes.find((n) => n.id === added.id);
    expect(shown).toMatchObject({ kind: 'unit', label: 'Soporte' }); // suelta del todo: se dibuja para poder conectarla
    expect(enterpriseEditor.update(added.document, 'direccion-comercial', { parentId: 'ventas' })).toMatchObject({ ok: false });
    const removed = enterpriseEditor.remove(doc, 'ventas');
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.document.applications.find((a) => a.id === 'tienda-web')).not.toHaveProperty('ownerId');
    expect(removed.document.relations.some((r) => r.sourceId === 'ventas')).toBe(false);
    expect(valid(removed.document)).toBe(true);
  });
});
