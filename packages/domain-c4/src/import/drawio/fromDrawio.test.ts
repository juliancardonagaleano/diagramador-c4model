import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyFill, parseC4TypeLabel } from '../../export/drawio/styles';
import { toDrawio } from '../../export/drawio/toDrawio';
import { autoLayoutDocument } from '../../layout/elkLayout';
import { sampleDocument } from '../../model/sample';
import { validateDocument } from '../../model/schema';
import type { C4Document } from '../../model/types';
import { DrawioImportError, fromDrawio } from './fromDrawio';

// ───────────── Constructores de XML de draw.io para los casos de prueba ─────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const attrs = (o: Record<string, string | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${esc(v!)}"`)
    .join(' ');

interface ShapeOpts {
  value?: string;
  style?: string;
  parent?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  props?: Record<string, string>;
  extra?: Record<string, string>;
}

function shape(id: string, o: ShapeOpts = {}): string {
  const geometry = `<mxGeometry x="${o.x ?? 0}" y="${o.y ?? 0}" width="${o.w ?? 120}" height="${o.h ?? 60}" as="geometry"/>`;
  const cellAttrs = attrs({ style: o.style ?? 'rounded=1;whiteSpace=wrap;html=1;', vertex: '1', parent: o.parent ?? '1', ...o.extra });
  if (o.props) {
    return `<object ${attrs({ ...o.props, label: o.value, id })}><mxCell ${cellAttrs}>${geometry}</mxCell></object>`;
  }
  return `<mxCell ${attrs({ id, value: o.value ?? '' })} ${cellAttrs}>${geometry}</mxCell>`;
}

function arrow(id: string, source: string | undefined, target: string | undefined, o: { value?: string; parent?: string; props?: Record<string, string> } = {}): string {
  const cellAttrs = attrs({ style: 'edgeStyle=orthogonalEdgeStyle;html=1;', edge: '1', parent: o.parent ?? '1', source, target });
  const geometry = '<mxGeometry relative="1" as="geometry"/>';
  if (o.props) return `<object ${attrs({ ...o.props, label: o.value, id })}><mxCell ${cellAttrs}>${geometry}</mxCell></object>`;
  return `<mxCell ${attrs({ id, value: o.value ?? '' })} ${cellAttrs}>${geometry}</mxCell>`;
}

function page(name: string, id: string, cells: string[]): string {
  return `<diagram id="${id}" name="${esc(name)}"><mxGraphModel dx="0" dy="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram>`;
}

const file = (...pages: string[]) => `<mxfile host="app.diagrams.net">${pages.join('')}</mxfile>`;

// Estilos y etiquetas de la librería C4 de draw.io.
const C4_BOX = (fill: string) => `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};fontColor=#ffffff;strokeColor=#000000;metaEdit=1;`;
const C4_LABEL = '<b>%c4Name%</b><div>[%c4Type%]</div><br><div>%c4Description%</div>';
const c4 = (name: string, type: string, extra: Record<string, string> = {}) => ({ placeholders: '1', c4Name: name, c4Type: type, ...extra });

async function deflateBase64(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(encodeURIComponent(text))]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return Buffer.from(await new Response(stream).arrayBuffer()).toString('base64');
}

/** Sustituye el `<mxGraphModel>` de cada página por su versión comprimida, como guarda draw.io con "Comprimido" activo. */
async function compressPages(xml: string): Promise<string> {
  let out = xml;
  for (const m of [...xml.matchAll(/<mxGraphModel[\s\S]*?<\/mxGraphModel>/g)]) out = out.replace(m[0], await deflateBase64(m[0]));
  return out;
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));

// ───────────── Pruebas ─────────────

