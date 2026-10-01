import { describe, expect, it } from 'vitest';
import { integrationEditor as editor } from './editor';
import { validateIntegrationDocument } from './schema';
import type { IntegrationDocument } from './types';

const parse = (input: unknown): IntegrationDocument => {
  const r = validateIntegrationDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};

const base = () =>
  parse({
    nodes: [
      { id: 'web', kind: 'system', name: 'Web', owner: 'Canales' },
      { id: 'pedidos', kind: 'system', name: 'Pedidos', owner: 'Equipo Pedidos' },
      { id: 'pedidos-api', kind: 'api', name: 'API de pedidos', parentId: 'pedidos', contractId: 'openapi' },
      { id: 'kafka', kind: 'broker', name: 'Kafka', owner: 'Plataforma' },
      { id: 'topic', kind: 'topic', name: 'pedido-creado', parentId: 'kafka' },
      { id: 'otro', kind: 'topic', name: 'otro', parentId: 'kafka' },
      { id: 'db', kind: 'store', name: 'Base' },
      { id: 'fact', kind: 'system', name: 'Facturación' },
    ],
    contracts: [{ id: 'openapi', name: 'API de pedidos', format: 'openapi', version: '2.1.0' }],
    interactions: [
      { id: 'web-api', sourceId: 'web', targetId: 'pedidos-api', style: 'request-response', description: 'Crea', protocol: 'HTTPS', order: 10 },
      { id: 'pub', sourceId: 'pedidos', targetId: 'topic', style: 'event', pattern: 'publish-subscribe', order: 20 },
      { id: 'sub', sourceId: 'topic', targetId: 'fact', style: 'event' },
    ],
    flows: [{ id: 'f', name: 'F', steps: [{ interactionId: 'web-api' }, { interactionId: 'pub' }, { interactionId: 'sub' }] }],
  });

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error((result as unknown as { reason: string }).reason);
  return result as Extract<T, { ok: true }>;
};

const act = (id: string) => editor.actions!.find((a) => a.id === id)!;

describe('notación', () => {
  it('declara los doce tipos con la figura EIP de cada uno', () => {
    const shape = (kind: string) => editor.nodeKinds.find((k) => k.kind === kind)?.shape;
    expect(shape('api')).toBe('hexagon');
    expect(shape('gateway')).toBe('chevron');
    expect(shape('broker')).toBe('bar');
    expect(shape('queue')).toBe('pipe');
    expect(shape('topic')).toBe('fan');
    expect(shape('store')).toBe('cylinder');
    expect(shape('user')).toBe('actor');
    expect(shape('scheduler')).toBe('clock');
    expect(shape('pattern')).toBe('diamond');
    expect(editor.nodeKinds.filter((k) => k.addable !== false)).toHaveLength(12);
  });
});

describe('proyección al lienzo', () => {
  it('numera las líneas, dibuja el icono del patrón y muestra el contrato en el nodo', () => {
    const graph = editor.project(base(), 'map');
    const web = graph.edges.find((e) => e.id === 'web-api')!;
    expect(web.marks).toEqual([{ text: '1', title: 'Paso 1' }]);
    expect(web.label).toBe('Crea [HTTPS]');
    const pub = graph.edges.find((e) => e.id === 'pub')!;
    expect(pub.marks?.map((m) => m.text ?? 'icono')).toEqual(['2', 'icono']);
    expect(pub.marks?.[1].title).toBe('Publicación-suscripción');
    expect(pub.marks?.[1].icon?.length).toBeGreaterThan(0);
    expect(graph.edges.find((e) => e.id === 'sub')!.marks).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'pedidos-api')!.badges).toEqual(['openapi 2.1.0']);
  });

  it('un flujo numera por la posición de sus pasos', () => {
    const graph = editor.project(base(), 'flow:f');
    expect(graph.edges.map((e) => e.marks?.[0].text)).toEqual(['1', '2', '3']);
  });

  it('los dominios salen como zonas que envuelven a los nodos de primer nivel', () => {
    const doc = ok(act('group-domain').run(base(), ['pedidos', 'kafka'], 'Núcleo')).document;
    const graph = editor.project(doc, 'map');
    const zone = graph.nodes.find((n) => n.kind === 'domain')!;
    expect(zone).toMatchObject({ id: 'domain:nucleo', label: 'Núcleo' });
    expect(graph.nodes.find((n) => n.id === 'pedidos')!.parentId).toBe('domain:nucleo');
    expect(graph.nodes.find((n) => n.id === 'kafka')!.parentId).toBe('domain:nucleo');
    expect(graph.nodes.find((n) => n.id === 'pedidos-api')!.parentId).toBe('pedidos');
    expect(graph.nodes.find((n) => n.id === 'web')!.parentId).toBeUndefined();
  });

  it('la vista de un sistema proyecta solo a él y a sus vecinos', () => {
    const graph = editor.project(base(), 'system:fact');
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['fact', 'kafka', 'topic']);
    expect(graph.edges.map((e) => e.id)).toEqual(['sub']);
  });
});

