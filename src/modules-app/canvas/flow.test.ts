import { describe, expect, it } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { FAKE_DOC, fakeEditor } from '../testing-editor';
import { absolutePositions, buildFlow, dropTarget, edgeLabelText, layoutLabelText, movedByDrag, structureKey } from './flow';

const spec = fakeEditor as unknown as EditorSpec<unknown>;
const graph = fakeEditor.project(FAKE_DOC);

describe('buildFlow con aristas propias', () => {
  it('todas las aristas son del tipo propio y llevan sus insignias y su notación', () => {
    const { edges } = buildFlow(spec, graph, undefined);
    expect(edges.map((e) => e.type)).toEqual(['notation', 'notation']);
    expect(edges[0].data.edge.marks).toEqual([{ text: '1', title: 'Paso 1' }, { icon: ['M2 8h12'], title: 'Patrón saga' }]);
    expect(edges[0].style).toMatchObject({ stroke: '#b45309', strokeDasharray: '6 4', strokeWidth: 1.5 });
    expect(edges[0].markerEnd).toMatchObject({ type: 'arrowclosed', color: '#b45309' });
    expect(edges[0]).not.toHaveProperty('label');
  });

  it('los nodos de una zona llevan la zona como padre y sus colores propios llegan al nodo', () => {
    const { nodes } = buildFlow(spec, graph, undefined);
    const zone = nodes.find((n) => n.id === 'zona')!;
    expect(zone.data.group).toBe(true);
    expect(zone.data.node).toMatchObject({ fill: '#0ea5e9', stroke: '#0369a1' });
    expect(nodes.find((n) => n.id === 'api')?.parentId).toBe('zona');
  });
});

describe('aristas ancladas por la colocación de la vista', () => {
  const boxes = { nodes: [{ id: 'api', x: 40, y: 20, width: 160, height: 64 }, { id: 'cola', x: 240, y: 140, width: 160, height: 56 }], groups: [], width: 500, height: 300 };
  const route = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 112 }, { x: 320, y: 112 }, { x: 320, y: 140 }], sides: { source: 'bottom', target: 'top' } } as const;

  it('sin lados fijados (el autolayout) las aristas usan las asas de siempre', () => {
    const { nodes, edges } = buildFlow(spec, graph, { ...boxes, edges: [{ id: 'api-cola', points: route.points.slice() }] });
    expect(edges.every((e) => !('sourceHandle' in e) && !('targetHandle' in e) && e.data.bend === undefined)).toBe(true);
    expect(nodes.every((n) => n.data.handles === undefined)).toBe(true);
  });

  it('con lados fijados la arista sale por el asa de abajo y llega por la de arriba, con el giro que traza la vista, y los nodos llevan esas asas', () => {
    const { nodes, edges } = buildFlow(spec, graph, { ...boxes, edges: [route] });
    const edge = edges.find((e) => e.id === 'api-cola')!;
    expect(edge).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'top' });
    expect(edge.data.bend).toBe(112);
    expect(nodes.find((n) => n.id === 'api')?.data.handles).toEqual([{ type: 'source', side: 'bottom' }]);
    expect(nodes.find((n) => n.id === 'cola')?.data.handles).toEqual([{ type: 'target', side: 'top' }]);
    expect(nodes.find((n) => n.id === 'worker')?.data.handles).toBeUndefined();
    // La otra arista no se toca.
    expect(edges.find((e) => e.id === 'cola-worker')).not.toHaveProperty('sourceHandle');
  });

  it('las asas laterales de siempre no se duplican y una arista recta no lleva giro', () => {
    const straight = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 140 }], sides: { source: 'right', target: 'top' } } as const;
    const { nodes, edges } = buildFlow(spec, graph, { ...boxes, edges: [straight] });
    const edge = edges.find((e) => e.id === 'api-cola')!;
    expect(edge).not.toHaveProperty('sourceHandle');
    expect(edge).toMatchObject({ targetHandle: 'top' });
    expect(edge.data.bend).toBeUndefined();
    expect(nodes.find((n) => n.id === 'api')?.data.handles).toBeUndefined();
  });
});

describe('texto de las etiquetas', () => {
  it('une la etiqueta y las insignias de texto entre comillas angulares', () => {
    expect(edgeLabelText({ id: 'e', kind: 'k', source: 'a', target: 'b', label: 'pedidos', badges: ['AMQP', 'saga'] })).toBe('pedidos «AMQP» «saga»');
    expect(edgeLabelText({ id: 'e', kind: 'k', source: 'a', target: 'b' })).toBe('');
  });

  it('el autolayout reserva hueco para las insignias gráficas aunque no haya texto', () => {
    const plain = { id: 'e', kind: 'k', source: 'a', target: 'b' };
    expect(layoutLabelText(plain)).toBe('');
    const marked = layoutLabelText({ ...plain, marks: [{ text: '1' }, { text: '2' }] });
    expect(marked.length).toBeGreaterThanOrEqual(7);
    expect(marked.trim()).toBe('');
    expect(layoutLabelText({ ...plain, label: 'x', marks: [{ text: '1' }] }).endsWith('x')).toBe(true);
  });

  it('añadir o quitar insignias no cambia la firma de la estructura', () => {
    const marked = structureKey(graph);
    const plain = structureKey({ ...graph, edges: graph.edges.map((e) => ({ ...e, marks: undefined })) });
    expect(plain).toBe(marked);
  });
});

