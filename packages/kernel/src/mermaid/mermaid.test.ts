import { describe, expect, it } from 'vitest';
import { detectMermaidKind, erEndIsMany, looksLikeMermaid, parseEr, parseFlowchart, parseSequence, preprocessMermaid, splitLabel } from './index';

const body = (src: string) => preprocessMermaid(src).lines.slice(1);

describe('preprocessMermaid', () => {
  it('quita bloque de código, frontmatter (con título), comentarios y vacíos', () => {
    const r = preprocessMermaid('x\n```mermaid\n---\ntitle: Mi diagrama\n---\n%% nota\nflowchart LR\n\n A --> B %% fin\n```');
    expect(r.title).toBe('Mi diagrama');
    expect(r.lines.map((l) => l.text)).toEqual(['flowchart LR', 'A --> B']);
  });

  it('reconoce el tipo de diagrama', () => {
    expect(detectMermaidKind('graph TD')).toBe('flowchart');
    expect(detectMermaidKind('C4Container')).toBe('c4');
    expect(detectMermaidKind('sequenceDiagram')).toBe('sequence');
    expect(detectMermaidKind('pie')).toBeUndefined();
    expect(looksLikeMermaid('erDiagram\nA ||--o{ B : x')).toBe(true);
  });

  it('splitLabel separa nombre y descripción por <br/>', () => {
    expect(splitLabel('"API<br/>Node.js"')).toEqual({ name: 'API', description: 'Node.js' });
  });
});

describe('parseFlowchart', () => {
  it('emite nodos, formas, aristas con estilo de línea y subgraph en orden', () => {
    const ev = parseFlowchart(body(`flowchart LR
      subgraph B["Broker"]
        q([Cola])
      end
      A[(BD)] -.->|evento| q
      A ==> C & D
      A <--> C
    `));
    expect(ev[0]).toMatchObject({ type: 'subgraph-start', alias: 'B', label: 'Broker' });
    expect(ev[1]).toMatchObject({ type: 'node', node: { alias: 'q', shape: 'stadium' } });
    expect(ev[2]).toMatchObject({ type: 'subgraph-end' });
    const edges = ev.filter((e) => e.type === 'edge');
    expect(edges[0]).toMatchObject({ label: 'evento', line: 'dotted' });
    expect(edges[1]).toMatchObject({ line: 'thick' });
    expect((edges[1] as { to: unknown[] }).to).toHaveLength(2);
    expect(edges[2]).toMatchObject({ bidirectional: true });
    expect(ev.find((e) => e.type === 'node' && e.node.alias === 'A')).toMatchObject({ node: { shape: 'cylinder' } });
  });

  it('avisa de lo que no entiende', () => {
    const ev = parseFlowchart(body('flowchart LR\n \"suelto\"\n A --> '));
    expect(ev.filter((e) => e.type === 'warning')).toHaveLength(2);
  });

  it('conserva las clases de los nodos (`:::x` y `class A,B x`, también si van después de la definición)', () => {
    const ev = parseFlowchart(
      body(`flowchart LR
        A["Uno"]:::app --> B("Dos") & C
        class B,C otra
        classDef app fill:#fff
        class Z ignorada
        class W forma rara`),
    );
    const classesOf = (alias: string) => {
      const found = ev.filter((e): e is Extract<typeof e, { type: 'node' }> => e.type === 'node' && e.node.alias === alias);
      return found.map((e) => e.node.classes);
    };
    expect(classesOf('A')).toEqual([['app']]);
    expect(classesOf('B')).toEqual([['otra']]);
    expect(classesOf('C')).toEqual([['otra']]);
    // Un nodo sin clases no lleva el campo; las aristas comparten las referencias de los nodos.
    const edge = ev.find((e) => e.type === 'edge');
    expect(edge && edge.type === 'edge' ? edge.to.map((n) => n.classes) : []).toEqual([['otra'], ['otra']]);
    expect(ev.filter((e) => e.type === 'warning')).toHaveLength(0);
    const plain = parseFlowchart(body('flowchart LR\n A --> B'));
    expect(plain.find((e) => e.type === 'node')).toEqual({ type: 'node', node: { alias: 'A', label: undefined, shape: undefined }, where: 'línea 2' });
  });
});

describe('parseSequence', () => {
  it('emite participantes, títulos y mensajes con su tipo de flecha', () => {
    const ev = parseSequence(body(`sequenceDiagram
      title Pedido
      actor U as Usuario
      U->>+API: Pide
      API-->>-U: Responde
      API-)Q: Publica
      Note over U: nada
    `));
    expect(ev[0]).toEqual({ type: 'title', text: 'Pedido' });
    expect(ev[1]).toMatchObject({ type: 'participant', alias: 'U', label: 'Usuario', actor: true });
    expect(ev.filter((e) => e.type === 'message').map((e) => (e as { arrow: string }).arrow)).toEqual(['sync', 'reply', 'async']);
    expect(ev).toHaveLength(5);
  });
});

describe('parseEr', () => {
  it('emite entidades, atributos con claves y comentario, y relaciones con sus extremos', () => {
    const events = parseEr(
      body(`erDiagram
        CLIENTE ||--o{ PEDIDO : realiza
        pedido["Pedido de venta"] {
          int id PK
          int cliente_id FK, UK "cliente que compra"
          text nota
        }
        "TABLA RARA"
        SUELTA`),
    );
    expect(events.filter((e) => e.type === 'entity').map((e) => (e.type === 'entity' ? e.entity.alias : ''))).toEqual(['CLIENTE', 'PEDIDO', 'pedido', 'TABLA RARA', 'SUELTA']);
    const rel = events.find((e) => e.type === 'relation');
    expect(rel).toMatchObject({ from: { alias: 'CLIENTE' }, to: { alias: 'PEDIDO' }, left: '||', right: 'o{', identifying: true, label: 'realiza' });
    expect(events.find((e) => e.type === 'entity' && e.entity.label)).toMatchObject({ entity: { alias: 'pedido', label: 'Pedido de venta' } });
    const attrs = events.filter((e) => e.type === 'attribute');
    expect(attrs).toHaveLength(3);
    expect(attrs[0]).toMatchObject({ entity: 'pedido', attrType: 'int', name: 'id', keys: ['PK'] });
    expect(attrs[1]).toMatchObject({ name: 'cliente_id', keys: ['FK', 'UK'], comment: 'cliente que compra' });
    expect(attrs[2]).toMatchObject({ name: 'nota', keys: [], raw: 'text nota' });
  });

  it('avisa de lo que no entiende y mantiene la línea rara de un bloque como atributo sin campos', () => {
    const events = parseEr(body('erDiagram\n A ||--o{ B\n esto no es nada útil: ni válido\n C {\n solo\n }'));
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ message: expect.stringContaining('línea 3') });
    expect(events.find((e) => e.type === 'attribute')).toMatchObject({ entity: 'C', raw: 'solo', keys: [] });
  });

  it('erEndIsMany distingue los extremos con varios', () => {
    expect(['||', '|o', 'o|'].map(erEndIsMany)).toEqual([false, false, false]);
    expect(['}o', '}|', 'o{', '|{'].map(erEndIsMany)).toEqual([true, true, true, true]);
  });
});