describe('campos', () => {
  it('el orden es numérico, los contratos abren su editor y solo un nodo de patrón elige patrón', () => {
    const doc = base();
    const edge = editor.fields({ type: 'edge', kind: 'event' }, doc);
    expect(edge.find((f) => f.key === 'order')).toMatchObject({ type: 'number' });
    expect(edge.find((f) => f.key === 'contractId')).toMatchObject({ type: 'select', opensAttachment: true });
    expect(edge.find((f) => f.key === 'pattern')).toMatchObject({ type: 'select', allowEmpty: true });
    expect(editor.fields({ type: 'node', kind: 'api' }, doc).some((f) => f.key === 'pattern')).toBe(false);
    expect(editor.fields({ type: 'node', kind: 'pattern' }, doc).some((f) => f.key === 'pattern')).toBe(true);
    expect(editor.fields({ type: 'node', kind: 'api' }, doc).find((f) => f.key === 'contractId')).toMatchObject({ opensAttachment: true });
  });
});

describe('edición', () => {
  it('añade un nodo de patrón con su patrón por defecto y respeta quién puede contener a quién', () => {
    const pattern = ok(editor.addNode(base(), 'pattern', 'Patrón nuevo'));
    expect(pattern.document.nodes.find((n) => n.id === pattern.id)).toMatchObject({ kind: 'pattern', pattern: 'content-based-router' });

    const inGateway = parse({ nodes: [{ id: 'g', kind: 'gateway', name: 'G' }] });
    const queue = ok(editor.addNode(inGateway, 'queue', 'cola', 'g'));
    expect(queue.document.nodes.find((n) => n.id === queue.id)?.parentId).toBe('g');
    const inSystem = ok(editor.addNode(base(), 'queue', 'cola', 'pedidos'));
    expect(inSystem.document.nodes.find((n) => n.id === inSystem.id)?.parentId).toBeUndefined();
    expect(ok(editor.addNode(base(), 'mcp', 'mcp', 'pedidos')).document.nodes.at(-1)?.parentId).toBe('pedidos');
    expect(editor.addNode(base(), 'inventado', 'x').ok).toBe(false);
  });

  it('un nodo añadido con una zona seleccionada queda en esa zona', () => {
    const doc = ok(act('group-domain').run(base(), ['web'], 'Canales')).document;
    const added = ok(editor.addNode(doc, 'system', 'Móvil', 'domain:canales'));
    expect(added.document.nodes.find((n) => n.id === added.id)?.domain).toBe('Canales');
  });

  it('las reglas de conexión bloquean la unión y explican por qué', () => {
    const doc = base();
    expect(editor.canConnect!(doc, 'event', 'db', 'topic')).toContain('almacén');
    expect(editor.canConnect!(doc, 'event', 'topic', 'otro')).toContain('otro canal');
    expect(editor.canConnect!(doc, 'request-response', 'web', 'topic')).toContain('petición-respuesta');
    expect(editor.canConnect!(doc, 'event', 'web', 'db')).toContain('lectura y escritura');
    expect(editor.canConnect!(doc, 'request-response', 'web', 'web')).toContain('consigo mismo');
    expect(editor.canConnect!(doc, 'request-response', 'web', 'fact')).toBeUndefined();
    expect(editor.addEdge(doc, 'event', 'db', 'topic').ok).toBe(false);
    expect(ok(editor.addEdge(doc, 'request-response', 'web', 'fact')).document.interactions).toHaveLength(4);
  });

  it('el orden es un número (o se borra) y cambiar el estilo respeta las reglas', () => {
    const doc = base();
    const timed = ok(editor.update(doc, 'sub', { order: 30 })).document;
    expect(timed.interactions.find((i) => i.id === 'sub')?.order).toBe(30);
    const cleared = ok(editor.update(timed, 'sub', { order: undefined })).document;
    expect(cleared.interactions.find((i) => i.id === 'sub')).not.toHaveProperty('order');
    expect(editor.update(doc, 'sub', { order: 'pronto' }).ok).toBe(false);
    const blocked = editor.update(doc, 'sub', { style: 'request-response' });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toContain('petición-respuesta');
  });

  it('un nodo de patrón no puede quedarse sin patrón y los demás no lo aceptan', () => {
    const doc = ok(editor.addNode(base(), 'pattern', 'P')).document;
    expect(editor.update(doc, 'p', { pattern: '' }).ok).toBe(false);
    expect(ok(editor.update(doc, 'p', { pattern: 'filter' })).document.nodes.find((n) => n.id === 'p')?.pattern).toBe('filter');
    expect(ok(editor.update(doc, 'web', { pattern: 'filter' })).document.nodes.find((n) => n.id === 'web')).not.toHaveProperty('pattern');
  });

  it('renombrar una zona cambia el dominio de todos sus nodos y borrarla los saca de ella', () => {
    const doc = ok(act('group-domain').run(base(), ['web', 'fact'], 'Canales')).document;
    const renamed = ok(editor.update(doc, 'domain:canales', { name: 'Frontales' }));
    expect(renamed.id).toBe('domain:frontales');
    expect(renamed.document.nodes.filter((n) => n.domain === 'Frontales').map((n) => n.id)).toEqual(['web', 'fact']);
    const ungrouped = ok(editor.remove(renamed.document, 'domain:frontales')).document;
    expect(ungrouped.nodes.some((n) => n.domain)).toBe(false);
    expect(ungrouped.nodes).toHaveLength(doc.nodes.length);
    expect(editor.read(doc, 'domain:canales')).toMatchObject({ kind: 'domain', values: { name: 'Canales' } });
  });

  it('borrar un nodo quita sus interacciones y los pasos de los flujos', () => {
    const doc = ok(editor.remove(base(), 'topic')).document;
    expect(doc.interactions.map((i) => i.id)).toEqual(['web-api']);
    expect(doc.flows[0].steps.map((s) => s.interactionId)).toEqual(['web-api']);
  });
});

