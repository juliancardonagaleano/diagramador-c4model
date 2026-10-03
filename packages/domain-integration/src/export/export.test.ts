import { layoutGraph, readableTextColor, shapeParts } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carryIntegration, generationJsonSchema, integrationAiSpec, systemPrompt, toGenerated } from '../ai/generation';
import { fromMermaid } from '../import/fromMermaid';
import { KIND_COLORS, NODE_SHAPES, NODE_SIZES } from '../notation';
import { PATTERN_INFO } from '../patterns';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { NODE_KINDS, PATTERNS, type IntegrationDocument } from '../types';
import { zoneColors } from '../zones';
import { toDrawio } from './drawio';
import { toMermaid } from './mermaid';
import { colorOf, layoutView, nodeLines, toSvg } from './render';

const parse = (input: unknown): IntegrationDocument => {
  const r = validateIntegrationDocument(input);
  if (!r.ok) throw new Error(formatIntegrationIssues(r.issues));
  return r.document;
};

const eip = parse({
  workspace: { name: 'Pedidos EIP' },
  nodes: [
    { id: 'cliente', kind: 'user', name: 'Cliente', domain: 'Canales' },
    { id: 'web', kind: 'system', name: 'Tienda web', technology: 'React', owner: 'Equipo Web', domain: 'Canales' },
    { id: 'gw', kind: 'gateway', name: 'API Gateway', technology: 'Kong', domain: 'Plataforma' },
    { id: 'reintentos', kind: 'queue', name: 'reintentos', parentId: 'gw' },
    { id: 'kafka', kind: 'broker', name: 'Kafka', domain: 'Plataforma' },
    { id: 'pedido-creado', kind: 'topic', name: 'pedido-creado', parentId: 'kafka' },
    { id: 'pedidos', kind: 'system', name: 'Pedidos', technology: 'Java', owner: 'Equipo Pedidos', domain: 'Ventas' },
    { id: 'pedidos-api', kind: 'api', name: 'API de pedidos', technology: 'REST', parentId: 'pedidos', contractId: 'pedidos-openapi' },
    { id: 'pedidos-mcp', kind: 'mcp', name: 'Herramientas de pedidos', parentId: 'pedidos', contractId: 'pedidos-mcp' },
    { id: 'ruta', kind: 'pattern', name: 'Enrutador por contenido', pattern: 'content-based-router' },
    { id: 'base', kind: 'store', name: 'Base de pedidos', technology: 'PostgreSQL', domain: 'Ventas' },
    { id: 'cierre', kind: 'scheduler', name: 'Cierre diario' },
    { id: 'erp', kind: 'connector', name: 'Conector ERP', domain: 'Ventas' },
    { id: 'pagos', kind: 'system', name: 'Pasarela de pagos', external: true },
  ],
  contracts: [
    { id: 'pedidos-openapi', name: 'API de pedidos', format: 'openapi', version: '2.1.0', content: 'openapi: 3.1.0' },
    { id: 'pedidos-mcp', name: 'Herramientas', format: 'mcp' },
  ],
  interactions: [
    { id: 'i1', sourceId: 'cliente', targetId: 'web', style: 'request-response', description: 'Compra', order: 1 },
    { id: 'i2', sourceId: 'web', targetId: 'gw', style: 'request-response', protocol: 'HTTPS', description: 'Crea el pedido', order: 2, pattern: 'circuit-breaker' },
    { id: 'i3', sourceId: 'gw', targetId: 'pedidos-api', style: 'request-response', protocol: 'REST', order: 3 },
    { id: 'i4', sourceId: 'pedidos', targetId: 'base', style: 'request-response', protocol: 'JDBC', order: 4 },
    { id: 'i5', sourceId: 'pedidos', targetId: 'pedido-creado', style: 'event', protocol: 'Kafka', description: 'Publica PedidoCreado', order: 5 },
    { id: 'i6', sourceId: 'pedido-creado', targetId: 'ruta', style: 'event', order: 6 },
    { id: 'i7', sourceId: 'ruta', targetId: 'erp', style: 'async-message', pattern: 'message-translator', description: 'Factura' },
    { id: 'i8', sourceId: 'cierre', targetId: 'pedidos-api', style: 'batch', description: 'Cierra el día' },
    { id: 'i9', sourceId: 'erp', targetId: 'pagos', style: 'request-response', protocol: 'HTTPS' },
    { id: 'i10', sourceId: 'reintentos', targetId: 'pedidos', style: 'async-message' },
    { id: 'i11', sourceId: 'pedidos-mcp', targetId: 'pedidos-api', style: 'request-response' },
  ],
  flows: [{ id: 'comprar', name: 'Comprar', steps: [{ interactionId: 'i1' }, { interactionId: 'i2' }, { interactionId: 'i3' }] }],
});

