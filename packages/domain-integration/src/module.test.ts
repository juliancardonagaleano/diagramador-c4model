import { readFileSync } from 'node:fs';
import { ModuleRegistry, parseUrn } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { fromC4Json } from './import/fromC4';
import { fromMermaid, IntegrationImportError } from './import/fromMermaid';
import { analyzeIntegration } from './issues';
import { integrationModule } from './module';
import { formatIntegrationIssues, validateIntegrationDocument } from './schema';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { toDrawio } from './export/drawio';
import { integrationAiSpec } from './ai/generation';
import { findView, listViews } from './views';
import type { IntegrationDocument } from './types';

const example = JSON.parse(readFileSync('examples/pedidos-integracion.json', 'utf8')) as unknown;
const parse = (input: unknown): IntegrationDocument => {
  const r = validateIntegrationDocument(input);
  if (!r.ok) throw new Error(formatIntegrationIssues(r.issues));
  return r.document;
};
const doc = parse(example);

describe('esquema de integración', () => {
  it('acepta el ejemplo y aplica valores por defecto', () => {
    expect(doc.nodes).toHaveLength(9);
    expect(parse({}).workspace.name).toBe('Mapa de integración');
  });

  it('rechaza referencias rotas, jerarquía inválida, autoenlaces, contratos y URN inválidos', () => {
    const bad = {
      nodes: [
        { id: 'a', kind: 'system', name: 'A', ref: 'no-es-urn' },
        { id: 'a', kind: 'system', name: 'Repetido' },
        { id: 'q', kind: 'queue', name: 'Q', parentId: 'a' },
        { id: 'x', kind: 'system', name: 'X', parentId: 'a' },
      ],
      interactions: [
        { id: 'i1', sourceId: 'a', targetId: 'a', style: 'event' },
        { id: 'i2', sourceId: 'a', targetId: 'fantasma', style: 'event', contractId: 'nada' },
      ],
      flows: [{ id: 'f', name: 'F', steps: [{ interactionId: 'nada' }] }],
    };
    const r = validateIntegrationDocument(bad);
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatIntegrationIssues(r.issues);
    for (const fragment of ['duplicado', 'URN válida', 'debe ser de tipo "broker"', 'no puede tener padre', 'consigo mismo', 'destino inexistente', 'contrato inexistente', 'interacción inexistente']) {
      expect(text).toContain(fragment);
    }
  });
});

