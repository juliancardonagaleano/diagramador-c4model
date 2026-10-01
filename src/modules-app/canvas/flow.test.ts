import { describe, expect, it } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { FAKE_DOC, fakeEditor } from '../testing-editor';
import { absolutePositions, buildFlow, edgeLabelText, layoutLabelText, movedByDrag, structureKey } from './flow';

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
