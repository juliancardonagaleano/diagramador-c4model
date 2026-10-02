import type { Box, GraphLayout, SvgLegend } from '@iark/kernel';
import { columnLetter, compareMatrix, versionText, MATCH_NOTES, type DiffKind, type EnvironmentMatrix, type Presence } from '../compare';
import { serviceKindOf, statusOf, type PlatformDocument, type Resource, type Service } from '../types';
import type { PlatformView } from '../views';
import { DIFF_COLORS, DIFF_LABELS, resourceStyle, serviceStyle, type DiffMark, type Scene, type SceneNode } from './render';

/**
 * Comparación de tres o más entornos (`compare:<A>:<B>:<C>…`, `compare:all`) dibujada como una matriz: una columna por entorno
 * (la primera es la referencia) y una fila por servicio o recurso, con la versión y las réplicas en cada celda. Cada celda se
 * compara con la de la referencia y lo que difiere se marca con color e insignia, igual que en la comparación de dos entornos:
 * versión o réplicas distintas, el elemento que falta (celda discontinua) o el que la referencia no tiene.
 *
 * La cuadrícula la coloca esta función (no el autolayout por capas, que no sabe de filas): la usan el lienzo, el SVG y draw.io, y
 * Mermaid, que no tiene cuadrículas, recibe los mismos grupos y nodos como un subgrafo por entorno.
 */

/** Alto de una celda, separación entre celdas y holguras del recuadro de cada columna (el título ocupa la franja superior). */
const CELL_HEIGHT = 76;
const GAP = 12;
const PAD_X = 16;
const TITLE = 44;
const PAD_BOTTOM = 20;
const COLUMN_GAP = 24;
/** Separación extra entre las filas de servicios y las de recursos. */
const SECTION_GAP = 24;
/**
 * Relleno de la referencia y de lo que es igual a ella: grises, no el color de su tipo (que se confundiría con el de las diferencias
 * y haría del primer entorno un diagrama de despliegue más). Así lo que difiere es lo único con color.
 */
const REFERENCE_COLOR = '#1e293b';
const SAME_COLOR = '#64748b';

export const matrixIsDrawn = (view: PlatformView): boolean => view.type === 'compare' && (view.compareIds?.length ?? 0) > 2;

export interface MatrixDrawing {
  scene: Scene;
  layout: GraphLayout;
  legend: SvgLegend;
}

const markOf = (kinds: DiffKind[]): DiffMark => (kinds.length === 0 ? 'same' : kinds.length > 1 ? 'mixed' : kinds[0]);
const replicasText = (n: number): string => `${n} ${n === 1 ? 'réplica' : 'réplicas'}`;
const detail = (p: Presence): string => [p.versions.length > 0 ? versionText(p.versions) : 'sin versión', replicasText(p.replicas)].join(' · ');

/** Ancho de columna: el que necesita la celda con más texto, entre 190 y 300 px. */
const cellWidth = (nodes: SceneNode[]): number =>
  Math.min(300, Math.max(190, ...nodes.map((n) => Math.ceil(Math.max(...n.lines.map((l, i) => l.length * (i === 0 ? 7.2 : 6.2))) + 32))));