describe('parseC4TypeLabel / classifyFill', () => {
  it('reconoce los c4Type de draw.io y de este exportador en ambos idiomas', () => {
    expect(parseC4TypeLabel('Person')).toEqual({ kind: 'person', external: false });
    expect(parseC4TypeLabel('External Person')).toEqual({ kind: 'person', external: true });
    expect(parseC4TypeLabel('Sistema de software')).toEqual({ kind: 'softwareSystem', external: false });
    expect(parseC4TypeLabel('External System')?.external).toBe(true);
    expect(parseC4TypeLabel('Componente')?.kind).toBe('component');
    expect(parseC4TypeLabel('Container Scope Boundary')?.kind).toBe('boundary-container');
    expect(parseC4TypeLabel('Límite del sistema')?.kind).toBe('boundary-softwareSystem');
    expect(parseC4TypeLabel('Enterprise Boundary')?.kind).toBe('boundary-other');
    expect(parseC4TypeLabel('Relación')?.kind).toBe('relationship');
    expect(parseC4TypeLabel('ExecutionEnvironment')).toBeNull();
    expect(parseC4TypeLabel('')).toBeNull();
  });

  it('distingue relleno estándar, externo y personalizado', () => {
    expect(classifyFill('container', '#23A2D9')).toBe('internal');
    expect(classifyFill('container', '#438dd5')).toBe('internal'); // canónico de c4model.com, en minúsculas
    expect(classifyFill('softwareSystem', '#8c8496')).toBe('external');
    expect(classifyFill('container', '#FF8800')).toBe('custom');
  });
});

describe('fromDrawio: round-trip con toDrawio', () => {
  const roundTrip = async (doc: C4Document, notation: 'c4' | 'card') => {
    const laid = await autoLayoutDocument(doc);
    const result = await fromDrawio(toDrawio(laid, { notation }));
    return { laid, ...result };
  };

  it('recupera el modelo, las vistas y las posiciones de un .drawio exportado (notación C4)', async () => {
    const { laid, document, warnings } = await roundTrip(sampleDocument, 'c4');
    expect(warnings).toEqual([]);
    expect(validateDocument(document).ok).toBe(true);

    const imported = byId(document.model.elements);
    expect(imported.size).toBe(sampleDocument.model.elements.length);
    for (const original of sampleDocument.model.elements) expect(imported.get(original.id), original.id).toEqual(original);

    const rels = byId(document.model.relationships);
    expect(rels.size).toBe(sampleDocument.model.relationships.length);
    for (const original of sampleDocument.model.relationships) expect(rels.get(original.id), original.id).toEqual(original);

    expect(document.views.map((v) => ({ id: v.id, title: v.title, type: v.type, scopeId: v.scopeId }))).toEqual(
      sampleDocument.views.map((v) => ({ id: v.id, title: v.title, type: v.type, scopeId: v.scopeId })),
    );
    for (const view of laid.views) {
      const got = byId(document.views.find((v) => v.id === view.id)!.elements);
      expect([...got.keys()].sort()).toEqual(view.elements.map((e) => e.id).sort());
      for (const e of view.elements) {
        expect(got.get(e.id)?.x, `${view.id}/${e.id}.x`).toBeCloseTo(e.x!, 0);
        expect(got.get(e.id)?.y, `${view.id}/${e.id}.y`).toBeCloseTo(e.y!, 0);
        expect(got.get(e.id)?.width).toBe(e.width);
        expect(got.get(e.id)?.height).toBe(e.height);
      }
    }
  });

  it('también con la notación de tarjetas (color y "externo" salen de la franja; navegador y móvil no se distinguen)', async () => {
    const { document, warnings } = await roundTrip(sampleDocument, 'card');
    expect(warnings).toEqual([]);
    const imported = byId(document.model.elements);
    for (const original of sampleDocument.model.elements) {
      const { shape, ...rest } = original;
      const got = imported.get(original.id)!;
      if (shape === 'browser' || shape === 'mobile') expect(got, original.id).toEqual(rest);
      else expect(got, original.id).toEqual(original);
    }
    expect(document.views.map((v) => v.scopeId)).toEqual(['banca', 'banca', 'api']);
  });

  it.each(['c4', 'card'] as const)('conserva el color propio de un elemento (%s)', async (notation) => {
    const doc = structuredClone(sampleDocument);
    doc.model.elements.find((e) => e.id === 'api')!.color = '#ff8800';
    doc.model.elements.find((e) => e.id === 'cliente')!.color = '#11AA33';
    const { document } = await roundTrip(doc, notation);
    expect(document.model.elements.find((e) => e.id === 'api')?.color).toBe('#ff8800');
    expect(document.model.elements.find((e) => e.id === 'cliente')?.color).toBe('#11AA33');
    expect(document.model.elements.find((e) => e.id === 'db')?.color).toBeUndefined();
  });

  it('conserva los ids aunque el .drawio venga de una versión anterior (ids sin prefijo el-/rel-)', async () => {
    const { document } = await fromDrawio(readFileSync('examples/banca-c4.drawio', 'utf8'));
    expect(document.model.elements.map((e) => e.id).sort()).toEqual(sampleDocument.model.elements.map((e) => e.id).sort());
    expect(document.model.relationships.map((r) => r.id).sort()).toEqual(sampleDocument.model.relationships.map((r) => r.id).sort());
    expect(document.views.map((v) => v.id)).toEqual(['contexto', 'contenedores', 'componentes-api']);
  });

  it('una flecha implícita (extremo oculto por su ancestro) recupera su relación original', async () => {
    const doc = structuredClone(sampleDocument);
    doc.model.relationships = doc.model.relationships.filter((r) => r.id !== 'r1'); // r5 (cliente → web-app) pasa a ser la flecha implícita cliente → banca
    doc.views = doc.views.filter((v) => v.id === 'contexto');
    const laid = await autoLayoutDocument(doc);
    const xml = toDrawio(laid);
    expect(xml).toContain('rel-r5@cliente-&gt;banca');
    const { document } = await fromDrawio(xml);
    const r5 = document.model.relationships.find((r) => r.id === 'r5');
    expect(r5).toMatchObject({ sourceId: 'cliente', targetId: 'banca', description: 'Visita bigbank.com', technology: 'HTTPS' });
  });

  it('el texto con saltos de línea y caracteres especiales sobrevive al viaje', async () => {
    const doc = structuredClone(sampleDocument);
    doc.model.elements[0].name = 'Cliente <"VIP"> & más';
    doc.model.elements[0].description = 'Primera línea\nSegunda línea';
    const laid = await autoLayoutDocument(doc);
    const { document } = await fromDrawio(toDrawio(laid, { viewIds: ['contexto'] }));
    const cliente = document.model.elements.find((e) => e.id === 'cliente')!;
    expect(cliente.name).toBe('Cliente <"VIP"> & más');
    expect(cliente.description).toBe('Primera línea\nSegunda línea');
  });
});

