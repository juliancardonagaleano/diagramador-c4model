import type { GraphLayout } from './layout';
import { polylineMidpoint } from './route';
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
  /**
   * Icono del tipo en la esquina superior izquierda: trazados de una caja de 16 × 16, con el color del texto. Con `iconColor`
   * es en cambio una ficha de icono de proveedor (un servicio de una nube): un cuadrado blanco con ese color de acento que
   * cabalga sobre la esquina superior izquierda del nodo.
   */
  icon?: string[];
  /** Color de acento de la ficha del icono (`#rrggbb`); si no se indica, el icono es el pequeño del tipo. */
  iconColor?: string;
}

/** Lado de la ficha de un icono de proveedor y lo que sobresale de la esquina del nodo (o del grupo) que decora. */
export const ICON_TILE = 24;
export const ICON_TILE_OVERHANG = 8;

/** Ficha de un icono de proveedor en (`x`, `y`): fondo blanco, borde y trazos del color de acento (trazados de una caja de 16 × 16). */
export function iconTile(paths: string[], color: string, x: number, y: number): string {
  const c = esc(color);
  const glyph = paths.map((d) => `<path d="${esc(d)}"/>`).join('');
  return `<g transform="translate(${x} ${y})"><rect width="${ICON_TILE}" height="${ICON_TILE}" rx="5" fill="#ffffff" stroke="${c}" stroke-width="1.5"/><g transform="translate(4 4)" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></g>`;
}

/** Insignia pequeña sobre una línea: un número de paso (`text`) o el icono de un patrón (`icon`: trazados de una caja de 16 × 16). */
export interface EdgeMark {
  text?: string;
  icon?: string[];
  color?: string;
  /** Texto accesible; en el SVG va como `<title>` (sale al pasar el ratón). */
  title?: string;
}

/** Remate de un extremo de línea en notación de pata de gallo: `one` = una barra (uno); `many` = tres patas (varios). */
export type EdgeEnd = 'one' | 'many';

/**
 * Glifo de pata de gallo en el punto `at` de una línea que sale hacia `dir` (vector unitario del nodo hacia fuera, es decir,
 * hacia donde va la línea). Devuelve los segmentos como trazados SVG; los comparten el lienzo y el SVG exportado.
 */
export function edgeEndPaths(end: EdgeEnd, at: { x: number; y: number }, dir: { x: number; y: number }): string[] {
  const n = { x: -dir.y, y: dir.x };
  const pt = (along: number, across: number): string => `${Math.round((at.x + dir.x * along + n.x * across) * 10) / 10} ${Math.round((at.y + dir.y * along + n.y * across) * 10) / 10}`;
  if (end === 'one') return [`M${pt(10, -6)} L${pt(10, 6)}`];
  return [`M${pt(12, 0)} L${pt(0, -6)}`, `M${pt(12, 0)} L${pt(0, 0)}`, `M${pt(12, 0)} L${pt(0, 6)}`];
}

/**
 * Dónde se escribe el texto de un extremo de línea (una multiplicidad UML como `0..*`): junto al nodo, encima de la línea si va en
 * horizontal o a su derecha si va en vertical. `at` es el punto de la línea en el borde del nodo y `dir` el vector unitario hacia
 * donde va la línea (como en `edgeEndPaths`). Lo comparten el lienzo y el SVG exportado.
 */
export function edgeEndLabelPoint(at: { x: number; y: number }, dir: { x: number; y: number }): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  const r = (v: number): number => Math.round(v * 10) / 10;
  if (Math.abs(dir.x) >= Math.abs(dir.y)) return { x: r(at.x + dir.x * 20), y: r(at.y - 6), anchor: 'middle' };
  return { x: r(at.x + 7), y: r(at.y + dir.y * 18 + 4), anchor: 'start' };
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
  /** Remates de pata de gallo en el origen y el destino; si hay alguno, la línea no lleva punta de flecha. */
  ends?: { source?: EdgeEnd; target?: EdgeEnd };
  /** Textos junto a cada extremo de la línea (multiplicidades UML `1`, `0..*`); se dibujan además de lo que lleve la línea (use `head: 'none'` para una asociación sin flecha). */
  endLabels?: { source?: string; target?: string };
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
  /** Etiqueta del grupo y, opcionalmente, su relleno, su borde y el trazo del borde (por defecto gris claro y discontinuo). */
  group?(id: string): { label: string; fill?: string; stroke?: string; border?: 'solid' | 'dashed' | 'dotted'; /** Ficha de icono de proveedor en la esquina superior derecha (trazados de 16 × 16 y color de acento). */ icon?: string[]; iconColor?: string };
  legend?: SvgLegend;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MARK = 20;

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
    out.push(`<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="8" fill="${style?.fill ?? '#f8fafc'}" stroke="${style?.stroke ?? '#94a3b8'}"${style?.border === 'solid' ? ' stroke-width="2"' : style?.border === 'dotted' ? ' stroke-width="2" stroke-dasharray="2 4"' : ' stroke-dasharray="6 4"'}/>`);
    out.push(`<text x="${g.x + 12}" y="${g.y + 22}" font-weight="700" fill="#475569">${esc(fit(label, g.width - (style?.icon && style.iconColor ? ICON_TILE : 0)))}</text>`);
    if (style?.icon && style.icon.length > 0 && style.iconColor) out.push(iconTile(style.icon, style.iconColor, g.x + g.width - ICON_TILE + ICON_TILE_OVERHANG, g.y - ICON_TILE_OVERHANG));
  }

  for (const e of layout.edges) {
    const style = options.edge(e.id);
    const d = e.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    const ends = style.ends && (style.ends.source || style.ends.target) ? style.ends : undefined;
    out.push(`<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.width ?? 1.5}"${style.dashed ? ' stroke-dasharray="6 4"' : ''}${ends || style.head === 'none' ? '' : ` marker-end="url(#${style.head === 'open' ? 'arrow-open' : 'arrow'})"`}/>`);
    if (style.tail) out.push(renderTail(style.tail, e.points, style.stroke));
    const unit = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    };
    if (ends && e.points.length >= 2) {
      const pts = e.points;
      const last = pts.length - 1;
      const glyphs = [ends.source && edgeEndPaths(ends.source, pts[0], unit(pts[0], pts[1])), ends.target && edgeEndPaths(ends.target, pts[last], unit(pts[last], pts[last - 1]))];
      for (const g of glyphs) if (g) out.push(`<path d="${g.join(' ')}" fill="none" stroke="${style.stroke}" stroke-width="${style.width ?? 1.5}" stroke-linecap="round"/>`);
    }
    if (style.endLabels && e.points.length >= 2) {
      const pts = e.points;
      const last = pts.length - 1;
      const labels = [
        [style.endLabels.source, pts[0], unit(pts[0], pts[1])],
        [style.endLabels.target, pts[last], unit(pts[last], pts[last - 1])],
      ] as const;
      for (const [text, at, dir] of labels) {
        if (!text) continue;
        const p = edgeEndLabelPoint(at, dir);
        out.push(`<text x="${p.x}" y="${p.y}" text-anchor="${p.anchor}" font-size="11" fill="#334155" stroke="#ffffff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${esc(text)}</text>`);
      }
    }
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
    if (s.icon && s.icon.length > 0 && s.iconColor) {
      out.push(iconTile(s.icon, s.iconColor, n.x - ICON_TILE_OVERHANG, n.y - ICON_TILE_OVERHANG));
    } else if (s.icon && s.icon.length > 0) {
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