const inside = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

describe('iconos de los patrones', () => {
  const ALLOWED = new Set('MLHVAQCZ');
  const icons = PATTERNS.map((p) => [p, PATTERN_INFO[p].icon] as const);

  it('hay un icono por patrón, de solo trazo, con comandos permitidos y coordenadas dentro de la caja de 16 × 16', () => {
    expect(icons).toHaveLength(18);
    for (const [pattern, icon] of icons) {
      expect(icon.length, pattern).toBeGreaterThan(0);
      for (const d of icon) {
        expect(d, pattern).toMatch(/^M/);
        const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
        expect(tokens.join(' ').length, pattern).toBeGreaterThan(0);
        for (const token of tokens) {
          if (/[A-Za-z]/.test(token)) expect(ALLOWED.has(token), `${pattern}: comando ${token}`).toBe(true);
          else expect(Number(token) >= 0 && Number(token) <= 16, `${pattern}: coordenada ${token}`).toBe(true);
        }
      }
    }
  });

  it('no hay dos iconos iguales', () => {
    expect(new Set(icons.map(([, icon]) => icon.join('|'))).size).toBe(icons.length);
  });
});

describe('SVG', () => {
  it('dibuja las zonas por dominio con sus colores y las anida: zona ⊃ contenedor ⊃ hijo', async () => {
    const { layout, zones, parents } = await layoutView(eip);
    expect(zones.map((z) => z.name).sort()).toEqual(['Canales', 'Plataforma', 'Ventas']);
    const box = (id: string) => [...layout.groups, ...layout.nodes].find((b) => b.id === id)!;
    const ventas = zones.find((z) => z.name === 'Ventas')!;
    expect(parents.get('pedidos')).toBe(ventas.id);
    expect(parents.get('pedidos-api')).toBe('pedidos');
    expect(inside(box(ventas.id), box('pedidos'))).toBe(true);
    expect(inside(box('pedidos'), box('pedidos-api'))).toBe(true);
    expect(inside(box(ventas.id), box('base'))).toBe(true);
    // Una zona va antes que lo que contiene, para que no lo tape.
    const order = layout.groups.map((g) => g.id);
    expect(order.indexOf(ventas.id)).toBeLessThan(order.indexOf('pedidos'));

    const svg = await toSvg(eip);
    for (const zone of zones) expect(svg).toContain(`>Dominio: ${zone.name}</text>`);
    const colors = zoneColors('Ventas');
    expect(svg).toContain(`fill="${colors.fill}" stroke="${colors.stroke}"`);
    expect(svg).toContain('Sistema: Pedidos');
    expect(svg).toContain('Pasarela: API Gateway');
  });

  it('una zona vacía no rompe el autolayout', async () => {
    const layout = await layoutGraph([{ id: 'a', width: 100, height: 50, groupId: 'z' }], [], [{ id: 'z' }, { id: 'vacia' }]);
    expect(layout.groups.map((g) => g.id).sort()).toEqual(['vacia', 'z']);
    expect(layout.groups.every((g) => g.width > 0 && g.height > 0)).toBe(true);
  });

  it('sin dominios no hay zonas', async () => {
    const plain = parse({ nodes: [{ id: 'a', kind: 'system', name: 'A' }, { id: 'b', kind: 'system', name: 'B' }], interactions: [{ id: 'ab', sourceId: 'a', targetId: 'b', style: 'event' }] });
    expect(await toSvg(plain)).not.toContain('Dominio:');
  });

  it('las insignias de la línea llevan el número de paso y el icono del patrón; el texto ya no lleva el número', async () => {
    const svg = await toSvg(eip);
    expect(svg).toContain('<title>Paso 2</title>');
    expect(svg).toMatch(/<circle [^>]*\/><text [^>]*>2<\/text>/);
    expect(svg).toContain(`<title>${PATTERN_INFO['circuit-breaker'].label}</title>`);
    for (const d of PATTERN_INFO['circuit-breaker'].icon) expect(svg).toContain(`d="${d}"`);
    for (const d of PATTERN_INFO['message-translator'].icon) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain('>Crea el pedido [HTTPS]</text>');
    expect(svg).not.toContain('2. Crea el pedido');
  });

  it('una línea sin descripción conserva la insignia y las demás se dibujan sin número', async () => {
    const svg = await toSvg(eip);
    expect(svg).toContain('<title>Paso 6</title>');
    expect(svg).not.toContain('<title>Paso 7</title>');
    expect(svg).toContain('>Cierra el día</text>');
  });

  it('cada tipo de nodo se dibuja con su figura y al tamaño de la notación', async () => {
    const { layout, nodes } = await layoutView(eip);
    const svg = await toSvg(eip);
    expect(new Set([...nodes.values()].map((n) => n.kind))).toEqual(new Set(NODE_KINDS));
    for (const box of layout.nodes) {
      const kind = nodes.get(box.id)!.kind;
      expect([box.width, box.height], kind).toEqual([NODE_SIZES[kind].width, NODE_SIZES[kind].height]);
      for (const part of shapeParts(NODE_SHAPES[kind], box.width, box.height)) expect(svg, kind).toContain(`d="${part.d}"`);
    }
  });

  it('los nodos de patrón muestran su nombre y la etiqueta del patrón; el contrato ocupa el lugar de la tercera línea', () => {
    const byId = (id: string) => eip.nodes.find((n) => n.id === id)!;
    expect(nodeLines(eip, { ...byId('ruta'), name: 'Rutas de pedido' })).toEqual(['Rutas de pedido', 'Enrutador por contenido']);
    expect(nodeLines(eip, byId('ruta'))).toEqual(['Enrutador por contenido']);
    expect(nodeLines(eip, byId('pedidos-api'))).toEqual(['API de pedidos', 'REST', 'openapi 2.1.0']);
    expect(nodeLines(eip, byId('pedidos-mcp'))).toEqual(['Herramientas de pedidos', 'mcp']);
    expect(nodeLines(eip, byId('web'))).toEqual(['Tienda web', 'React', 'Responsable: Equipo Web']);
    expect(nodeLines(eip, { ...byId('pedidos-api'), owner: 'Equipo API' })).toHaveLength(3);
  });

  it('la vista de un sistema muestra el sistema, lo que contiene y sus vecinos, con los pasos numerados entre sus líneas', async () => {
    const svg = await toSvg(eip, 'system:pedidos');
    expect(svg).toContain('Sistema - Pedidos');
    expect(svg).toContain('Sistema: Pedidos');
    for (const name of ['API de pedidos', 'Herramientas de pedidos', 'Base de pedidos', 'API Gateway', 'Cierre diario', 'reintentos']) expect(svg).toContain(name);
    expect(svg).not.toContain('Tienda web');
    expect(svg).toContain('<title>Paso 1</title>');
  });

  it('el texto de cada nodo es legible sobre su fondo: oscuro sobre los claros y blanco sobre los oscuros', async () => {
    expect(readableTextColor('#fde68a')).toBe('#0b1f33');
    expect(readableTextColor('#ffffff')).toBe('#0b1f33');
    expect(readableTextColor('#1168bd')).toBe('#ffffff');
    expect(readableTextColor('rgb(1, 2, 3)')).toBe('#ffffff');
    const svg = await toSvg(eip);
    expect(svg).toContain(`fill="${readableTextColor(colorOf(eip.nodes.find((n) => n.id === 'web')!))}" font-weight="700">Tienda web</text>`);
  });

  describe('con un tipo de fondo claro', () => {
    afterEach(() => {
      vi.doUnmock('../notation');
      vi.resetModules();
    });

    it('el almacén lleva texto oscuro y los demás, blanco', async () => {
      vi.resetModules();
      vi.doMock('../notation', async () => {
        const actual = await vi.importActual<typeof import('../notation')>('../notation');
        return { ...actual, KIND_COLORS: { ...actual.KIND_COLORS, store: '#fde68a' } };
      });
      const { toSvg: toLightSvg } = await import('./render');
      const svg = await toLightSvg(eip);
      expect(svg).toContain('fill="#0b1f33" font-weight="700">Base de pedidos</text>');
      expect(svg).toContain('fill="#ffffff" font-weight="700">Tienda web</text>');
    });
  });
});

