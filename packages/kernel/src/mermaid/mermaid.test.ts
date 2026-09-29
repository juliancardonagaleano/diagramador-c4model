import { describe, expect, it } from 'vitest';
import { detectMermaidKind, looksLikeMermaid, parseFlowchart, parseSequence, preprocessMermaid, splitLabel } from './index';

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