describe('acciones', () => {
  it('«Agrupar en dominio» lleva al padre con sus hijos y propone el dominio más usado', () => {
    const doc = base();
    const grouped = ok(act('group-domain').run(doc, ['pedidos-api', 'kafka'], '  Núcleo  '));
    expect(grouped.id).toBe('domain:nucleo');
    expect(grouped.document.nodes.filter((n) => n.domain).map((n) => [n.id, n.domain])).toEqual([['pedidos', 'Núcleo'], ['kafka', 'Núcleo']]);
    expect(act('group-domain').run(doc, ['web'], '   ').ok).toBe(false);
    expect(act('group-domain').disabled!(doc, ['no-existe'])).toBeDefined();
    expect(act('group-domain').prompt!.initial!(doc, ['web'])).toBe('Canales');
    expect(act('group-domain').prompt!.suggestions!(doc)).toEqual(['Canales', 'Equipo Pedidos', 'Plataforma']);
  });

  it('«Sacar del dominio» y «Agrupar por responsable»', () => {
    const doc = base();
    const byOwner = ok(act('group-by-owner').run(doc, [])).document;
    expect(byOwner.nodes.filter((n) => n.domain).map((n) => [n.id, n.domain])).toEqual([['web', 'Canales'], ['pedidos', 'Equipo Pedidos'], ['kafka', 'Plataforma']]);
    expect(act('group-by-owner').disabled!(byOwner, [])).toBeDefined();
    const out = ok(act('ungroup-domain').run(byOwner, ['domain:canales'])).document;
    expect(out.nodes.find((n) => n.id === 'web')).not.toHaveProperty('domain');
    expect(out.nodes.find((n) => n.id === 'kafka')?.domain).toBe('Plataforma');
    expect(act('ungroup-domain').disabled!(doc, ['web'])).toBeDefined();
  });

  it('«Patrón → nodo» pone el patrón como nodo intermedio y conserva el flujo y el orden', () => {
    const doc = base();
    const result = ok(act('expand-pattern').run(doc, ['pub']));
    const node = result.document.nodes.find((n) => n.id === result.id)!;
    expect(node).toMatchObject({ kind: 'pattern', pattern: 'publish-subscribe' });
    const [first, second] = ['pub', `${result.id}-topic`].map((id) => result.document.interactions.find((i) => i.id === id)!);
    expect(first).toMatchObject({ sourceId: 'pedidos', targetId: result.id, order: 20 });
    expect(first).not.toHaveProperty('pattern');
    expect(second).toMatchObject({ sourceId: result.id, targetId: 'topic', style: 'event', order: 20.5 });
    expect(result.document.flows[0].steps.map((s) => s.interactionId)).toEqual(['web-api', 'pub', `${result.id}-topic`, 'sub']);
    expect(validateIntegrationDocument(result.document).ok).toBe(true);
    expect(act('expand-pattern').disabled!(doc, ['sub'])).toBeDefined();
  });

  it('«Nodo → insignia» deshace «Patrón → nodo»', () => {
    const doc = base();
    const expanded = ok(act('expand-pattern').run(doc, ['pub']));
    const collapsed = ok(act('collapse-pattern').run(expanded.document, [expanded.id!])).document;
    expect(collapsed.nodes.map((n) => n.id)).toEqual(doc.nodes.map((n) => n.id));
    expect(collapsed.interactions.find((i) => i.id === 'pub')).toEqual(doc.interactions.find((i) => i.id === 'pub'));
    expect(collapsed.flows[0].steps.map((s) => s.interactionId)).toEqual(['web-api', 'pub', 'sub']);
  });

  it('un patrón entre dos canales no se pliega: unirlos directamente incumpliría las reglas', () => {
    const doc = parse({
      nodes: [
        { id: 'k', kind: 'broker', name: 'K' },
        { id: 'a', kind: 'topic', name: 'A', parentId: 'k' },
        { id: 'b', kind: 'topic', name: 'B', parentId: 'k' },
        { id: 'r', kind: 'pattern', name: 'Router', pattern: 'content-based-router' },
      ],
      interactions: [
        { id: 'a-r', sourceId: 'a', targetId: 'r', style: 'event' },
        { id: 'r-b', sourceId: 'r', targetId: 'b', style: 'event' },
      ],
    });
    const why = act('collapse-pattern').disabled!(doc, ['r']);
    expect(why).toContain('otro canal');
    expect(act('collapse-pattern').run(doc, ['r']).ok).toBe(false);
    expect(act('collapse-pattern').disabled!(base(), ['web'])).toBe('Selecciona un nodo de patrón.');
  });
});