describe('draw.io', () => {
  const read = async (doc: IntegrationDocument) => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(doc));
    const pages = ([] as Array<Record<string, any>>).concat(parsed.mxfile.diagram);
    const cells = (page: number): Array<Record<string, string>> => ([] as Array<Record<string, string>>).concat(pages[page].mxGraphModel.root.mxCell);
    return { pages, cells };
  };

  it('una página por vista, con las zonas como celdas de grupo con sus colores y los nodos dentro de ellas', async () => {
    const { pages, cells } = await read(eip);
    expect(pages.map((p) => p['@_id'])).toEqual(['map', 'flow:comprar', 'system:web', 'system:pedidos', 'system:pagos']);
    const map = cells(0);
    const ids = new Set(map.map((c) => c['@_id']));
    const zone = map.find((c) => c['@_value'] === 'Dominio: Ventas')!;
    const colors = zoneColors('Ventas');
    expect(zone['@_style']).toContain(`fillColor=${colors.fill};strokeColor=${colors.stroke};`);
    expect(zone['@_style']).toContain('container=1');
    expect(zone['@_parent']).toBe('1');
    const pedidos = map.find((c) => c['@_id'] === 'n-pedidos')!;
    expect(pedidos['@_parent']).toBe(zone['@_id']);
    expect(map.find((c) => c['@_id'] === 'n-pedidos-api')!['@_parent']).toBe('n-pedidos');
    expect(map.find((c) => c['@_id'] === 'n-base')!['@_parent']).toBe(zone['@_id']);
    expect(map.find((c) => c['@_id'] === 'n-pagos')!['@_parent']).toBe('1');
    for (const c of map) {
      if (c['@_parent']) expect(ids.has(c['@_parent']), c['@_id']).toBe(true);
      if (c['@_source']) expect(ids.has(c['@_source']) && ids.has(c['@_target']), c['@_id']).toBe(true);
    }
  });

  it('las figuras, los textos de los nodos y los de las líneas llevan paso, patrón y contrato', async () => {
    const { cells } = await read(eip);
    const map = cells(0);
    const style = (id: string) => map.find((c) => c['@_id'] === id)!['@_style'];
    const value = (id: string) => map.find((c) => c['@_id'] === id)!['@_value'];
    expect(style('n-ruta')).toContain('rhombus');
    expect(style('n-pedidos-api')).toContain('shape=hexagon');
    expect(style('n-gw')).toContain('container=1'); // con colas dentro es un grupo
    expect(await toDrawio(parse({ nodes: [{ id: 'g', kind: 'gateway', name: 'G' }] }))).toContain('shape=step');
    expect(style('n-cierre')).toContain('ellipse');
    expect(style('n-cliente')).toContain('umlActor');
    expect(style('n-cliente')).toContain('fontColor=#0f172a');
    expect(style('n-web')).toContain('fontColor=#ffffff');
    expect(value('n-pedidos-api')).toContain('openapi 2.1.0');
    expect(value('n-ruta')).toBe('<b>Enrutador por contenido</b>');
    expect(value('e-i2')).toBe(`2. Crea el pedido [HTTPS] «${PATTERN_INFO['circuit-breaker'].label}»`);
    expect(value('e-i7')).toBe(`Factura «${PATTERN_INFO['message-translator'].label}»`);
    expect(value('e-i1')).toBe('1. Compra');
  });
});

