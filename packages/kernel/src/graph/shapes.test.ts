import { describe, expect, it } from 'vitest';
import { renderGraphSvg } from './svg';
import { SHAPE_KINDS, drawioShapeStyle, shapeParts, textOffset } from './shapes';

describe('shapeParts', () => {
  it('toda figura tiene al menos un cuerpo y sus trazados escalan con el tamaño', () => {
    for (const shape of SHAPE_KINDS) {
      const small = shapeParts(shape, 100, 50);
      const big = shapeParts(shape, 300, 150);
      expect(small.filter((p) => p.role === 'body').length, shape).toBeGreaterThanOrEqual(1);
      expect(big.filter((p) => p.role === 'body').length, shape).toBeGreaterThanOrEqual(1);
      for (const p of [...small, ...big]) expect(p.d, shape).toMatch(/^M[\s\d.-]/);
      // Con el triple de tamaño el trazado no puede ser idéntico (la figura no es de tamaño fijo).
      expect(big[0].d, shape).not.toBe(small[0].d);
    }
  });

  it('cilindro, tubería, barra, ficha, abanico y reloj llevan detalles además del cuerpo; el actor es cabeza más cuerpo', () => {
    for (const shape of ['cylinder', 'pipe', 'bar', 'card', 'fan', 'clock'] as const) {
      expect(shapeParts(shape, 160, 80).some((p) => p.role === 'detail'), shape).toBe(true);
    }
    expect(shapeParts('actor', 120, 120).filter((p) => p.role === 'body')).toHaveLength(2);
    expect(shapeParts('rect', 160, 80)).toHaveLength(1);
    expect(shapeParts('diamond', 160, 80)).toHaveLength(1);
  });

  it('las rayas de la barra quedan en sus bordes para no cruzar el texto', () => {
    const lines = shapeParts('bar', 200, 76).filter((p) => p.role === 'detail');
    const ys = lines.map((p) => Number(/^M12 ([\d.]+)/.exec(p.d)?.[1]));
    expect(ys[0]).toBeLessThan(76 / 4);
    expect(ys[1]).toBeGreaterThan(76 * 0.75);
  });

  it('el actor reserva la cabeza y desplaza el texto; el resto de figuras no', () => {
    expect(textOffset('actor', 100)).toBeGreaterThan(0);
    expect(textOffset('actor', 100)).toBeLessThan(50);
    expect(textOffset('clock', 100)).toBeGreaterThan(0);
    expect(textOffset('card', 100)).toBe(26);
    expect(textOffset('rect', 100)).toBe(0);
    expect(textOffset('cylinder', 100)).toBe(0);
  });
});

describe('figuras de infraestructura', () => {
  it('el cubo lleva aristas y la pantalla lleva peana; ambos desplazan el texto hacia su cara principal', () => {
    expect(shapeParts('cube', 200, 78).filter((p) => p.role === 'detail')).toHaveLength(2);
    expect(shapeParts('monitor', 200, 78).filter((p) => p.role === 'detail')).toHaveLength(2);
    expect(textOffset('cube', 78)).toBeGreaterThan(0);
    expect(textOffset('monitor', 78)).toBeLessThan(0);
    expect(drawioShapeStyle('cube')).toContain('shape=cube');
  });

  it('un grupo con borde continuo o punteado se traza con su propio estilo', () => {
    const layout = { nodes: [], groups: [{ id: 'g', x: 0, y: 0, width: 100, height: 60 }], edges: [], width: 100, height: 60 };
    const draw = (border?: 'solid' | 'dashed' | 'dotted'): string => renderGraphSvg(layout, { node: () => ({ fill: '#000', stroke: '#000', lines: [] }), edge: () => ({ stroke: '#000' }), group: () => ({ label: 'G', stroke: '#e03131', border }) });
    expect(draw('solid')).toContain('stroke="#e03131" stroke-width="2"/>');
    expect(draw('dotted')).toContain('stroke-dasharray="2 4"');
    expect(draw()).toContain('stroke-dasharray="6 4"');
  });
});

describe('drawioShapeStyle', () => {
  it('traduce cada figura a un estilo de draw.io y las figuras sin equivalente van con esquinas redondeadas', () => {
    expect(drawioShapeStyle('cylinder')).toContain('shape=cylinder3');
    expect(drawioShapeStyle('pipe')).toContain('direction=south');
    expect(drawioShapeStyle('hexagon')).toContain('shape=hexagon');
    expect(drawioShapeStyle('chevron')).toContain('shape=step');
    expect(drawioShapeStyle('actor')).toContain('umlActor');
    expect(drawioShapeStyle('circle')).toContain('ellipse');
    expect(drawioShapeStyle('fan')).toContain('shape=trapezoid');
    expect(drawioShapeStyle('diamond')).toContain('rhombus');
    expect(drawioShapeStyle('clock')).toContain('ellipse');
    expect(drawioShapeStyle(undefined)).toBe('rounded=1;');
    for (const shape of SHAPE_KINDS) expect(drawioShapeStyle(shape), shape).toMatch(/;$/);
  });
});

describe('renderGraphSvg con figuras', () => {
  it('dibuja cada nodo como trazados de su figura, no como rectángulos genéricos', () => {
    const layout = {
      nodes: [
        { id: 'db', x: 0, y: 0, width: 160, height: 80 },
        { id: 'p', x: 240, y: 0, width: 120, height: 120 },
      ],
      groups: [],
      edges: [{ id: 'e', points: [{ x: 160, y: 40 }, { x: 240, y: 60 }] }],
      width: 360,
      height: 120,
    };
    const svg = renderGraphSvg(layout, {
      node: (id) => (id === 'db' ? { fill: '#123456', stroke: '#000', lines: ['Pedidos'], shape: 'cylinder' as const } : { fill: '#654321', stroke: '#000', lines: ['Cliente'], shape: 'actor' as const }),
      edge: () => ({ stroke: '#475569' }),
      group: () => ({ label: '' }),
    });
    expect(svg).toContain('<path');
    expect(svg).toContain('translate(0 0)');
    expect(svg).toContain('translate(240 0)');
    expect(svg).toContain('Pedidos');
    expect(svg).toContain('Cliente');
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(shapeParts('cylinder', 160, 80).length + shapeParts('actor', 120, 120).length);
  });
});
