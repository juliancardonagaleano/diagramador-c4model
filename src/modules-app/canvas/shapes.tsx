import type { ReactElement } from 'react';
import type { ShapeKind } from '@iark/kernel';

export function textColorFor(fill: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.62 ? '#0b1f33' : '#ffffff';
}

export function darken(hex: string, amount = 34): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number): string => Math.max(0, v - amount).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

interface Props {
  shape: ShapeKind;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  dashed?: boolean;
}

/** Figuras de las notaciones de los módulos, dibujadas en SVG al tamaño exacto del nodo. Las comparten el lienzo y la paleta. */
export function ShapeSvg({ shape, width: w, height: h, fill, stroke, dashed }: Props) {
  const line = stroke ?? darken(fill);
  const common = { fill, stroke: line, strokeWidth: 1.5, strokeDasharray: dashed ? '6 4' : undefined };
  const inset = 1;
  let body: ReactElement;
  switch (shape) {
    case 'rounded':
      body = <rect x={inset} y={inset} width={w - 2} height={h - 2} rx={18} {...common} />;
      break;
    case 'pill':
      body = <rect x={inset} y={inset} width={w - 2} height={h - 2} rx={Math.min(h / 2, 28)} {...common} />;
      break;
    case 'circle':
      body = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 1} ry={h / 2 - 1} {...common} />;
      break;
    case 'cylinder': {
      const ry = 9;
      body = (
        <>
          <path d={`M1 ${ry} a${w / 2 - 1} ${ry} 0 0 1 ${w - 2} 0 v${h - 2 * ry} a${w / 2 - 1} ${ry} 0 0 1 ${-(w - 2)} 0 z`} {...common} />
          <path d={`M1 ${ry} a${w / 2 - 1} ${ry} 0 0 0 ${w - 2} 0`} fill="none" stroke={line} strokeWidth={1.5} />
        </>
      );
      break;
    }
    case 'hexagon': {
      const k = Math.min(20, w / 5);
      body = <polygon points={`${k},1 ${w - k},1 ${w - 1},${h / 2} ${w - k},${h - 1} ${k},${h - 1} 1,${h / 2}`} {...common} />;
      break;
    }
    case 'chevron': {
      const k = Math.min(22, w / 5);
      body = <polygon points={`1,1 ${w - k},1 ${w - 1},${h / 2} ${w - k},${h - 1} 1,${h - 1} ${k},${h / 2}`} {...common} />;
      break;
    }
    case 'pipe': {
      const rx = Math.min(16, w / 6);
      body = (
        <>
          <path d={`M${rx} 1 H${w - rx} a${rx} ${h / 2 - 1} 0 0 1 0 ${h - 2} H${rx} a${rx} ${h / 2 - 1} 0 0 1 0 ${-(h - 2)} z`} {...common} />
          <path d={`M${w - rx} 1 a${rx} ${h / 2 - 1} 0 0 0 0 ${h - 2}`} fill="none" stroke={line} strokeWidth={1.5} />
        </>
      );
      break;
    }
    case 'bar':
      body = (
        <>
          <rect x={inset} y={inset} width={w - 2} height={h - 2} rx={4} {...common} />
          <line x1={12} y1={h / 2 - 8} x2={w - 12} y2={h / 2 - 8} stroke={line} strokeOpacity={0.7} />
          <line x1={12} y1={h / 2 + 8} x2={w - 12} y2={h / 2 + 8} stroke={line} strokeOpacity={0.7} />
        </>
      );
      break;
    case 'card':
      body = (
        <>
          <rect x={inset} y={inset} width={w - 2} height={h - 2} rx={4} {...common} />
          <line x1={1} y1={26} x2={w - 1} y2={26} stroke={line} />
        </>
      );
      break;
    case 'actor':
      body = (
        <>
          <circle cx={w / 2} cy={16} r={11} {...common} />
          <path d={`M${w / 2 - 22} ${h - 2} v-10 a22 18 0 0 1 44 0 v10 z`} {...common} />
        </>
      );
      break;
    case 'document':
      body = <path d={`M1 1 H${w - 1} V${h - 10} q${-w / 4} 14 ${-w / 2} 0 t${-w / 2} 0 z`} {...common} />;
      break;
    default:
      body = <rect x={inset} y={inset} width={w - 2} height={h - 2} rx={8} {...common} />;
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden="true">
      {body}
    </svg>
  );
}