describe('Mermaid', () => {
  const map = toMermaid(eip);

  it('dibuja una forma por tipo, un subgraph por zona con el contenedor dentro y el patrón tras la descripción', () => {
    expect(map.startsWith('flowchart LR')).toBe(true);
    expect(map).toContain('    subgraph domain_ventas["Dominio: Ventas"]');
    expect(map).toContain('        subgraph pedidos["Sistema: Pedidos"]');
    expect(map).toContain('            pedidos_api{{"API de pedidos<br/>REST"}}');
    expect(map).toContain('pedido_creado(["pedido-creado<br/>«Tópico»"])');
    expect(map).toContain('base[("Base de pedidos<br/>PostgreSQL")]');
    expect(map).toContain('erp("Conector ERP<br/>«Conector»")');
    expect(map).toContain('cierre((("Cierre diario<br/>«Tarea programada»")))');
    expect(map).toContain('cliente(("Cliente<br/>«Usuario final»"))');
    expect(map).toContain('pedidos_mcp[/"Herramientas de pedidos<br/>«Servidor MCP»"/]');
    expect(map).toContain('ruta{"Enrutador por contenido<br/>«Enrutador por contenido»"}');
    expect(map).toContain('subgraph gw["Pasarela: API Gateway"]');
    expect(map).toContain(`web -->|"2. Crea el pedido [HTTPS] «${PATTERN_INFO['circuit-breaker'].label}»"| gw`);
    expect(map).toContain('==>|"6."| ruta');
    expect(map.match(/\bsubgraph\b/g)).toHaveLength(map.match(/^\s*end$/gm)!.length);
  });

  it('vuelve a importarse con sus tipos, zonas, padres, patrones y orden', () => {
    const { document: back, warnings } = fromMermaid(map);
    expect(warnings).toEqual([]);
    const byName = (name: string) => back.nodes.find((n) => n.name === name)!;
    for (const n of eip.nodes) {
      const got = byName(n.name);
      expect(got, n.name).toBeDefined();
      expect(got.kind, n.name).toBe(n.kind);
      expect(got.pattern, n.name).toBe(n.pattern);
      expect(got.domain, n.name).toBe(n.domain);
      expect(got.parentId && back.nodes.find((p) => p.id === got.parentId)!.name, n.name).toBe(n.parentId && eip.nodes.find((p) => p.id === n.parentId)!.name);
    }
    expect(back.nodes).toHaveLength(eip.nodes.length);
    expect(back.interactions).toHaveLength(eip.interactions.length);
    const name = (id: string) => back.nodes.find((n) => n.id === id)!.name;
    const edge = (from: string, to: string) => back.interactions.find((i) => name(i.sourceId) === from && name(i.targetId) === to)!;
    expect(edge('Tienda web', 'API Gateway')).toMatchObject({ order: 2, pattern: 'circuit-breaker', description: 'Crea el pedido [HTTPS]', style: 'request-response' });
    expect(edge('Enrutador por contenido', 'Conector ERP')).toMatchObject({ pattern: 'message-translator', description: 'Factura', style: 'async-message' });
    expect(edge('Enrutador por contenido', 'Conector ERP').order).toBeUndefined();
    expect(edge('pedido-creado', 'Enrutador por contenido')).toMatchObject({ order: 6, style: 'event' });
  });

  it('un subgraph «Dominio: X» es una zona, y el tipo del título manda sobre lo que se deduzca del contenido', () => {
    const { document, warnings } = fromMermaid(`flowchart LR
      subgraph z["Dominio: Pagos"]
        a[Cobros]
        subgraph kong["Pasarela: Kong"]
          q(["cola"])
          t(["tema<br/>«Tópico»"])
        end
      end
      b[Fuera] --> a
      kong ==> b
    `);
    const byName = (n: string) => document.nodes.find((x) => x.name === n)!;
    expect(warnings).toEqual([]);
    expect(byName('Cobros')).toMatchObject({ kind: 'system', domain: 'Pagos' });
    expect(byName('Kong')).toMatchObject({ kind: 'gateway', domain: 'Pagos' });
    expect(byName('cola')).toMatchObject({ kind: 'queue', parentId: byName('Kong').id });
    expect(byName('tema')).toMatchObject({ kind: 'topic', parentId: byName('Kong').id });
    expect(byName('cola').domain).toBeUndefined();
    expect(byName('Fuera').domain).toBeUndefined();
    expect(document.nodes.some((n) => n.name.startsWith('Dominio'))).toBe(false);
    expect(document.interactions).toHaveLength(2);
  });

  it('un nodo sin forma conocida ni marca sigue siendo un sistema, y una marca de patrón sin tipo lo hace nodo de patrón', () => {
    const { document } = fromMermaid(`flowchart LR
      a{{"Algo"}} --> b{"Decide<br/>«Filtro»"}
      b --> c[Otro<br/>«Etiqueta libre»]
    `);
    expect(document.nodes.map((n) => [n.name, n.kind, n.pattern, n.description])).toEqual([
      ['Algo', 'system', undefined, undefined],
      ['Decide', 'pattern', 'filter', undefined],
      ['Otro', 'system', undefined, '«Etiqueta libre»'],
    ]);
  });

  it('el flujo es un sequenceDiagram con el usuario como actor, y vuelve a importarse', () => {
    const seq = toMermaid(eip, { viewId: 'flow:comprar' });
    expect(seq.startsWith('sequenceDiagram')).toBe(true);
    expect(seq).toContain('actor cliente as Cliente');
    expect(seq).toContain('participant web as Tienda web');
    expect(seq).toContain(`web->>gw: 2. Crea el pedido [HTTPS] «${PATTERN_INFO['circuit-breaker'].label}»`);
    const back = fromMermaid(seq).document;
    expect(back.nodes.find((n) => n.name === 'Cliente')!.kind).toBe('user');
    expect(back.nodes.find((n) => n.name === 'Tienda web')!.kind).toBe('system');
    expect(back.interactions.find((i) => i.description === 'Crea el pedido [HTTPS]')).toMatchObject({ pattern: 'circuit-breaker' });
    expect(back.flows[0].steps).toHaveLength(3);
  });
});

