import { describe, expect, it } from 'vitest';
import { layoutGraph } from './layout';
import { edgeEndPaths, renderGraphSvg } from './svg';

const nodes = [
  { id: 'a', width: 120, height: 60, groupId: 'g' },
  { id: 'b', width: 120, height: 60, groupId: 'g' },
  { id: 'c', width: 120, height: 60 },
];
const edges = [
  { id: 'e1', source: 'a', target: 'b', label: 'llama' },
  { id: 'e2', source: 'b', target: 'c' },
];

describe('layoutGraph', () => {
  it('coloca nodos, grupos y aristas sin solaparse y con el grupo envolviendo a sus hijos', async () => {
    const layout = await layoutGraph(nodes, edges, [{ id: 'g' }]);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(layout.groups.map((g) => g.id)).toEqual(['g']);
    expect(layout.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);

    const g = layout.groups[0];
    for (const id of ['a', 'b']) {
      const n = layout.nodes.find((x) => x.id === id)!;
      expect(n.x).toBeGreaterThanOrEqual(g.x);
      expect(n.y).toBeGreaterThanOrEqual(g.y);
      expect(n.x + n.width).toBeLessThanOrEqual(g.x + g.width);
      expect(n.y + n.height).toBeLessThanOrEqual(g.y + g.height);
    }
    const [n1, n2] = [layout.nodes.find((n) => n.id === 'a')!, layout.nodes.find((n) => n.id === 'b')!];
    const overlap = n1.x < n2.x + n2.width && n2.x < n1.x + n1.width && n1.y < n2.y + n2.height && n2.y < n1.y + n1.height;
    expect(overlap).toBe(false);
    expect(layout.edges.find((e) => e.id === 'e1')!.label).toBeDefined();
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('la dirección DOWN apila las capas en vertical', async () => {
    const chain = [
      { id: 'x', width: 100, height: 40 },
      { id: 'y', width: 100, height: 40 },
    ];
    const right = await layoutGraph(chain, [{ id: 'e', source: 'x', target: 'y' }], [], { direction: 'RIGHT' });
    const down = await layoutGraph(chain, [{ id: 'e', source: 'x', target: 'y' }], [], { direction: 'DOWN' });
    const pos = (l: typeof right, id: string) => l.nodes.find((n) => n.id === id)!;
    expect(pos(right, 'y').x).toBeGreaterThan(pos(right, 'x').x);
    expect(pos(down, 'y').y).toBeGreaterThan(pos(down, 'x').y);
  });
});

describe('renderGraphSvg', () => {
  it('dibuja un SVG autocontenido y escapa el texto de los nodos y las aristas', async () => {
    const layout = await layoutGraph(nodes, edges, [{ id: 'g' }]);
    const svg = renderGraphSvg(layout, {
      title: 'Prueba <1>',
      node: (id) => ({ fill: '#fff', stroke: '#000', lines: [id === 'a' ? 'A & B "x"' : id.toUpperCase(), '[Java]'], badge: 'sistema', shape: id === 'c' ? 'cylinder' : 'rect' }),
      edge: (id) => ({ stroke: '#333', dashed: id === 'e1', label: id === 'e1' ? 'a < b' : undefined }),
      group: () => ({ label: 'Grupo' }),
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('A &amp; B &quot;x&quot;');
    expect(svg).toContain('a &lt; b');
    expect(svg).toContain('Grupo');
    expect(svg).not.toMatch(/<script|href=|@import/);
  });

  it('dibuja fichas (texto a la izquierda, color propio, más líneas y separador bajo el título)', async () => {
    const layout = await layoutGraph([{ id: 'a', width: 200, height: 140 }], []);
    const lines = ['Tabla', 'PK id: int', 'nombre: text', 'email: text', 'pais: text', 'fecha: date'];
    const card = renderGraphSvg(layout, { node: () => ({ fill: '#ffffff', stroke: '#2f9e44', lines, badge: 'Tabla', align: 'left', textColor: '#0f172a', maxLines: 6 }), edge: () => ({ stroke: '#000' }) });
    for (const line of lines.slice(1)) expect(card).toContain(`>${line}</text>`);
    expect(card).toContain('fill="#0f172a"');
    expect(card).not.toContain('text-anchor="middle" fill="#ffffff"');
    expect(card).toMatch(/<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#2f9e44"/);
    // Sin `maxLines` solo se dibujan tres líneas, y centradas y en blanco por defecto.
    const plain = renderGraphSvg(layout, { node: () => ({ fill: '#123456', stroke: '#000', lines }), edge: () => ({ stroke: '#000' }) });
    expect(plain).toContain('>nombre: text</text>');
    expect(plain).not.toContain('>email: text</text>');
    expect(plain).toContain('text-anchor="middle" fill="#ffffff"');
  });

  it('dibuja la pata de gallo en los extremos de una línea en lugar de la punta de flecha', async () => {
    const layout = await layoutGraph(nodes, edges, [{ id: 'g' }]);
    const svg = renderGraphSvg(layout, { node: () => ({ fill: '#fff', stroke: '#000', lines: ['x'] }), edge: (id) => (id === 'e1' ? { stroke: '#333', ends: { source: 'one', target: 'many' } } : { stroke: '#333' }) });
    expect(svg.match(/marker-end="url\(#arrow\)"/g)?.length).toBe(edges.length - 1);
    expect(svg.match(/stroke-linecap="round"/g)?.length).toBe(2);
  });

  it('la pata de gallo son tres patas hacia el nodo y «uno» una barra transversal', () => {
    expect(edgeEndPaths('many', { x: 0, y: 0 }, { x: 1, y: 0 })).toEqual(['M12 0 L0 -6', 'M12 0 L0 0', 'M12 0 L0 6']);
    expect(edgeEndPaths('one', { x: 0, y: 0 }, { x: 1, y: 0 })).toEqual(['M10 -6 L10 6']);
  });
});
