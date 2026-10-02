import type { GraphLayout } from './layout';
import { shapeParts, textOffset, type ShapeKind } from './shapes';

/** Estilo de un nodo: lo decide el módulo (color por tipo, forma, insignia). */
export interface SvgNodeStyle {
  fill: string;
  stroke: string;
  /** Líneas de texto: la primera es el título (en negrita). */
  lines: string[];
  /** Etiqueta pequeña sobre el título (p. ej. el tipo de nodo). */
  badge?: string;
  /** Figura de la notación (las mismas que dibuja el lienzo interactivo). Por defecto, un rectángulo. */
  shape?: ShapeKind;
  dashed?: boolean;
  /** Color del texto (por defecto blanco, para fondos oscuros). */
  textColor?: string;
  /** Alineación del texto: centrado (por defecto) o a la izquierda con el título separado, como una ficha de tabla. */
  align?: 'center' | 'left';
  /** Máximo de líneas de texto que se dibujan (por defecto 3). */
  maxLines?: number;
  /** Icono del tipo en la esquina superior izquierda: trazados de una caja de 16 × 16, con el color del texto. */
  icon?: string[];
}

/** Insignia pequeña sobre una línea: un número de paso (`text`) o el icono de un patrón (`icon`: trazados de una caja de 16 × 16). */
export interface EdgeMark {
  text?: string;
  icon?: string[];
  color?: string;
  /** Texto accesible; en el SVG va como `<title>` (sale al pasar el ratón). */
  title?: string;
}

export interface SvgEdgeStyle {
  stroke: string;
  dashed?: boolean;
  width?: number;
  label?: string;
  /** Insignias que se dibujan a la izquierda de la etiqueta, o centradas en la línea si no hay etiqueta. */
  marks?: EdgeMark[];
  /** Adorno en el origen: rombo (composición) o punto (asignación). */
  tail?: 'diamond' | 'dot';
  /** Punta de flecha: `open` es una «V» sin relleno; `none`, sin punta (por defecto, triángulo relleno). */
  head?: 'open' | 'none';
}

/** Leyenda de colores que se dibuja bajo el título. */
export interface SvgLegend {
  title: string;
  items: Array<{ label: string; color: string }>;
}

export interface SvgOptions {
  title?: string;
  node(id: string): SvgNodeStyle;
  edge(id: string): SvgEdgeStyle;
  /** Etiqueta del grupo y, opcionalmente, su relleno y su borde (por defecto gris claro). */
  group?(id: string): { label: string; fill?: string; stroke?: string };
  legend?: SvgLegend;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MARK = 20;

/** Punto medio de una poligonal, medido sobre su longitud. */
function polylineMidpoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : Math.min(1, left / lengths[i]);
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    left -= lengths[i];
  }
  return points[0];
}

