/**
 * Geometría de las figuras de las notaciones, en trazados SVG. La comparten el lienzo interactivo (que las dibuja con
 * React) y los exportadores SVG de los módulos (que las escriben como texto), de modo que un cilindro o una flecha se ven
 * igual en pantalla y en el archivo exportado.
 */
export type ShapeKind = 'rect' | 'rounded' | 'cylinder' | 'pill' | 'hexagon' | 'chevron' | 'pipe' | 'bar' | 'circle' | 'card' | 'actor' | 'document';

export const SHAPE_KINDS: ShapeKind[] = ['rect', 'rounded', 'cylinder', 'pill', 'hexagon', 'chevron', 'pipe', 'bar', 'circle', 'card', 'actor', 'document'];

export interface ShapePart {
  /** Trazado SVG (atributo `d`), en coordenadas relativas a la esquina superior izquierda del nodo. */
  d: string;
  /** `body`: se rellena con el color del nodo. `detail`: solo trazo (la elipse de un cilindro, las líneas de una barra). */
  role: 'body' | 'detail';
  /** Opacidad del trazo de un detalle (por defecto 1). */
  opacity?: number;
}

const n = (v: number): string => String(Math.round(v * 100) / 100);

/** Rectángulo de esquinas redondeadas como trazado. */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return `M${n(x)} ${n(y)} h${n(w)} v${n(h)} h${n(-w)} z`;
  return `M${n(x + rr)} ${n(y)} h${n(w - 2 * rr)} a${n(rr)} ${n(rr)} 0 0 1 ${n(rr)} ${n(rr)} v${n(h - 2 * rr)} a${n(rr)} ${n(rr)} 0 0 1 ${n(-rr)} ${n(rr)} h${n(-(w - 2 * rr))} a${n(rr)} ${n(rr)} 0 0 1 ${n(-rr)} ${n(-rr)} v${n(-(h - 2 * rr))} a${n(rr)} ${n(rr)} 0 0 1 ${n(rr)} ${n(-rr)} z`;
}

/** Trazados de una figura de `w` × `h` px (con un margen de 1 px para que el trazo no se recorte). */
export function shapeParts(shape: ShapeKind, w: number, h: number): ShapePart[] {
  const i = 1;
  switch (shape) {
    case 'rounded':
      return [{ d: roundedRectPath(i, i, w - 2, h - 2, 18), role: 'body' }];
    case 'pill':
      return [{ d: roundedRectPath(i, i, w - 2, h - 2, Math.min(h / 2, 28)), role: 'body' }];
    case 'circle': {
      const rx = w / 2 - 1;
      const ry = h / 2 - 1;
      return [{ d: `M${n(1)} ${n(h / 2)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 z`, role: 'body' }];
    }
    case 'cylinder': {
      const ry = 9;
      return [
        { d: `M1 ${ry} a${n(w / 2 - 1)} ${ry} 0 0 1 ${n(w - 2)} 0 v${n(h - 2 * ry)} a${n(w / 2 - 1)} ${ry} 0 0 1 ${n(-(w - 2))} 0 z`, role: 'body' },
        { d: `M1 ${ry} a${n(w / 2 - 1)} ${ry} 0 0 0 ${n(w - 2)} 0`, role: 'detail' },
      ];
    }
    case 'hexagon': {
      const k = Math.min(20, w / 5);
      return [{ d: `M${n(k)} 1 L${n(w - k)} 1 L${n(w - 1)} ${n(h / 2)} L${n(w - k)} ${n(h - 1)} L${n(k)} ${n(h - 1)} L1 ${n(h / 2)} z`, role: 'body' }];
    }
    case 'chevron': {
      const k = Math.min(22, w / 5);
      return [{ d: `M1 1 L${n(w - k)} 1 L${n(w - 1)} ${n(h / 2)} L${n(w - k)} ${n(h - 1)} L1 ${n(h - 1)} L${n(k)} ${n(h / 2)} z`, role: 'body' }];
    }
    case 'pipe': {
      const rx = Math.min(16, w / 6);
      const ry = h / 2 - 1;
      return [
        { d: `M${n(rx)} 1 H${n(w - rx)} a${n(rx)} ${n(ry)} 0 0 1 0 ${n(h - 2)} H${n(rx)} a${n(rx)} ${n(ry)} 0 0 1 0 ${n(-(h - 2))} z`, role: 'body' },
        { d: `M${n(w - rx)} 1 a${n(rx)} ${n(ry)} 0 0 0 0 ${n(h - 2)}`, role: 'detail' },
      ];
    }
    case 'bar':
      return [
        { d: roundedRectPath(i, i, w - 2, h - 2, 4), role: 'body' },
        { d: `M12 ${n(h / 2 - 8)} H${n(w - 12)}`, role: 'detail', opacity: 0.7 },
        { d: `M12 ${n(h / 2 + 8)} H${n(w - 12)}`, role: 'detail', opacity: 0.7 },
      ];
    case 'card':
      return [
        { d: roundedRectPath(i, i, w - 2, h - 2, 4), role: 'body' },
        { d: `M1 26 H${n(w - 1)}`, role: 'detail' },
      ];
    case 'actor': {
      // Figura humana que llena la caja: cabeza arriba y cuerpo redondeado debajo (el texto va sobre el cuerpo).
      const r = Math.max(3, Math.min(h * 0.14, 16));
      const top = 2 * r + 4;
      return [
        { d: `M${n(w / 2 - r)} ${n(r + 1)} a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 z`, role: 'body' },
        { d: roundedRectPath(i, top, w - 2, h - top - 1, Math.min(16, (h - top) / 2)), role: 'body' },
      ];
    }
    case 'document':
      return [{ d: `M1 1 H${n(w - 1)} V${n(h - 10)} q${n(-w / 4)} 14 ${n(-w / 2)} 0 t${n(-w / 2)} 0 z`, role: 'body' }];
    default:
      return [{ d: roundedRectPath(i, i, w - 2, h - 2, 8), role: 'body' }];
  }
}

/** Cuánto hay que bajar el centro del texto en una figura (la cabeza del actor ocupa la parte alta). */
export function textOffset(shape: ShapeKind, h: number): number {
  if (shape !== 'actor') return 0;
  const r = Math.max(3, Math.min(h * 0.14, 16));
  return (2 * r + 4) / 2;
}

/** Estilo draw.io equivalente a cada figura, para que el `.drawio` exportado use las mismas figuras que el lienzo y el SVG. */
export function drawioShapeStyle(shape: ShapeKind | undefined): string {
  switch (shape) {
    case 'cylinder':
      return 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;';
    case 'pill':
      return 'rounded=1;arcSize=50;';
    case 'rounded':
      return 'rounded=1;arcSize=30;';
    case 'circle':
      return 'ellipse;';
    case 'hexagon':
      return 'shape=hexagon;perimeter=hexagonPerimeter2;size=0.15;';
    case 'chevron':
      return 'shape=step;perimeter=stepPerimeter;size=0.15;';
    case 'pipe':
      return 'shape=cylinder3;direction=south;boundedLbl=1;backgroundOutline=1;size=12;';
    case 'bar':
      return 'shape=process;size=0.08;';
    case 'card':
      return 'shape=card;size=10;';
    case 'actor':
      return 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;';
    case 'document':
      return 'shape=document;boundedLbl=1;size=0.2;';
    default:
      return 'rounded=1;';
  }
}