/** Qué se dibuja de la matriz de los entornos de la vista y dónde, sin dependencias del autolayout. */
export function drawMatrix(doc: PlatformDocument, view: PlatformView): MatrixDrawing {
  const matrix: EnvironmentMatrix = compareMatrix(doc, view.compareIds ?? []);
  const { environments } = matrix;
  const reference = environments[0];
  const group = (i: number): string => `c:${environments[i].id}`;
  const scene: Scene = { nodes: new Map(), groups: new Map(), edges: new Map() };
  environments.forEach((e, i) => scene.groups.set(group(i), { label: `${columnLetter(i)} · ${e.name}${i === 0 ? ' (referencia)' : ''}`, elementId: e.id }));

  const paint = (style: SceneNode, kinds: DiffKind[], column: number): SceneNode => {
    if (column === 0) return { ...style, diff: 'same', fill: REFERENCE_COLOR, badge: 'Referencia' };
    const mark = markOf(kinds);
    // Las insignias son cortas (la columna ya dice de qué entorno es la celda y la letra A, cuál es la referencia).
    if (mark === 'same') return { ...style, diff: mark, fill: SAME_COLOR, badge: 'Igual que A' };
    const badge = mark === 'only-a' ? 'Falta aquí' : mark === 'only-b' ? 'No está en A' : DIFF_LABELS[mark](reference.name, environments[column].name);
    return { ...style, diff: mark, fill: DIFF_COLORS[mark], stroke: '#0f172a', badge, dashed: mark === 'only-a' || mark === 'only-b' };
  };
  // En la celda de un servicio, versión y réplicas; su tecnología (que no cambia entre entornos) sobra.
  const serviceNode = (s: Service, extra: string[]): SceneNode => ({ ...serviceStyle(s), lines: [s.name, ...extra], cls: serviceKindOf(s), elementId: s.id });
  const resourceNode = (r: Resource, extra: string[]): SceneNode => ({ ...resourceStyle(r, extra), cls: r.kind, elementId: r.id, ...(statusOf(r) !== 'provisioned' ? { status: statusOf(r) } : {}) });

  /** Celdas colocadas: su id, columna y fila (los servicios primero y, tras ellos, los recursos). */
  const placed: Array<{ id: string; column: number; row: number }> = [];
  let row = 0;
  const put = (id: string, node: SceneNode, column: number): void => {
    scene.nodes.set(id, { ...node, groupId: group(column) });
    placed.push({ id, column, row });
  };

  for (const { service, cells } of matrix.services) {
    cells.forEach((cell, column) => {
      if (cell.presence) put(`i:${cell.presence.deploymentIds[0]}`, paint(serviceNode(service, [detail(cell.presence)]), cell.kinds, column), column);
      // Falta en este entorno lo que la referencia sí tiene: se deja la celda marcada para que el hueco se vea.
      else if (column > 0 && cells[0].presence) put(`m:${service.id}:${environments[column].id}`, paint(serviceNode(service, ['no desplegado']), cell.kinds, column), column);
    });
    row += 1;
  }
  const serviceRows = row;
  matrix.resources.forEach((resourceRow, index) => {
    const first = resourceRow.cells.find((c) => c.resource)!.resource!;
    resourceRow.cells.forEach((cell, column) => {
      if (cell.resource) {
        const note = cell.matchedBy && cell.matchedBy !== 'name' ? [MATCH_NOTES[cell.matchedBy]] : [];
        put(cell.resource.id, paint(resourceNode(cell.resource, note), cell.kinds, column), column);
      } else if (column > 0 && resourceRow.cells[0].resource) {
        put(`m:r${index}:${environments[column].id}`, { ...paint(resourceNode(first, []), cell.kinds, column), lines: [first.name, 'no existe aquí'] }, column);
      }
    });
    row += 1;
  });

  // Cuadrícula: todas las columnas del mismo ancho, y los recursos separados de los servicios por un hueco.
  const width = cellWidth([...scene.nodes.values()]);
  const columnWidth = width + PAD_X * 2;
  const section = serviceRows > 0 && matrix.resources.length > 0 ? SECTION_GAP : 0;
  const top = (r: number): number => TITLE + r * (CELL_HEIGHT + GAP) + (r >= serviceRows ? section : 0);
  const rows = Math.max(1, row);
  const height = top(rows - 1) + CELL_HEIGHT + PAD_BOTTOM;
  const x = (column: number): number => column * (columnWidth + COLUMN_GAP);
  const nodes: Box[] = placed.map(({ id, column, row: r }) => ({ id, x: x(column) + PAD_X, y: top(r), width, height: CELL_HEIGHT }));
  const groups: Box[] = environments.map((_, column) => ({ id: group(column), x: x(column), y: 0, width: columnWidth, height }));
  const legend: SvgLegend = {
    title: 'Frente a A',
    items: [
      { label: 'Referencia', color: REFERENCE_COLOR },
      { label: 'Igual', color: SAME_COLOR },
      { label: 'Versión distinta', color: DIFF_COLORS.version },
      { label: 'Réplicas distintas', color: DIFF_COLORS.replicas },
      { label: 'Versión + réplicas', color: DIFF_COLORS.mixed },
      { label: 'Falta', color: DIFF_COLORS['only-a'] },
      { label: 'No está en A', color: DIFF_COLORS['only-b'] },
    ],
  };
  // El SVG mide el dibujo por la cuadrícula y no por su leyenda: con pocas columnas la leyenda se saldría, así que se le deja sitio (6 px por letra, como ella).
  const legendWidth = legend.title.length * 6.4 + 14 + legend.items.reduce((sum, item) => sum + 20 + item.label.length * 6 + 14, 0);
  const layout: GraphLayout = { nodes, groups, edges: [], width: Math.ceil(Math.max(environments.length * columnWidth + (environments.length - 1) * COLUMN_GAP, legendWidth)), height };
  return { scene, layout, legend };
}