describe('IA', () => {
  it('el prompt describe los tipos nuevos, todos los patrones y las reglas de las interacciones', () => {
    const prompt = systemPrompt();
    for (const kind of ['connector', 'scheduler', 'user', 'mcp', 'pattern']) expect(prompt).toContain(`"${kind}"`);
    for (const fragment of [
      'adapta un sistema o un almacén a un canal',
      'Solo es origen',
      'servidor MCP',
      'su parentId es el id del sistema',
      'broker O de la pasarela',
      'campo "pattern" es obligatorio',
      'Un almacén nunca es origen',
      'conectes un canal con otro directamente',
      'Un productor publica EN la cola',
      'lee DE ella',
      'order: lugar en la secuencia (1, 2, 3…)',
      'domain: zona',
      'sin su contenido',
    ]) {
      expect(prompt, fragment).toContain(fragment);
    }
    for (const p of PATTERNS) expect(prompt).toContain(`${p}: ${PATTERN_INFO[p].label}`);
  });

  it('el esquema del modelo trae contractId, pattern, domain y order, y los contratos no llevan contenido', () => {
    const schema = generationJsonSchema() as { properties: Record<string, { items: { properties: Record<string, unknown>; required: string[] } }> };
    const { nodes, contracts, interactions } = schema.properties;
    for (const field of ['contractId', 'pattern', 'domain']) {
      expect(nodes.items.properties).toHaveProperty(field);
      expect(nodes.items.required).toContain(field);
    }
    expect(interactions.items.properties).toHaveProperty('order');
    expect(interactions.items.required).toContain('order');
    expect(contracts.items.properties).not.toHaveProperty('content');
    expect(Object.keys(contracts.items.properties)).toEqual(['id', 'name', 'format', 'version', 'url', 'description']);
  });

  it('lo que sale del modelo con los campos nuevos se convierte en documento, y el documento vuelve al modelo sin el contenido de los contratos', () => {
    const generated = toGenerated(eip);
    expect(integrationAiSpec.generationSchema.safeParse(generated).success).toBe(true);
    expect(generated.nodes.find((n) => n.id === 'ruta')).toMatchObject({ pattern: 'content-based-router', domain: null, contractId: null });
    expect(generated.nodes.find((n) => n.id === 'pedidos-api')).toMatchObject({ contractId: 'pedidos-openapi' });
    expect(generated.interactions.find((i) => i.id === 'i2')).toMatchObject({ order: 2, pattern: 'circuit-breaker' });
    expect(generated.interactions.find((i) => i.id === 'i7')?.order).toBeNull();
    expect(JSON.stringify(generated)).not.toContain('openapi: 3.1.0');
    const refine = integrationAiSpec.user('Añade una cola', eip);
    expect(refine).not.toContain('openapi: 3.1.0');
    expect(refine).toContain('"pedidos-openapi"');
    expect(refine).toContain('se conserva solo para los ids que sigas usando');

    const back = integrationAiSpec.toDocument(generated);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.document.nodes).toEqual(eip.nodes);
      expect(back.document.interactions).toEqual(eip.interactions);
      expect(back.document.contracts.map((c) => c.content)).toEqual([undefined, undefined]);
    }
  });

  it('al refinar se conservan el contenido de los contratos y lo que el modelo no genera, solo para los ids que siguen existiendo', () => {
    const base = parse({
      ...eip,
      nodes: eip.nodes.map((n) => (n.id === 'web' ? { ...n, tags: ['crítico'], ref: 'urn:iark:c4:tienda' } : n)),
      contracts: [...eip.contracts, { id: 'viejo', name: 'Viejo', format: 'avro', content: '{"type":"record"}' }],
    });
    const model = toGenerated(base);
    model.contracts = model.contracts.filter((c) => c.id !== 'viejo');
    model.contracts.push({ id: 'nuevo', name: 'Nuevo', format: 'asyncapi', version: null, url: null, description: null });
    model.nodes = model.nodes.map((n) => (n.id === 'web' ? { ...n, name: 'Tienda en línea', domain: null } : n));
    const refined = integrationAiSpec.toDocument(model);
    expect(refined.ok).toBe(true);
    if (!refined.ok) return;

    const carried = integrationAiSpec.carry!(base, refined.document);
    expect(carried).toEqual(carryIntegration(base, refined.document));
    const contract = (id: string) => carried.contracts.find((c) => c.id === id);
    expect(contract('pedidos-openapi')?.content).toBe('openapi: 3.1.0');
    expect(contract('viejo')).toBeUndefined();
    expect(contract('nuevo')?.content).toBeUndefined();
    const web = carried.nodes.find((n) => n.id === 'web')!;
    expect(web).toMatchObject({ name: 'Tienda en línea', tags: ['crítico'], ref: 'urn:iark:c4:tienda' });
    expect(web.domain).toBeUndefined(); // lo que el modelo sí genera manda: aquí lo quitó
    expect(validateIntegrationDocument(carried).ok).toBe(true);
    expect(carryIntegration(base, base)).toEqual(base);
  });
});

describe('colores de los nodos', () => {
  it('colorOf usa el color del tipo y el gris de los externos', () => {
    expect(colorOf(eip.nodes.find((n) => n.id === 'web')!)).toBe(KIND_COLORS.system);
    expect(colorOf(eip.nodes.find((n) => n.id === 'pagos')!)).toBe('#6b6b6b');
  });
});