function renderMark(mark: EdgeMark, cx: number, cy: number): string {
  const color = mark.color ?? '#334155';
  const title = mark.title ? `<title>${esc(mark.title)}</title>` : '';
  if (mark.icon && mark.icon.length > 0) {
    const paths = mark.icon.map((d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    return `<g transform="translate(${cx - MARK / 2} ${cy - MARK / 2})">${title}<rect width="${MARK}" height="${MARK}" rx="5" fill="#ffffff" stroke="${color}"/><g transform="translate(2 2)">${paths}</g></g>`;
  }
  return `<g>${title}<circle cx="${cx}" cy="${cy}" r="${MARK / 2}" fill="${color}"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">${esc(mark.text ?? '')}</text></g>`;
}

/** Adorno en el origen de una línea, orientado según su primer tramo: rombo relleno (composición) o punto (asignación). */
function renderTail(kind: 'diamond' | 'dot', points: Array<{ x: number; y: number }>, color: string): string {
  const [a, b] = points;
  if (!a || !b) return '';
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const body = kind === 'dot' ? `<circle cx="4" cy="0" r="4" fill="${color}"/>` : `<path d="M0 0 L6 -4 L12 0 L6 4 z" fill="${color}"/>`;
  return `<g transform="translate(${a.x} ${a.y}) rotate(${angle})">${body}</g>`;
}

/** Recorta una línea de texto para que quepa en `width` px (aprox. 6.4 px por carácter a 12 px). */
function fit(text: string, width: number): string {
  const max = Math.max(4, Math.floor((width - 16) / 6.4));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Dibuja un grafo ya colocado como SVG autocontenido (sin fuentes ni hojas de estilo externas). */
export function renderGraphSvg(layout: GraphLayout, options: SvgOptions): string {
  const pad = 24;
  const w = Math.ceil(layout.width + pad * 2);
  const h = Math.ceil(layout.height + pad * 2 + (options.title ? 28 : 0) + (options.legend && options.legend.items.length > 0 ? 24 : 0));
  const legend = options.legend && options.legend.items.length > 0 ? options.legend : undefined;
  const legendHeight = legend ? 24 : 0;
  const top = pad + (options.title ? 28 : 0) + legendHeight;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, Arial, sans-serif" font-size="12">`);
  out.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#475569"/></marker>` +
      `<marker id="arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#475569" stroke-width="1.6"/></marker></defs>`,
  );
  out.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
  if (options.title) out.push(`<text x="${pad}" y="${pad + 8}" font-size="16" font-weight="700" fill="#1f2937">${esc(options.title)}</text>`);
  if (legend) {
    let x = pad;
    const y = pad + (options.title ? 28 : 0) - 6;
    out.push(`<text x="${x}" y="${y + 11}" font-size="11" font-weight="700" fill="#475569">${esc(legend.title)}</text>`);
    x += legend.title.length * 6.4 + 14;
    for (const item of legend.items) {
      out.push(`<rect x="${x}" y="${y}" width="14" height="14" rx="3" fill="${item.color}" stroke="#0f172a" stroke-opacity="0.35"/>`);
      out.push(`<text x="${x + 20}" y="${y + 11}" font-size="11" fill="#334155">${esc(item.label)}</text>`);
      x += 20 + item.label.length * 6 + 14;
    }
  }
  out.push(`<g transform="translate(${pad} ${top})">`);

  for (const g of layout.groups) {
    const style = options.group?.(g.id);
    const label = style?.label ?? g.id;
    out.push(`<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="8" fill="${style?.fill ?? '#f8fafc'}" stroke="${style?.stroke ?? '#94a3b8'}" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${g.x + 12}" y="${g.y + 22}" font-weight="700" fill="#475569">${esc(fit(label, g.width))}</text>`);
  }

  for (const e of layout.edges) {
    const style = options.edge(e.id);
    const d = e.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    out.push(`<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.width ?? 1.5}"${style.dashed ? ' stroke-dasharray="6 4"' : ''}${style.head === 'none' ? '' : ` marker-end="url(#${style.head === 'open' ? 'arrow-open' : 'arrow'})"`}/>`);
    if (style.tail) out.push(renderTail(style.tail, e.points, style.stroke));
    const marks = style.marks ?? [];
    const anchor = e.label ?? polylineMidpoint(e.points);
    const hasLabel = !!(style.label && e.label);
    const tw = hasLabel ? Math.min(220, (style.label as string).length * 6.4 + 10) : 0;
    const markWidth = marks.length * (MARK + 2);
    const left = anchor.x - (markWidth + tw) / 2;
    marks.forEach((mark, i) => out.push(renderMark(mark, left + i * (MARK + 2) + MARK / 2, anchor.y)));
    if (hasLabel) {
      const cx = left + markWidth + tw / 2;
      out.push(`<rect x="${cx - tw / 2}" y="${anchor.y - 10}" width="${tw}" height="18" rx="3" fill="#ffffff" fill-opacity="0.92"/>`);
      out.push(`<text x="${cx}" y="${anchor.y + 3}" text-anchor="middle" fill="#334155">${esc(fit(style.label as string, tw + 16))}</text>`);
    }
  }

  for (const n of layout.nodes) {
    const s = options.node(n.id);
    const dash = s.dashed ? ' stroke-dasharray="6 4"' : '';
    const shape: ShapeKind = s.shape ?? 'rect';
    out.push(`<g transform="translate(${n.x} ${n.y})">`);
    for (const part of shapeParts(shape, n.width, n.height)) {
      if (part.role === 'body') out.push(`<path d="${part.d}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"${dash}/>`);
      else out.push(`<path d="${part.d}" fill="none" stroke="${s.stroke}" stroke-width="1.5"${part.opacity !== undefined ? ` stroke-opacity="${part.opacity}"` : ''}/>`);
    }
    out.push('</g>');
    if (s.icon && s.icon.length > 0) {
      const paths = s.icon.map((d) => `<path d="${d}" fill="none" stroke="${s.textColor ?? '#ffffff'}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
      out.push(`<g transform="translate(${n.x + 7} ${n.y + 5})" opacity="0.85">${paths}</g>`);
    }
    const shift = textOffset(shape, n.height);
    const ink = s.textColor ?? '#ffffff';
    const lines = s.lines.slice(0, s.maxLines ?? 3);
    if (s.align === 'left') {
      // Ficha: insignia y título arriba, una línea de separación y el resto a la izquierda.
      let y = n.y + 20;
      if (s.badge) {
        out.push(`<text x="${n.x + 10}" y="${y - 6}" font-size="9" fill="${ink}" fill-opacity="0.7" letter-spacing="0.5">${esc(fit(s.badge.toUpperCase(), n.width))}</text>`);
        y += 8;
      }
      lines.forEach((line, i) => {
        out.push(`<text x="${n.x + 10}" y="${y}" fill="${ink}"${i === 0 ? ' font-weight="700"' : ' font-size="11"'}>${esc(fit(line, n.width))}</text>`);
        if (i === 0) {
          out.push(`<line x1="${n.x}" y1="${y + 6}" x2="${n.x + n.width}" y2="${y + 6}" stroke="${s.stroke}" stroke-opacity="0.6"/>`);
          y += 8;
        }
        y += 15;
      });
      continue;
    }
    const cx = n.x + n.width / 2;
    const total = lines.length + (s.badge ? 1 : 0);
    let y = n.y + shift + (n.height - shift) / 2 - ((total - 1) * 15) / 2 + 4;
    if (s.badge) {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-size="10" fill="${ink}" fill-opacity="0.8" letter-spacing="0.5">${esc(fit(s.badge.toUpperCase(), n.width))}</text>`);
      y += 15;
    }
    lines.forEach((line, i) => {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" fill="${ink}"${i === 0 ? ' font-weight="700"' : ' font-size="11"'}>${esc(fit(line, n.width))}</text>`);
      y += 15;
    });
  }

  out.push('</g></svg>');
  return `${out.join('\n')}\n`;
}