describe('contratos como metadata de las figuras', () => {
  const attachments = editor.attachments!;

  it('lista los contratos con sus usos y detalla quién los usa', () => {
    const doc = base();
    expect(attachments.label).toBe('Contratos');
    expect(attachments.formats.map((f) => f.id)).toContain('cloudevents');
    expect(attachments.list(doc)).toEqual([{ id: 'openapi', name: 'API de pedidos', format: 'openapi', version: '2.1.0', uses: 1 }]);
    expect(attachments.read(doc, 'openapi')?.usedBy).toEqual([{ id: 'pedidos-api', name: 'API de pedidos', kind: 'api' }]);
    expect(attachments.read(doc, 'nada')).toBeUndefined();
  });

  it('recomienda un formato según el nodo o la interacción', () => {
    const doc = parse({
      nodes: [
        { id: 'a', kind: 'api', name: 'A', technology: 'gRPC' },
        { id: 'b', kind: 'api', name: 'B' },
        { id: 'm', kind: 'mcp', name: 'M' },
        { id: 't', kind: 'topic', name: 'T' },
        { id: 'u', kind: 'user', name: 'U' },
        { id: 's', kind: 'system', name: 'S' },
      ],
      interactions: [
        { id: 'i1', sourceId: 's', targetId: 'a', style: 'request-response', protocol: 'gRPC' },
        { id: 'i2', sourceId: 's', targetId: 'b', style: 'request-response', protocol: 'REST' },
        { id: 'i3', sourceId: 's', targetId: 't', style: 'event' },
        { id: 'i4', sourceId: 's', targetId: 'm', style: 'request-response', protocol: 'MCP' },
      ],
    });
    const suggest = (id: string) => attachments.suggestFormat!(doc, id);
    expect([suggest('a'), suggest('b'), suggest('m'), suggest('t'), suggest('u')]).toEqual(['protobuf', 'openapi', 'mcp', 'cloudevents', undefined]);
    expect([suggest('i1'), suggest('i2'), suggest('i3'), suggest('i4')]).toEqual(['protobuf', 'openapi', 'cloudevents', 'mcp']);
  });

  it('crea un contrato para un nodo, lo deja asignado y con una plantilla válida', () => {
    const doc = base();
    const created = ok(attachments.createFor!(doc, 'topic'));
    expect(doc.nodes.find((n) => n.id === 'topic')).not.toHaveProperty('contractId');
    const topic = created.document.nodes.find((n) => n.id === 'topic')!;
    expect(topic.contractId).toBe(created.id);
    const contract = created.document.contracts.find((c) => c.id === created.id)!;
    expect(contract.format).toBe('cloudevents');
    expect(contract.content).toContain('"specversion"');
    expect(attachments.check(contract.format, contract.content!).filter((d) => d.severity === 'error')).toEqual([]);
    expect(validateIntegrationDocument(created.document).ok).toBe(true);
    expect(attachments.createFor!(doc, 'nada').ok).toBe(false);
  });

  it('edita el texto y los datos, y borrar un contrato lo quita de quienes lo usaban', () => {
    const doc = base();
    const edited = ok(attachments.update(doc, 'openapi', { text: '{"openapi":"3.0.3"}', version: ' 3.0.0 ', description: 'Pedidos', name: 'Pedidos API' })).document;
    expect(edited.contracts[0]).toMatchObject({ name: 'Pedidos API', version: '3.0.0', description: 'Pedidos', content: '{"openapi":"3.0.3"}' });
    const cleared = ok(attachments.update(edited, 'openapi', { text: '', version: '' })).document;
    expect(cleared.contracts[0]).not.toHaveProperty('content');
    expect(cleared.contracts[0]).not.toHaveProperty('version');
    expect(attachments.update(doc, 'openapi', { format: 'inventado' }).ok).toBe(false);
    expect(attachments.update(doc, 'openapi', { name: '  ' }).ok).toBe(false);

    const removed = ok(attachments.remove(doc, 'openapi')).document;
    expect(removed.contracts).toEqual([]);
    expect(removed.nodes.find((n) => n.id === 'pedidos-api')).not.toHaveProperty('contractId');
    expect(validateIntegrationDocument(removed).ok).toBe(true);
  });

  it('añade un contrato nuevo con la plantilla de su formato', () => {
    const added = ok(attachments.add(base(), 'protobuf', 'Facturación'));
    const contract = added.document.contracts.find((c) => c.id === added.id)!;
    expect(contract).toMatchObject({ id: 'facturacion', format: 'protobuf', version: '1.0.0' });
    expect(contract.content).toContain('syntax = "proto3"');
    expect(attachments.add(base(), 'protobuf', ' ').ok).toBe(false);
    expect(attachments.add(base(), 'inventado', 'X').ok).toBe(false);
  });
});
