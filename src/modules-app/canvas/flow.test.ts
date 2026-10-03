import { describe, expect, it } from 'vitest';
import type { EdgeRoute, EditorSpec } from '@iark/kernel';
import { FAKE_DOC, fakeEditor } from '../testing-editor';
import { absolutePositions, buildFlow, dropTarget, edgeLabelText, followRoute, ghostNodes, layoutLabelText, movedByDrag, removedNodes, routeInPlace, structureKey } from './flow';

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
  const route: EdgeRoute = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 112 }, { x: 320, y: 112 }, { x: 320, y: 140 }], sides: { source: 'bottom', target: 'top' } };

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
    const straight: EdgeRoute = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 140 }], sides: { source: 'right', target: 'top' } };
    const { nodes, edges } = buildFlow(spec, graph, { ...boxes, edges: [straight] });
    const edge = edges.find((e) => e.id === 'api-cola')!;
    expect(edge).not.toHaveProperty('sourceHandle');
    expect(edge).toMatchObject({ targetHandle: 'top' });
    expect(edge.data.bend).toBeUndefined();
    expect(nodes.find((n) => n.id === 'api')?.data.handles).toBeUndefined();
  });
});

describe('rutas con varios codos fijadas por la colocación de la vista', () => {
  const boxes = { nodes: [{ id: 'api', x: 40, y: 20, width: 160, height: 64 }, { id: 'cola', x: 240, y: 140, width: 160, height: 56 }], groups: [], width: 500, height: 300 };
  // Sale por abajo de «api», baja un poco, gira hacia la derecha, vuelve a bajar, gira a la izquierda y llega por arriba a «cola».
  const long: EdgeRoute = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 100 }, { x: 420, y: 100 }, { x: 420, y: 120 }, { x: 320, y: 120 }, { x: 320, y: 140 }], sides: { source: 'bottom', target: 'top' } };
  const layout = { ...boxes, edges: [{ ...long, points: long.points.slice() }] };

  it('la arista lleva el recorrido entero (y no un solo giro) mientras los nodos de sus extremos siguen donde la colocación los dejó', () => {
    const { edges } = buildFlow(spec, graph, layout);
    const edge = edges.find((e) => e.id === 'api-cola')!;
    expect(edge.data.route).toEqual(long.points);
    expect(edge.data.bend).toBeUndefined();
    expect(edge).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'top' });
  });

  it('si se mueve solo uno de los extremos la ruta ya no vale y la arista se traza como siempre entre sus asas', () => {
    const { edges } = buildFlow(spec, graph, layout, new Map([['api', { x: 70, y: 20 }]]));
    const edge = edges.find((e) => e.id === 'api-cola')!;
    expect(edge.data.route).toBeUndefined();
    expect(edge.data.bend).toBeUndefined();
    expect(edge).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'top' });
    // Un nodo ajeno a la arista que se mueve no la afecta.
    expect(buildFlow(spec, graph, layout, new Map([['worker', { x: 5, y: 5 }]])).edges.find((e) => e.id === 'api-cola')!.data.route).toEqual(long.points);
  });

  it('si los dos extremos se mueven lo mismo (se arrastra el grupo que los contiene) la ruta los acompaña', () => {
    const { edges } = buildFlow(spec, graph, layout, new Map([['api', { x: 60, y: 50 }], ['cola', { x: 260, y: 170 }]]));
    expect(edges.find((e) => e.id === 'api-cola')!.data.route).toEqual(long.points.map((p) => ({ x: p.x + 20, y: p.y + 30 })));
  });

  it('con un solo codo (cuatro puntos) la vista solo fija dónde gira, como antes', () => {
    const one: EdgeRoute = { id: 'api-cola', points: [{ x: 120, y: 84 }, { x: 120, y: 112 }, { x: 320, y: 112 }, { x: 320, y: 140 }], sides: { source: 'bottom', target: 'top' } };
    const edge = buildFlow(spec, graph, { ...boxes, edges: [one] }).edges.find((e) => e.id === 'api-cola')!;
    expect(edge.data.bend).toBe(112);
    expect(edge.data.route).toBeUndefined();
  });

  it('routeInPlace: sin lados o con las anclas fuera de sitio no hay ruta, y se admite una holgura de un píxel', () => {
    const [api, cola] = [boxes.nodes[0], boxes.nodes[1]];
    expect(routeInPlace({ id: 'x', points: long.points.slice() }, api, cola)).toBeUndefined();
    expect(routeInPlace(long, api, cola)).toEqual(long.points);
    expect(routeInPlace(long, { ...api, x: api.x + 1 }, { ...cola, x: cola.x + 1 })).toBeDefined();
    expect(routeInPlace(long, { ...api, y: api.y + 3 }, cola)).toBeUndefined();
    expect(routeInPlace({ ...long, sides: { source: 'top', target: 'top' } }, api, cola)).toBeUndefined();
  });

  it('followRoute ancla la ruta a los extremos reales de la arista sin torcer el primer ni el último tramo', () => {
    const followed = followRoute(long.points, { x: 121, y: 87 }, { x: 321, y: 137 });
    expect(followed[0]).toEqual({ x: 121, y: 87 });
    expect(followed[1]).toEqual({ x: 121, y: 100 });
    expect(followed[2]).toEqual(long.points[2]);
    expect(followed[4]).toEqual({ x: 321, y: 120 });
    expect(followed[5]).toEqual({ x: 321, y: 137 });
    for (let i = 1; i < followed.length; i += 1) expect(followed[i].x === followed[i - 1].x || followed[i].y === followed[i - 1].y).toBe(true);
    // No modifica la ruta original.
    expect(long.points[0]).toEqual({ x: 120, y: 84 });
    // Con extremos en un lado, el tramo inicial es horizontal y se alinea en y.
    const side = followRoute([{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 80 }, { x: 60, y: 80 }], { x: 0, y: 12 }, { x: 60, y: 83 });
    expect(side.map((p) => [p.x, p.y])).toEqual([[0, 12], [20, 12], [20, 60], [40, 60], [40, 83], [60, 83]]);
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

describe('comparar versiones: fantasmas de lo quitado', () => {
  const base = { ...FAKE_DOC, nodes: [...FAKE_DOC.nodes, { id: 'antiguo', kind: 'service' as const, name: 'Servicio antiguo' }, { id: 'otro', kind: 'queue' as const, name: 'Cola antigua', zone: 'zona' }] };

  it('removedNodes devuelve los nodos de la versión base que ya no están y que la vista de la base dibujaba', () => {
    const ghosts = removedNodes(spec, base, undefined, new Set(['antiguo', 'otro', 'nunca-estuvo', 'api']), graph);
    expect(ghosts.map((n) => n.id)).toEqual(['antiguo', 'otro']);
    expect(removedNodes(spec, base, undefined, new Set(), graph)).toEqual([]);
  });

  it('si el módulo no sabe proyectar la versión base no hay fantasmas, en vez de romper', () => {
    expect(removedNodes(spec, { nodes: 'roto' }, undefined, new Set(['antiguo']), graph)).toEqual([]);
  });

  it('ghostNodes los coloca en filas bajo el dibujo, discontinuos, sin padre y sin poder arrastrarse ni seleccionarse', () => {
    const placed = buildFlow(spec, graph, undefined).nodes;
    const ghosts = ghostNodes(spec, removedNodes(spec, base, undefined, new Set(['antiguo', 'otro']), graph), placed);
    expect(ghosts.map((g) => g.id)).toEqual(['ghost:antiguo', 'ghost:otro']);
    const bottom = Math.max(...[...absolutePositions(placed)].map(([id, at]) => at.y + placed.find((n) => n.id === id)!.height));
    expect(ghosts[0].position.y).toBeGreaterThan(bottom);
    expect(ghosts[1].position.y).toBe(ghosts[0].position.y);
    expect(ghosts[1].position.x).toBeGreaterThan(ghosts[0].position.x);
    expect(ghosts[0]).toMatchObject({ draggable: false, selectable: false, connectable: false });
    expect(ghosts[0]).not.toHaveProperty('parentId');
    expect(ghosts[1].data).toMatchObject({ diff: 'removed', group: false, node: { dashed: true } });
    expect(ghosts[1].data.node.parentId).toBeUndefined();
    expect(ghostNodes(spec, [], placed)).toEqual([]);
  });

  it('con más de cinco fantasmas se pasa a otra fila', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, kind: 'service', label: `Q${i}` }));
    const ghosts = ghostNodes(spec, many, buildFlow(spec, graph, undefined).nodes);
    expect(new Set(ghosts.map((g) => g.position.y)).size).toBe(2);
    expect(ghosts[5].position.x).toBe(ghosts[0].position.x);
  });
});
