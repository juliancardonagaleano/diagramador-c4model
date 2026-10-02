import { describe, expect, it } from 'vitest';
import { polylineMidpoint, routePath } from './route';

describe('routePath', () => {
  it('une los puntos de la ruta con tramos rectos y redondea los codos con el radio dado', () => {
    const d = routePath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 120 }], 5);
    expect(d).toBe('M0 0 L0 45 Q0 50 5 50 L95 50 Q100 50 100 55 L100 120');
  });

  it('con varios codos pasa por todos los puntos y acaba en el último', () => {
    const points = [{ x: 10, y: 100 }, { x: 10, y: 80 }, { x: 200, y: 80 }, { x: 200, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 0 }];
    const d = routePath(points);
    expect(d.startsWith('M10 100')).toBe(true);
    expect(d.endsWith('L60 0')).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(4);
    for (const p of points.slice(1, -1)) expect(d).toContain(`Q${p.x} ${p.y} `);
  });

  it('un tramo corto limita el radio a la mitad de su longitud y una ruta recta no tiene curvas', () => {
    expect(routePath([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 40, y: 4 }], 5)).toBe('M0 0 L0 2 Q0 4 2 4 L40 4');
    expect(routePath([{ x: 0, y: 0 }, { x: 0, y: 30 }])).toBe('M0 0 L0 30');
    expect(routePath([{ x: 3, y: 4 }])).toBe('M3 4');
    expect(routePath([])).toBe('');
  });
});

describe('polylineMidpoint', () => {
  it('es el punto medio de la poligonal medido sobre su longitud', () => {
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }])).toEqual({ x: 50, y: 50 });
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
    expect(polylineMidpoint([{ x: 7, y: 9 }])).toEqual({ x: 7, y: 9 });
    expect(polylineMidpoint([])).toEqual({ x: 0, y: 0 });
  });
});
