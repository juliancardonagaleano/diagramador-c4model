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
}

export interface SvgEdgeStyle {
  stroke: string;
  dashed?: boolean;
  width?: number;
  label?: string;
}

export interface SvgOptions {
  title?: string;
  node(id: string): SvgNodeStyle;
  edge(id: string): SvgEdgeStyle;
  /** Etiqueta del grupo y, opcionalmente, su relleno y su borde (por defecto gris claro). */
  group?(id: string): { label: string; fill?: string; stroke?: string };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Recorta una línea de texto para que quepa en `width` px (aprox. 6.4 px por carácter a 12 px). */
function fit(text: string, width: number): string {
  const max = Math.max(4, Math.floor((width - 16) / 6.4));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Dibuja un grafo ya colocado como SVG autocontenido (sin fuentes ni hojas de estilo externas). */
export function renderGraphSvg(layout: GraphLayout, options: SvgOptions): string {
  const pad = 24;
  const w = Math.ceil(layout.width + pad * 2);
  const h = Math.ceil(layout.height + pad * 2 + (options.title ? 28 : 0));
  const top = pad + (options.title ? 28 : 0);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, Arial, sans-serif" font-size="12">`);
  out.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#475569"/></marker></defs>`);
  out.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
  if (options.title) out.push(`<text x="${pad}" y="${pad + 8}" font-size="16" font-weight="700" fill="#1f2937">${esc(options.title)}</text>`);
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
    out.push(`<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.width ?? 1.5}"${style.dashed ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#arrow)"/>`);
    if (style.label && e.label) {
      const tw = Math.min(220, style.label.length * 6.4 + 10);
      out.push(`<rect x="${e.label.x - tw / 2}" y="${e.label.y - 10}" width="${tw}" height="18" rx="3" fill="#ffffff" fill-opacity="0.92"/>`);
      out.push(`<text x="${e.label.x}" y="${e.label.y + 3}" text-anchor="middle" fill="#334155">${esc(fit(style.label, tw + 16))}</text>`);
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
