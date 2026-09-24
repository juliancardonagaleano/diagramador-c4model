import { deriveView, type DerivedBoundary, type DerivedNode, type DerivedView } from '../../model/viewDerivation';
import type { C4Document } from '../../model/types';
import {
  boundaryLabel,
  boundaryStyle,
  c4TypeLabel,
  elementLabel,
  elementStyle,
  relationshipLabel,
  relationshipStyle,
  type DrawioLocale,
} from './styles';

export interface DrawioOptions {
  /** Idioma de las etiquetas de tipo (c4Type). */
  locale?: DrawioLocale;
  /** Fecha para el atributo `modified` (por defecto ahora). */
  modified?: Date;
  /** Solo exportar estas vistas (ids). Por defecto todas. */
  viewIds?: string[];
}

export class DrawioExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawioExportError';
  }
}

/**
 * Convierte un documento C4 a XML de draw.io (`.drawio`, sin comprimir).
 * Cada vista se convierte en una página. Los elementos deben estar posicionados
 * (ejecute autolayout antes si faltan coordenadas).
 */
export function toDrawio(doc: C4Document, options: DrawioOptions = {}): string {
  const locale = options.locale ?? 'es';
  const modified = (options.modified ?? new Date()).toISOString();
  const views = options.viewIds ? doc.views.filter((v) => options.viewIds!.includes(v.id)) : doc.views;
  if (views.length === 0) throw new DrawioExportError('El documento no tiene vistas que exportar');

  const pages = views.map((v) => diagramXml(deriveView(doc, v.id), locale));
  return (
    `<mxfile host="diagramador-c4model" modified="${modified}" agent="diagramador-c4model" version="24.0.0" type="device">\n` +
    pages.join('\n') +
    `\n</mxfile>\n`
  );
}

function diagramXml(derived: DerivedView, locale: DrawioLocale): string {
  const { view, nodes, boundaries, edges } = derived;
  const unpositioned = nodes.filter((n) => !n.positioned);
  if (unpositioned.length > 0) {
    throw new DrawioExportError(
      `La vista "${view.id}" tiene elementos sin posición (${unpositioned.map((n) => n.id).join(', ')}). Ejecute el autolayout antes de exportar.`,
    );
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const boundaryById = new Map(boundaries.map((b) => [b.id, b]));
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

  // Boundaries primero (de más externo a más interno) para que las celdas padre precedan a las hijas.
  const depth = (b: DerivedBoundary): number => (b.boundaryId ? 1 + depth(boundaryById.get(b.boundaryId)!) : 0);
  const orderedBoundaries = [...boundaries].sort((a, b) => depth(a) - depth(b));

  const absolute = (id: string): { x: number; y: number } => {
    const b = boundaryById.get(id);
    if (b) return { x: b.x ?? 0, y: b.y ?? 0 };
    const n = nodeById.get(id)!;
    return { x: n.x!, y: n.y! };
  };
  const relativeTo = (parentId: string | undefined, x: number, y: number): { x: number; y: number } => {
    if (!parentId) return { x, y };
    const p = absolute(parentId);
    return { x: x - p.x, y: y - p.y };
  };

  for (const b of orderedBoundaries) {
    const el = b.element;
    const typeKey = el.type === 'container' ? 'boundary-container' : 'boundary-softwareSystem';
    const geo = relativeTo(b.boundaryId, b.x ?? 0, b.y ?? 0);
    const width = b.width ?? 300;
    const height = b.height ?? 200;
    cells.push(
      objectCell(
        cellId(b.id),
        { c4Name: el.name, c4Type: c4TypeLabel(locale, typeKey), label: boundaryLabel() },
        `<mxCell style="${boundaryStyle()}" vertex="1" parent="${parentCell(b.boundaryId)}">` +
          `<mxGeometry x="${geo.x}" y="${geo.y}" width="${width}" height="${height}" as="geometry"/></mxCell>`,
      ),
    );
  }

  for (const n of nodes) {
    const el = n.element;
    const geo = relativeTo(n.boundaryId, n.x!, n.y!);
    const attrs: Record<string, string> = {
      c4Name: el.name,
      c4Type: c4TypeLabel(locale, el.type),
      c4Description: el.description ?? '',
      label: elementLabel(el),
    };
    if (el.type === 'container' || el.type === 'component') attrs.c4Technology = el.technology ?? '';
    cells.push(
      objectCell(
        cellId(n.id),
        attrs,
        `<mxCell style="${elementStyle(el)}" vertex="1" parent="${parentCell(n.boundaryId)}">` +
          `<mxGeometry x="${geo.x}" y="${geo.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`,
      ),
    );
  }

  for (const e of edges) {
    const rel = e.relationship;
    const hasTech = !!rel.technology;
    const attrs: Record<string, string> = {
      c4Type: c4TypeLabel(locale, 'relationship'),
      c4Description: rel.description ?? '',
      label: relationshipLabel(hasTech),
    };
    if (hasTech) attrs.c4Technology = rel.technology!;
    cells.push(
      objectCell(
        cellId(e.id),
        attrs,
        `<mxCell style="${relationshipStyle()}" edge="1" parent="1" source="${cellId(e.sourceId)}" target="${cellId(e.targetId)}">` +
          `<mxGeometry relative="1" as="geometry"/></mxCell>`,
      ),
    );
  }

  return (
    `  <diagram id="${escapeAttr(view.id)}" name="${escapeAttr(view.title ?? view.id)}">\n` +
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">\n` +
    `      <root>\n` +
    cells.map((c) => `        ${c}`).join('\n') +
    `\n      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>`
  );
}

function parentCell(boundaryId: string | undefined): string {
  return boundaryId ? cellId(boundaryId) : '1';
}

function cellId(id: string): string {
  return escapeAttr(id);
}

function objectCell(id: string, attrs: Record<string, string>, inner: string): string {
  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(' ');
  return `<object placeholders="1" ${attrString} id="${id}">${inner}</object>`;
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

export type { DerivedNode };
