import type { C4Element, ElementShape } from '../../../core/model/types';

/**
 * Formas convencionales del modelo C4 (c4model.com / Structurizr) dibujadas en SVG
 * al tamaño exacto del nodo. Devuelve además el relleno interior donde cabe el texto.
 */

export interface ShapeGeometry {
  /** Relleno (px) para el bloque de texto: top, right, bottom, left. */
  padding: [number, number, number, number];
}

export function shapeOf(el: C4Element): ElementShape | 'person' {
  if (el.type === 'person') return 'person';
  return el.shape ?? 'default';
}

export function shapeGeometry(el: C4Element): ShapeGeometry {
  switch (shapeOf(el)) {
    case 'person':
      return { padding: [44, 12, 8, 12] };
    case 'database':
      return { padding: [26, 12, 20, 12] };
    case 'queue':
      return { padding: [8, 28, 8, 28] };
    case 'browser':
      return { padding: [26, 12, 8, 12] };
    case 'mobile':
      return { padding: [16, 16, 18, 16] };
    default:
      return { padding: [10, 12, 10, 12] };
  }
}

export function darken(hex: string, amount = 34): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number) => Math.max(0, v - amount).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

export function lighten(hex: string, amount = 34): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number) => Math.min(255, v + amount).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

interface Props {
  element: C4Element;
  width: number;
  height: number;
  fill: string;
}

export function C4Shape({ element, width: w, height: h, fill }: Props) {
  const stroke = darken(fill);
  const shape = shapeOf(element);
  const common = { className: 'c4-shape-outline', fill, stroke, strokeWidth: 2 } as const;

  let body: React.ReactNode;
  switch (shape) {
    case 'person': {
      const headR = 22;
      const bodyTop = headR;
      body = (
        <>
          <rect x="1" y={bodyTop} width={w - 2} height={h - bodyTop - 1} rx="14" {...common} />
          <circle cx={w / 2} cy={headR + 1} r={headR} {...common} />
        </>
      );
      break;
    }
    case 'database': {
      const ry = 14;
      body = (
        <>
          <path
            d={`M1 ${ry + 1} A ${w / 2 - 1} ${ry} 0 0 0 ${w - 1} ${ry + 1} L ${w - 1} ${h - ry - 1} A ${w / 2 - 1} ${ry} 0 0 1 1 ${h - ry - 1} Z`}
            {...common}
          />
          <ellipse cx={w / 2} cy={ry + 1} rx={w / 2 - 1} ry={ry} {...common} fill={lighten(fill, 18)} />
        </>
      );
      break;
    }
    case 'queue': {
      const rx = 14;
      body = (
        <>
          <path
            d={`M ${rx + 1} 1 L ${w - rx - 1} 1 A ${rx} ${h / 2 - 1} 0 0 1 ${w - rx - 1} ${h - 1} L ${rx + 1} ${h - 1} A ${rx} ${h / 2 - 1} 0 0 1 ${rx + 1} 1 Z`}
            {...common}
          />
          <ellipse cx={w - rx - 1} cy={h / 2} rx={rx} ry={h / 2 - 1} {...common} fill={lighten(fill, 18)} />
        </>
      );
      break;
    }
    case 'browser': {
      const bar = 20;
      body = (
        <>
          <rect x="1" y="1" width={w - 2} height={h - 2} rx="6" {...common} />
          <path d={`M1 ${bar} L ${w - 1} ${bar}`} stroke={stroke} strokeWidth="2" />
          <rect x="1" y="1" width={w - 2} height={bar - 1} rx="6" fill={darken(fill, 18)} />
          <rect x="1" y={bar - 8} width={w - 2} height="8" fill={darken(fill, 18)} />
          {[12, 26, 40].map((cx) => (
            <circle key={cx} cx={cx} cy={bar / 2 + 0.5} r="4" fill="rgba(255,255,255,0.85)" />
          ))}
        </>
      );
      break;
    }
    case 'mobile': {
      body = (
        <>
          <rect x="1" y="1" width={w - 2} height={h - 2} rx="18" {...common} />
          <rect x="12" y="12" width={w - 24} height={h - 30} rx="6" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          <circle cx={w / 2} cy={h - 10} r="4" fill="rgba(255,255,255,0.85)" />
          <rect x={w / 2 - 14} y="5" width="28" height="3" rx="1.5" fill="rgba(255,255,255,0.7)" />
        </>
      );
      break;
    }
    default:
      body = <rect x="1" y="1" width={w - 2} height={h - 2} rx="8" {...common} />;
  }

  return (
    <svg className="c4-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {body}
    </svg>
  );
}