describe('fromDrawio: contenedor del archivo', () => {
  it('lee páginas comprimidas (base64 + deflate sin cabecera) igual que las sin comprimir', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const xml = toDrawio(laid);
    const compressed = await compressPages(xml);
    expect(compressed).not.toContain('<mxGraphModel');
    const plain = await fromDrawio(xml);
    const packed = await fromDrawio(compressed);
    expect(packed.warnings).toEqual([]);
    expect(packed.document).toEqual(plain.document);
  });

  it('acepta un <mxGraphModel> suelto (Extras ▸ Editar diagrama) y BOM inicial', async () => {
    const cells = [shape('A', { value: 'Alfa', x: 10, y: 20 }), shape('B', { value: 'Beta', x: 200, y: 20 }), arrow('E', 'A', 'B', { value: 'Envía' })];
    const bare = `﻿<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
    const { document } = await fromDrawio(bare, { name: 'Suelto' });
    expect(document.workspace.name).toBe('Suelto');
    expect(document.model.elements.map((e) => e.name)).toEqual(['Alfa', 'Beta']);
    expect(document.model.relationships).toMatchObject([{ sourceId: 'alfa', targetId: 'beta', description: 'Envía' }]);
    expect(document.views).toHaveLength(1);
  });

  it('el nombre por defecto es "Diagrama C4"', async () => {
    const { document } = await fromDrawio(file(page('P', 'p', [shape('a', { value: 'Alfa' })])));
    expect(document.workspace.name).toBe('Diagrama C4');
  });
});

describe('fromDrawio: librería C4 de draw.io (ids aleatorios)', () => {
  const contexto = page('Contexto', 'Xy7Zq2LmN0pQrStUvWx-1', [
    shape('Ab-1', { props: c4('Cliente', 'Person', { c4Description: 'Usa el sistema' }), value: C4_LABEL, style: 'shape=mxgraph.c4.person2;html=1;fillColor=#083F75;strokeColor=#06315C;fontColor=#ffffff;', x: 300, y: 40, w: 200, h: 180 }),
    shape('Ab-2', { props: c4('Tienda', 'Software System', { c4Description: 'Vende cosas', link: 'data:page/id,Zz9-detalle' }), value: C4_LABEL, style: C4_BOX('#1061B0'), x: 300, y: 320, w: 240, h: 120 }),
    shape('Ab-3', { props: c4('Pasarela de pagos', 'External System', { c4Description: 'Cobra' }), value: C4_LABEL, style: C4_BOX('#8C8496'), x: 700, y: 320, w: 240, h: 120 }),
    arrow('Ab-4', 'Ab-1', 'Ab-2', { props: { placeholders: '1', c4Type: 'Relationship', c4Description: 'Compra', c4Technology: 'HTTPS' }, value: '<b>%c4Description%</b>' }),
    arrow('Ab-5', 'Ab-2', 'Ab-3', { props: { placeholders: '1', c4Type: 'Relationship', c4Description: 'Cobra con' }, value: '<b>%c4Description%</b>' }),
  ]);
  const detalle = page('Contenedores de la tienda', 'Zz9-detalle', [
    shape('Bb-1', { props: c4('Tienda', 'Software System Boundary'), value: '<div>%c4Name%</div>', style: 'rounded=1;dashed=1;fillColor=none;container=1;html=1;', x: 100, y: 100, w: 600, h: 420 }),
    shape('Bb-2', { props: c4('Web', 'Container', { c4Technology: 'React', c4Description: 'La tienda' }), value: C4_LABEL, style: C4_BOX('#23A2D9'), parent: 'Bb-1', x: 40, y: 60, w: 240, h: 130 }),
    shape('Bb-3', { props: c4('Base de datos', 'Container', { c4Technology: 'PostgreSQL' }), value: C4_LABEL, style: `shape=cylinder3;size=15;boundedLbl=1;${C4_BOX('#23A2D9')}`, parent: 'Bb-1', x: 320, y: 260, w: 240, h: 130 }),
    shape('Bb-4', { props: c4('Pasarela de pagos', 'External System'), value: C4_LABEL, style: C4_BOX('#8C8496'), x: 800, y: 100, w: 240, h: 120 }),
    arrow('Bb-5', 'Bb-2', 'Bb-3', { props: { placeholders: '1', c4Type: 'Relationship', c4Description: 'Lee y escribe', c4Technology: 'SQL' } }),
    arrow('Bb-6', 'Bb-2', 'Bb-4', { props: { placeholders: '1', c4Type: 'Relationship', c4Description: 'Cobra con' } }),
  ]);

  it('interpreta tipos, externos, jerarquía por boundary, alcance y coordenadas absolutas', async () => {
    const { document, warnings } = await fromDrawio(file(contexto, detalle), { name: 'Tienda' });
    expect(warnings).toEqual([]);
    const els = byId(document.model.elements);
    expect([...els.keys()].sort()).toEqual(['base-de-datos', 'cliente', 'pasarela-de-pagos', 'tienda', 'web']);
    expect(els.get('cliente')).toEqual({ id: 'cliente', type: 'person', name: 'Cliente', description: 'Usa el sistema' });
    expect(els.get('pasarela-de-pagos')).toMatchObject({ type: 'softwareSystem', external: true });
    expect(els.get('tienda')).toMatchObject({ type: 'softwareSystem', description: 'Vende cosas' });
    expect(els.get('web')).toMatchObject({ type: 'container', technology: 'React', parentId: 'tienda' });
    expect(els.get('base-de-datos')).toMatchObject({ type: 'container', technology: 'PostgreSQL', shape: 'database', parentId: 'tienda' });

    // Las mismas formas en dos páginas (mismo nombre y tipo) son un único elemento.
    expect(document.model.elements.filter((e) => e.name === 'Pasarela de pagos')).toHaveLength(1);
    expect(document.model.relationships.filter((r) => r.description === 'Cobra con')).toHaveLength(2); // distintos extremos: una por página

    const [ctx, det] = document.views;
    expect(ctx).toMatchObject({ id: 'contexto', type: 'systemContext', title: 'Contexto', scopeId: 'tienda' });
    expect(det).toMatchObject({ id: 'contenedores-de-la-tienda', type: 'container', scopeId: 'tienda' });
    // El boundary del alcance no es un nodo; los hijos llevan la posición absoluta (boundary 100,100 + relativa).
    expect(det.elements.map((e) => e.id).sort()).toEqual(['base-de-datos', 'pasarela-de-pagos', 'web']);
    expect(det.elements.find((e) => e.id === 'web')).toMatchObject({ x: 140, y: 160, width: 240, height: 130 });
    expect(det.elements.find((e) => e.id === 'base-de-datos')).toMatchObject({ x: 420, y: 360 });
  });

  it('un marco con un c4Type que no reconoce se tipa por lo que contiene (ExecutionEnvironment con contenedores → sistema)', async () => {
    const xml = file(
      page('Detalle', 'p1', [
        shape('M', { props: c4('Mi sistema', 'ExecutionEnvironment'), value: '%c4Name%', style: 'rounded=1;dashed=1;container=1;html=1;', x: 0, y: 0, w: 500, h: 300 }),
        shape('C', { props: c4('Servicio', 'Container', { c4Technology: 'Go' }), value: C4_LABEL, style: C4_BOX('#23A2D9'), parent: 'M', x: 20, y: 40 }),
      ]),
    );
    const { document } = await fromDrawio(xml);
    expect(document.model.elements).toMatchObject([
      { id: 'mi-sistema', type: 'softwareSystem' },
      { id: 'servicio', type: 'container', parentId: 'mi-sistema' },
    ]);
    expect(document.views[0]).toMatchObject({ type: 'container', scopeId: 'mi-sistema' });
  });

  it('un contenedor que aparece como nodo en una página y como marco en otra queda enlazado a su sistema', async () => {
    const c2 = page('C2', 'c2', [
      shape('S1', { props: c4('Banca', 'Software System Boundary'), value: '%c4Name%', style: 'dashed=1;container=1;html=1;', w: 500, h: 300 }),
      shape('A1', { props: c4('API', 'Container', { c4Technology: 'Java' }), value: C4_LABEL, style: C4_BOX('#23A2D9'), parent: 'S1', x: 20, y: 40 }),
    ]);
    const c3 = page('C3', 'c3', [
      shape('B1', { props: c4('API', 'Container Scope Boundary'), value: '%c4Name%', style: 'dashed=1;container=1;html=1;', w: 500, h: 300 }),
      shape('K1', { props: c4('Controlador', 'Component', { c4Technology: 'Spring' }), value: C4_LABEL, style: C4_BOX('#63BEF2'), parent: 'B1', x: 20, y: 40 }),
    ]);
    const { document } = await fromDrawio(file(c2, c3));
    const els = byId(document.model.elements);
    expect(els.get('api')).toMatchObject({ type: 'container', technology: 'Java', parentId: 'banca' });
    expect(els.get('controlador')).toMatchObject({ type: 'component', parentId: 'api' });
    expect(document.views.map((v) => [v.type, v.scopeId])).toEqual([['container', 'banca'], ['component', 'api']]);
  });
});

describe('fromDrawio: formas sueltas (sin metadatos C4)', () => {
  it('deduce el tipo por el texto ([Tipo: tecnología]), la forma y el anidamiento', async () => {
    const xml = file(
      page('Sistema', 'P1', [
        shape('U', { value: '<b>Usuario</b><br>Quien compra', style: 'shape=umlActor;html=1;', x: 0, y: 0, w: 60, h: 100 }),
        shape('SYS', { value: 'Tienda', style: 'rounded=0;dashed=1;html=1;', x: 200, y: 0, w: 600, h: 400 }),
        shape('WEB', { value: '<b>Web</b><div>[Container: React]</div><div>Interfaz de compra</div>', style: 'rounded=1;html=1;', parent: 'SYS', x: 20, y: 40, w: 200, h: 100 }),
        shape('DB', { value: 'Pedidos', style: 'shape=cylinder3;html=1;', parent: 'SYS', x: 300, y: 200, w: 120, h: 120 }),
        shape('Q', { value: 'Eventos', style: 'shape=cylinder3;direction=south;html=1;', parent: 'SYS', x: 300, y: 40, w: 120, h: 80 }),
        shape('EXT', { value: '<b>Correo</b><br>[External System]', style: 'rounded=1;html=1;', x: 900, y: 0 }),
        arrow('E1', 'U', 'WEB', { value: '<b>Compra</b><br>[HTTPS]' }),
        arrow('E2', 'WEB', 'DB', { value: 'Guarda' }),
      ]),
    );
    const { document, warnings } = await fromDrawio(xml);
    expect(warnings).toEqual([]);
    const els = byId(document.model.elements);
    expect(els.get('usuario')).toMatchObject({ type: 'person', description: 'Quien compra' });
    expect(els.get('tienda')).toMatchObject({ type: 'softwareSystem' });
    expect(els.get('web')).toMatchObject({ type: 'container', technology: 'React', description: 'Interfaz de compra', parentId: 'tienda' });
    expect(els.get('pedidos')).toMatchObject({ type: 'container', shape: 'database', parentId: 'tienda' });
    expect(els.get('eventos')).toMatchObject({ type: 'container', shape: 'queue', parentId: 'tienda' });
    expect(els.get('correo')).toMatchObject({ type: 'softwareSystem', external: true });
    expect(document.model.relationships).toMatchObject([
      { sourceId: 'usuario', targetId: 'web', description: 'Compra', technology: 'HTTPS' },
      { sourceId: 'web', targetId: 'pedidos', description: 'Guarda' },
    ]);
    // Al ser un sistema con contenedores dentro, la página es una vista de contenedores con ese sistema como alcance.
    expect(document.views[0]).toMatchObject({ id: 'sistema', type: 'container', scopeId: 'tienda' });
    expect(document.views[0].elements.find((e) => e.id === 'web')).toMatchObject({ x: 220, y: 40 });
  });

  it('los hijos de una forma sin tipo bajan un nivel: sistema › contenedor › componente', async () => {
    const xml = file(
      page('Todo', 'p1', [
        shape('X1', { value: 'Alfa', x: 0, y: 0, w: 800, h: 600 }),
        shape('X2', { value: 'Beta', parent: 'X1', x: 10, y: 10, w: 500, h: 400 }),
        shape('X3', { value: 'Gamma', parent: 'X2', x: 10, y: 10 }),
      ]),
    );
    const { document } = await fromDrawio(xml);
    expect(document.model.elements).toMatchObject([
      { id: 'alfa', type: 'softwareSystem' },
      { id: 'beta', type: 'container', parentId: 'alfa' },
      { id: 'gamma', type: 'component', parentId: 'beta' },
    ]);
  });

  it('las etiquetas de flecha sueltas aportan la descripción de la relación', async () => {
    const xml = file(
      page('P', 'p', [
        shape('A', { value: 'Alfa', x: 0, y: 0 }),
        shape('B', { value: 'Beta', x: 300, y: 0 }),
        arrow('E', 'A', 'B'),
        shape('LBL', { value: 'Consulta [REST]', style: 'edgeLabel;html=1;align=center;', parent: 'E' }),
      ]),
    );
    const { document } = await fromDrawio(xml);
    expect(document.model.relationships).toMatchObject([{ description: 'Consulta [REST]' }]);
  });

  it('aplica los offsets de las agrupaciones (group) y omite capas ocultas y formas ocultas', async () => {
    const xml = file(
      page('P', 'p', [
        shape('G', { value: '', style: 'group', x: 100, y: 50, w: 400, h: 200 }),
        shape('A', { value: 'Alfa', parent: 'G', x: 10, y: 20 }),
        shape('H', { value: 'Oculta', extra: { visible: '0' } }),
        `<mxCell id="L2" value="Capa oculta" parent="0" visible="0"/>`,
        shape('N', { value: 'En capa oculta', parent: 'L2' }),
      ]),
    );
    const { document } = await fromDrawio(xml);
    expect(document.model.elements.map((e) => e.name)).toEqual(['Alfa']);
    expect(document.views[0].elements[0]).toMatchObject({ id: 'alfa', x: 110, y: 70 });
  });

  it('los ids repetidos o que chocan con uno reservado generan ids únicos', async () => {
    const xml = file(
      page('P', 'p', [
        shape('el-caja', { value: 'Otra', x: 0, y: 0 }),
        shape('Id_1', { value: 'Caja', x: 200, y: 0 }),
        shape('Id_2', { value: 'Caja', x: 400, y: 0 }),
        shape('Id_3', { value: 'Caja', x: 600, y: 0 }),
      ]),
    );
    const { document } = await fromDrawio(xml);
    // "el-caja" es un id propio de esta herramienta: se reserva para su forma y las demás "Caja" no se lo quitan.
    expect(document.model.elements.map((e) => [e.id, e.name])).toEqual([
      ['caja', 'Otra'],
      ['caja-2', 'Caja'],
      ['caja-3', 'Caja'],
      ['caja-4', 'Caja'],
    ]);
  });
});

describe('fromDrawio: avisos', () => {
  it('avisa de lo que no puede importar y aun así devuelve un documento válido', async () => {
    const xml = file(
      page('P', 'p', [
        shape('note', { value: 'Nota suelta', style: 'text;html=1;' }),
        shape('blank', { value: '' }),
        shape('SYS', { props: c4('Sistema', 'Software System Boundary'), value: '%c4Name%', x: 0, y: 0, w: 500, h: 300 }),
        shape('PER', { props: c4('Persona dentro', 'Person'), value: C4_LABEL, parent: 'SYS', x: 10, y: 10 }),
        shape('A', { value: 'Alfa', x: 700, y: 0 }),
        arrow('LOOP', 'A', 'A'),
        arrow('DANGLING', 'A', undefined),
      ]),
    );
    const { document, warnings } = await fromDrawio(xml);
    expect(validateDocument(document).ok).toBe(true);
    expect(warnings.join('\n')).toMatch(/1 nota\(s\) de texto suelto/);
    expect(warnings.join('\n')).toMatch(/1 forma\(s\) sin texto/);
    expect(warnings.join('\n')).toMatch(/«Persona dentro» \(person\) está dentro de «Sistema» \(softwareSystem\).*sin padre/);
    expect(warnings.join('\n')).toMatch(/consigo mismo/);
    expect(warnings.join('\n')).toMatch(/1 flecha\(s\) sin origen o destino/);
    expect(document.model.elements.find((e) => e.name === 'Persona dentro')?.parentId).toBeUndefined();
    expect(document.model.relationships).toEqual([]);
  });

  it('omite marcos que agrupan personas o sistemas (p. ej. "Empresa") y conserva sus formas', async () => {
    const xml = file(
      page('P', 'p', [
        shape('ent', { props: c4('Empresa', 'Enterprise Boundary'), value: '%c4Name%', style: 'dashed=1;container=1;', w: 900, h: 500 }),
        shape('grp', { value: 'Departamento', style: 'dashed=1;', w: 800, h: 400 }),
        shape('u', { value: 'Ana', style: 'shape=umlActor;', parent: 'grp', x: 10, y: 10 }),
        shape('s', { props: c4('ERP', 'Software System'), value: C4_LABEL, parent: 'ent', x: 300, y: 100 }),
      ]),
    );
    const { document, warnings } = await fromDrawio(xml);
    expect(document.model.elements.map((e) => e.name).sort()).toEqual(['Ana', 'ERP']);
    expect(document.model.elements.every((e) => e.parentId === undefined)).toBe(true);
    expect(warnings.join('\n')).toMatch(/«Departamento» agrupa personas o sistemas/);
  });

  it('limita el número de avisos', async () => {
    const cells = [shape('A', { value: 'Alfa' })];
    for (let i = 0; i < 80; i += 1) cells.push(arrow(`E${i}`, 'A', 'A'));
    const { warnings } = await fromDrawio(file(page('P', 'p', cells)));
    expect(warnings.length).toBe(51);
    expect(warnings.at(-1)).toMatch(/y 30 aviso\(s\) más/);
  });

  it('una página sin formas no crea vista y lo avisa', async () => {
    const { document, warnings } = await fromDrawio(file(page('Vacía', 'v', []), page('Con datos', 'd', [shape('a', { value: 'A' })])));
    expect(document.views.map((v) => v.title)).toEqual(['Con datos']);
    expect(warnings.join('\n')).toMatch(/«Vacía» no tiene formas importables/);
  });
});

describe('fromDrawio: errores', () => {
  const fails = async (input: string, message: RegExp) => {
    await expect(fromDrawio(input)).rejects.toThrow(DrawioImportError);
    await expect(fromDrawio(input)).rejects.toThrow(message);
  };

  it('rechaza lo que no es un diagrama de draw.io con un motivo claro', async () => {
    await fails('', /vacío/);
    await fails('   \n', /vacío/);
    await fails('esto no es xml', /XML válido|ningún elemento/);
    await fails('<mxfile><diagram></mxfile>', /XML válido.*línea 1/);
    await fails('<html><body>hola</body></html>', /No parece un archivo de draw\.io.*<html>/);
    await fails('<mxfile host="x"></mxfile>', /ninguna página/);
    await fails('<mxfile><diagram id="a" name="A"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>', /ninguna forma importable/);
  });

  it('rechaza DOCTYPE y entidades propias (bombas de expansión)', async () => {
    await fails('<!DOCTYPE mxfile [<!ENTITY a "aaaa">]><mxfile><diagram id="a">&a;</diagram></mxfile>', /DOCTYPE|entidades/);
  });

  it('rechaza una página comprimida corrupta', async () => {
    await fails('<mxfile><diagram id="a" name="A">AAAAbm90IGRlZmxhdGU=</diagram></mxfile>', /descomprimir|no es un diagrama/);
    await fails('<mxfile><diagram id="a" name="A">***no es base64***</diagram></mxfile>', /no es un diagrama de draw\.io/);
  });

  it('rechaza una página comprimida que no contiene un mxGraphModel', async () => {
    const packed = await deflateBase64('<algo/>');
    await fails(`<mxfile><diagram id="a" name="A">${packed}</diagram></mxfile>`, /no contiene un <mxGraphModel>/);
  });

  it('un atributo con nombre __proto__ no contamina nada', async () => {
    const props = Object.fromEntries([['__proto__', 'x'], ['constructor', 'y'], ['polluted', 'yes']]);
    const xml = `<mxfile><diagram id="p" name="P"><mxGraphModel __proto__="x" constructor="y"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${shape('A', { value: 'Alfa', props })}</root></mxGraphModel></diagram></mxfile>`;
    const { document } = await fromDrawio(xml);
    expect(document.model.elements).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