describe('arrastre', () => {
  const nodes = buildFlow(spec, graph, { nodes: [{ id: 'api', x: 40, y: 80, width: 160, height: 64 }, { id: 'cola', x: 240, y: 80, width: 160, height: 56 }], groups: [{ id: 'zona', x: 20, y: 40, width: 400, height: 140 }], edges: [], width: 600, height: 300 }).nodes;

  it('las posiciones absolutas suman las del padre en los hijos de un grupo', () => {
    const abs = absolutePositions(nodes);
    expect(abs.get('zona')).toEqual({ x: 20, y: 40 });
    expect(abs.get('api')).toEqual({ x: 40, y: 80 });
  });

  it('mover un nodo guarda su posición absoluta (el cambio llega relativo al padre)', () => {
    const next = movedByDrag(nodes, new Map(), [{ id: 'api', position: { x: 30, y: 60.4 } }]);
    expect(next.get('api')).toEqual({ x: 50, y: 100 });
    expect(next.has('cola')).toBe(false);
  });

  it('mover un grupo arrastra a sus descendientes', () => {
    const next = movedByDrag(nodes, new Map(), [{ id: 'zona', position: { x: 70, y: 90 } }]);
    expect(next.get('zona')).toEqual({ x: 70, y: 90 });
    expect(next.get('api')).toEqual({ x: 90, y: 130 });
    expect(next.get('cola')).toEqual({ x: 290, y: 130 });
    expect(next.has('worker')).toBe(false);
  });

  it('conserva lo ya movido y respeta la posición de un descendiente que viaja en el mismo cambio', () => {
    const next = movedByDrag(nodes, new Map([['libre', { x: 5, y: 5 }]]), [
      { id: 'zona', position: { x: 70, y: 90 } },
      { id: 'api', position: { x: 0, y: 0 } },
    ]);
    expect(next.get('libre')).toEqual({ x: 5, y: 5 });
    expect(next.get('api')).toEqual({ x: 20, y: 40 });
  });
});

describe('orden de apilado', () => {
  it('los grupos anidados quedan por debajo de cualquier elemento, cada uno sobre el que lo contiene', () => {
    const nested = {
      nodes: [
        { id: 'zona', kind: 'zone', label: 'Zona' },
        { id: 'sistema', kind: 'service', label: 'Sistema', parentId: 'zona' },
        { id: 'cola', kind: 'queue', label: 'Cola', parentId: 'sistema' },
        { id: 'suelto', kind: 'service', label: 'Suelto' },
      ],
      edges: [],
    };
    const z = new Map(buildFlow(spec, nested, undefined).nodes.map((n) => [n.id, n.zIndex]));
    expect(z.get('zona')).toBe(0);
    expect(z.get('sistema')).toBe(1);
    expect(z.get('cola')).toBeGreaterThan(z.get('sistema')!);
    expect(z.get('suelto')).toBeGreaterThan(z.get('sistema')!);
  });
});

describe('dropTarget', () => {
  const nodes = [
    { id: 'celda', position: { x: 0, y: 0 } },
    { id: 'otra', position: { x: 300, y: 0 } },
    { id: 'a', position: { x: 20, y: 40 }, parentId: 'celda' },
    { id: 'b', position: { x: 20, y: 140 }, parentId: 'celda' },
  ];
  const sizes = new Map([
    ['celda', { width: 280, height: 300 }],
    ['otra', { width: 280, height: 300 }],
    ['a', { width: 100, height: 60 }],
    ['b', { width: 100, height: 60 }],
  ]);
  it('devuelve el elemento más pequeño que contiene el centro, sin contar el propio nodo', () => {
    expect(dropTarget(nodes, sizes, 'a')).toBe('celda');
    const dropped = nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 330, y: 20 }, parentId: undefined } : n));
    expect(dropTarget(dropped, sizes, 'a')).toBe('otra');
    const onB = nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 20, y: 150 } } : n));
    expect(dropTarget(onB, sizes, 'a')).toBe('b');
  });
  it('no elige un descendiente suyo ni nada si cae fuera', () => {
    expect(dropTarget(nodes, sizes, 'celda')).toBeUndefined();
    const far = nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 900, y: 900 }, parentId: undefined } : n));
    expect(dropTarget(far, sizes, 'a')).toBeUndefined();
  });
});