describe('reglas semánticas', () => {
  it('el ejemplo solo tiene avisos menores', () => {
    const issues = analyzeIntegration(doc);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('detecta colas sin consumidor, contratos sin versión, ciclos síncronos y duplicados', () => {
    const d = parse({
      nodes: [
        { id: 'a', kind: 'system', name: 'A', owner: 'x' },
        { id: 'b', kind: 'system', name: 'B', owner: 'x' },
        { id: 'k', kind: 'broker', name: 'K' },
        { id: 'q', kind: 'queue', name: 'Cola', parentId: 'k' },
        { id: 'sola', kind: 'system', name: 'Sola', owner: 'x' },
      ],
      contracts: [{ id: 'c', name: 'Contrato', format: 'asyncapi' }],
      interactions: [
        { id: 'ab', sourceId: 'a', targetId: 'b', style: 'request-response', description: 'x' },
        { id: 'ba', sourceId: 'b', targetId: 'a', style: 'request-response' },
        { id: 'ab2', sourceId: 'a', targetId: 'b', style: 'request-response', description: 'x' },
        { id: 'aq', sourceId: 'a', targetId: 'q', style: 'request-response' },
      ],
    });
    const messages = analyzeIntegration(d).map((i) => i.message);
    expect(messages.some((m) => m.includes('nadie los consume'))).toBe(true);
    expect(messages.some((m) => m.includes('no tiene versión'))).toBe(true);
    expect(messages.some((m) => m.includes('no lo usa ninguna interacción'))).toBe(true);
    expect(messages.some((m) => m.includes('Dependencia síncrona circular: A → B → A'))).toBe(true);
    expect(messages.some((m) => m.includes('está duplicada'))).toBe(true);
    expect(messages.some((m) => m.includes('petición-respuesta contra cola'))).toBe(true);
    expect(messages.some((m) => m.includes('«Sola» no participa'))).toBe(true);
    expect(messages.some((m) => m.includes('no declara contrato'))).toBe(true);
  });
});

describe('vistas', () => {
  it('mapa completo y una vista por flujo con sus padres', () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual(['map', 'flow:crear-pedido']);
    const flow = findView(doc, 'crear-pedido');
    expect(flow.interactions.map((i) => i.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(flow.nodeIds).toContain('kafka'); // el tópico arrastra a su broker
    expect(() => findView(doc, 'nada')).toThrow(/Vistas disponibles/);
  });
});

describe('exportadores', () => {
  it('Mermaid: mapa como flowchart y flujo como sequenceDiagram, y vuelve a importarse', () => {
    const map = toMermaid(doc);
    expect(map.startsWith('flowchart LR')).toBe(true);
    expect(map).toContain('subgraph kafka');
    expect(map).toContain('==>'); // eventos
    const back = fromMermaid(map);
    expect(back.document.nodes.length).toBeGreaterThanOrEqual(doc.nodes.length - 1);
    expect(back.document.interactions).toHaveLength(doc.interactions.length);

    const seq = toMermaid(doc, { viewId: 'flow:crear-pedido' });
    expect(seq.startsWith('sequenceDiagram')).toBe(true);
    expect(seq).toContain('1. Crea el pedido [HTTPS/JSON]');
    const again = fromMermaid(seq);
    expect(again.document.flows[0].steps).toHaveLength(6);
  });

  it('SVG: documento autocontenido con nodos, aristas y agrupaciones', async () => {
    const svg = await toSvg(doc);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Tienda web');
    expect(svg).toContain('Publica PedidoCreado');
    expect(svg).toContain('Broker: Kafka');
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(doc.interactions.length);
  });

  it('draw.io: una página por vista con vértices y aristas', async () => {
    const xml = await toDrawio(doc);
    expect(xml.match(/<diagram /g)).toHaveLength(2);
    expect(xml).toContain('vertex="1"');
    expect(xml).toContain('edge="1"');
  });
});

describe('importadores', () => {
  it('flowchart: formas, estilos de línea y brokers', () => {
    const { document } = fromMermaid(`flowchart LR
      subgraph K[Kafka]
        q([pedidos])
      end
      A[Web] --> B[API]
      B -.->|publica| q
      q ==> C[(Datos)]
    `);
    const byName = (n: string) => document.nodes.find((x) => x.name === n)!;
    expect(byName('Kafka').kind).toBe('broker');
    expect(byName('pedidos')).toMatchObject({ kind: 'queue', parentId: byName('Kafka').id });
    expect(byName('Datos').kind).toBe('store');
    expect(document.interactions.map((i) => i.style)).toEqual(['request-response', 'async-message', 'event']);
  });

  it('rechaza diagramas que no son de integración', () => {
    expect(() => fromMermaid('erDiagram\nA ||--o{ B : x')).toThrow(IntegrationImportError);
    expect(() => fromMermaid('pie\n "a": 1')).toThrow(/No se reconoce/);
  });

  it('desde un documento C4: nodos con URN, protocolo y estilo deducidos', () => {
    const c4 = {
      workspace: { name: 'Tienda' },
      model: {
        elements: [
          { id: 'cliente', type: 'person', name: 'Cliente' },
          { id: 'tienda', type: 'softwareSystem', name: 'Tienda' },
          { id: 'api', type: 'container', name: 'API', technology: 'Node.js REST', parentId: 'tienda' },
          { id: 'bus', type: 'container', name: 'Bus', technology: 'Kafka', parentId: 'tienda', shape: 'queue' },
          { id: 'db', type: 'container', name: 'BD', shape: 'database', parentId: 'tienda' },
          { id: 'ctl', type: 'component', name: 'Controlador', parentId: 'api' },
        ],
        relationships: [
          { id: 'r1', sourceId: 'cliente', targetId: 'api' },
          { id: 'r2', sourceId: 'api', targetId: 'bus', technology: 'Kafka' },
          { id: 'r3', sourceId: 'api', targetId: 'db', technology: 'SQL', description: 'Lee' },
        ],
      },
    };
    const { document, warnings } = fromC4Json(c4);
    expect(document.workspace.name).toBe('Integración - Tienda');
    expect(document.nodes.map((n) => [n.id, n.kind])).toEqual([['tienda', 'system'], ['api', 'api'], ['bus', 'queue'], ['db', 'store']]);
    expect(document.nodes.find((n) => n.id === 'api')).toMatchObject({ parentId: 'tienda' });
    expect(document.nodes.find((n) => n.id === 'bus')?.parentId).toBeUndefined(); // una cola solo cabe en un broker
    expect(parseUrn(document.nodes[1].ref!)).toEqual({ module: 'c4', id: 'api' });
    expect(document.interactions.map((i) => i.style)).toEqual(['async-message', 'request-response']);
    expect(warnings.some((w) => w.includes('persona'))).toBe(true);
    expect(() => fromC4Json({})).toThrow(/model\.elements/);
  });
});

describe('módulo integration', () => {
  const registry = new ModuleRegistry().register(integrationModule);

  it('cumple el contrato del kernel', () => {
    expect(integrationModule.schema.safeParse(example).success).toBe(true);
    expect((integrationModule.jsonSchema() as { type?: string }).type).toBe('object');
    expect(integrationModule.exporters.map((e) => e.id)).toEqual(['mermaid', 'svg', 'drawio']);
    expect(registry.detectImporter('integration', 'x.mmd', '')?.id).toBe('mermaid');
    expect(integrationModule.entities!(doc)).toHaveLength(doc.nodes.length);
  });

  it('IA: convierte lo generado (con nulls) en un documento válido y devuelve los motivos si no lo es', () => {
    const generated = {
      workspace: { name: 'Demo', description: null },
      nodes: [
        { id: 'a', kind: 'system', name: 'A', description: null, technology: null, owner: null, external: null, parentId: null },
        { id: 'b', kind: 'system', name: 'B', description: null, technology: null, owner: null, external: true, parentId: null },
      ],
      contracts: [],
      interactions: [{ id: 'ab', sourceId: 'a', targetId: 'b', style: 'event', protocol: null, pattern: null, contractId: null, description: null, dataObjects: null, criticality: null }],
      flows: [],
    };
    expect(integrationAiSpec.generationSchema.safeParse(generated).success).toBe(true);
    const ok = integrationAiSpec.toDocument(generated);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.document.nodes[0]).toEqual({ id: 'a', kind: 'system', name: 'A' });
    const bad = integrationAiSpec.toDocument({ ...generated, interactions: [{ ...generated.interactions[0], targetId: 'x' }] });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.issues).toContain('destino inexistente');
    expect(integrationAiSpec.user('Una tienda')).toContain('Una tienda');
    expect(integrationAiSpec.user('Añade una cola', doc)).toContain('"pedido-creado"');
  });
});
