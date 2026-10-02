/**
 * Geometría de las figuras de las notaciones, en trazados SVG. La comparten el lienzo interactivo (que las dibuja con
 * React) y los exportadores SVG de los módulos (que las escriben como texto), de modo que un cilindro o una flecha se ven
 * igual en pantalla y en el archivo exportado.
 */
export type ShapeKind = 'rect' | 'rounded' | 'cylinder' | 'pill' | 'hexagon' | 'chevron' | 'pipe' | 'bar' | 'circle' | 'card' | 'actor' | 'document' | 'fan' | 'clock' | 'diamond' | 'cube' | 'monitor';

export const SHAPE_KINDS: ShapeKind[] = ['rect', 'rounded', 'cylinder', 'pill', 'hexagon', 'chevron', 'pipe', 'bar', 'circle', 'card', 'actor', 'document', 'fan', 'clock', 'diamond', 'cube', 'monitor'];

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
        { d: `M12 ${n(Math.min(8, h / 4))} H${n(w - 12)}`, role: 'detail', opacity: 0.7 },
        { d: `M12 ${n(h - Math.min(8, h / 4))} H${n(w - 12)}`, role: 'detail', opacity: 0.7 },
      ];
    case 'fan': {
      // Entrada estrecha a la izquierda que se abre en tres salidas a la derecha: un tópico de publicación-suscripción.
      const left = h * 0.32;
      return [
        { d: `M1 ${n(left)} L${n(w - 1)} 1 V${n(h - 1)} L1 ${n(h - left)} z`, role: 'body' },
        { d: `M5 ${n(h / 2)} H15`, role: 'detail', opacity: 0.8 },
        ...[0.22, 0.5, 0.78].map((f) => ({ d: `M${n(w - 18)} ${n(h * f)} H${n(w - 6)}`, role: 'detail' as const, opacity: 0.8 })),
      ];
    }
    case 'clock': {
      // Elipse con una esfera de reloj pequeña arriba; el texto baja (ver `textOffset`).
      const rx = w / 2 - 1;
      const ry = h / 2 - 1;
      const r = Math.max(4, Math.min(h * 0.08, 10));
      const cx = w / 2;
      const cy = h * 0.25;
      return [
        { d: `M1 ${n(h / 2)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 z`, role: 'body' },
        { d: `M${n(cx - r)} ${n(cy)} a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 z`, role: 'detail', opacity: 0.9 },
        { d: `M${n(cx)} ${n(cy - r * 0.6)} V${n(cy)} H${n(cx + r * 0.5)}`, role: 'detail', opacity: 0.9 },
      ];
    }
    case 'cube': {
      // Caja en perspectiva: la cara frontal abajo a la izquierda, la superior y la lateral en profundidad (un clúster).
      const k = Math.min(14, w / 6, h / 3);
      return [
        { d: `M1 ${n(k)} L${n(k)} 1 H${n(w - 1)} V${n(h - k)} L${n(w - k)} ${n(h - 1)} H1 z`, role: 'body' },
        { d: `M1 ${n(k)} H${n(w - k)} V${n(h - 1)}`, role: 'detail' },
        { d: `M${n(w - k)} ${n(k)} L${n(w - 1)} 1`, role: 'detail' },
      ];
    }
    case 'monitor': {
      // Pantalla con su peana debajo (una máquina virtual); el texto va sobre la pantalla (ver `textOffset`).
      const stand = Math.min(12, h / 4);
      return [
        { d: roundedRectPath(i, i, w - 2, h - stand - 1, 6), role: 'body' },
        { d: `M${n(w / 2)} ${n(h - stand)} V${n(h - 3)}`, role: 'detail' },
        { d: `M${n(w / 2 - Math.min(20, w / 6))} ${n(h - 2)} H${n(w / 2 + Math.min(20, w / 6))}`, role: 'detail' },
      ];
    }
    case 'diamond':
      return [{ d: `M${n(w / 2)} 1 L${n(w - 1)} ${n(h / 2)} L${n(w / 2)} ${n(h - 1)} L1 ${n(h / 2)} z`, role: 'body' }];
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

/** Cuánto hay que bajar el centro del texto en una figura (la cabeza del actor, la esfera del reloj y la cabecera de la ficha ocupan la parte alta). */
export function textOffset(shape: ShapeKind, h: number): number {
  if (shape === 'clock') return h * 0.28;
  if (shape === 'card') return 26;
  if (shape === 'cube') return Math.min(14, h / 3) / 2;
  if (shape === 'monitor') return -Math.min(12, h / 4) / 2;
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
    case 'fan':
      return 'shape=trapezoid;perimeter=trapezoidPerimeter;direction=west;size=0.3;';
    case 'clock':
      return 'ellipse;';
    case 'diamond':
      return 'rhombus;perimeter=rhombusPerimeter;';
    case 'cube':
      return 'shape=cube;boundedLbl=1;backgroundOutline=1;darkOpacity=0.05;darkOpacity2=0.1;size=14;';
    case 'monitor':
      return 'rounded=1;arcSize=12;strokeWidth=2;';
    default:
      return 'rounded=1;';
  }
}

/** Color de texto legible sobre `fill` (`#rrggbb`): oscuro sobre fondos claros y blanco sobre los demás. */
export function readableTextColor(fill: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.62 ? '#0b1f33' : '#ffffff';
}
