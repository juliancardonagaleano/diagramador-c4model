/**
 * Descriptor de edición interactiva de un módulo (`DomainModule.editor`). Lo comparten los cinco diagramadores: cada módulo
 * declara su notación (figuras, colores, tipos de relación), cómo proyectar su documento a un grafo dibujable, qué campos
 * tiene cada tipo y qué operaciones lo modifican; el lienzo, la barra de herramientas, el panel de propiedades, los atajos
 * y el deshacer son comunes y no conocen ningún dominio.
 */

import type { GraphLayout } from '../graph/layout';

/** Figuras que sabe dibujar el lienzo (y, por extensión, cualquier notación de módulo). */
export type ShapeKind = 'rect' | 'rounded' | 'cylinder' | 'pill' | 'hexagon' | 'chevron' | 'pipe' | 'bar' | 'circle' | 'card' | 'actor' | 'document';

export type LineKind = 'solid' | 'dashed' | 'dotted';

export interface NodeNotation {
  /** Tipo del módulo (`queue`, `table`…). */
  kind: string;
  label: string;
  /** Carácter o emoji corto para la paleta. */
  glyph: string;
  shape: ShapeKind;
  fill: string;
  stroke?: string;
  width: number;
  height: number;
  /** Si el tipo se ofrece en la paleta (por defecto sí). */
  addable?: boolean;
}

export interface EdgeNotation {
  kind: string;
  label: string;
  stroke: string;
  line?: LineKind;
  width?: number;
  /** Punta de flecha en el origen (p. ej. petición-respuesta). */
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

export interface EditorNode {
  id: string;
  kind: string;
  label: string;
  /** Segunda línea: tecnología, responsable… */
  sublabel?: string;
  /** Nodo contenedor: si también está en el grafo, este se dibuja como grupo. */
  parentId?: string;
  /** Referencia a un elemento de otro módulo (`urn:iark:<módulo>:<id>`): el lienzo la muestra como enlace navegable. */
  ref?: string;
  /** Insignias pequeñas sobre el nodo (patrón, criticidad, clasificación…). */
  badges?: string[];
  /** Borde discontinuo (p. ej. un sistema externo). */
  dashed?: boolean;
  /** Color que sustituye al de la notación (p. ej. clasificación de un dato). */
  fill?: string;
  /** Borde que sustituye al de la notación (p. ej. rojo para un dato restringido). */
  stroke?: string;
  /** Líneas de detalle bajo el título, alineadas a la izquierda (las columnas de una tabla, los atributos de una entidad). */
  lines?: string[];
  /** Tamaño que sustituye al de la notación (p. ej. una ficha crece con sus columnas). */
  width?: number;
  height?: number;
}

export interface EditorEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
  label?: string;
  badges?: string[];
  /** Grosor que sustituye al de la notación (p. ej. criticidad alta). */
  width?: number;
}

export interface EditorGraph {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

export type FieldSpec =
  | { key: string; label: string; type: 'text' | 'longtext' | 'boolean'; hint?: string }
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; hint?: string; allowEmpty?: boolean }
  | { key: string; label: string; type: 'list'; hint?: string };

/** Qué se está editando: un nodo o una relación de cierto tipo. */
export interface EditorTarget {
  type: 'node' | 'edge';
  kind: string;
}

export type EditResult<TDoc> = { ok: true; document: TDoc; id?: string } | { ok: false; reason: string };

export interface EditorSpec<TDoc> {
  nodeKinds: NodeNotation[];
  edgeKinds: EdgeNotation[];
  /** Tipo de relación que se crea al arrastrar de un nodo a otro sin elegir (por defecto, el primero de `edgeKinds`). */
  defaultEdgeKind?: string;
  /** Grafo de la vista `viewId` (si no se indica, la primera). */
  project(document: TDoc, viewId?: string): EditorGraph;
  /** Campos editables de un tipo. */
  fields(target: EditorTarget, document: TDoc): FieldSpec[];
  /** Valores actuales de un nodo o relación, para el formulario. */
  read(document: TDoc, id: string): { type: 'node' | 'edge'; kind: string; values: Record<string, unknown> } | undefined;
  addNode(document: TDoc, kind: string, name: string, parentId?: string): EditResult<TDoc>;
  addEdge(document: TDoc, kind: string, sourceId: string, targetId: string): EditResult<TDoc>;
  update(document: TDoc, id: string, patch: Record<string, unknown>): EditResult<TDoc>;
  /** Borra un nodo o relación y lo que dependa de él. */
  remove(document: TDoc, id: string): EditResult<TDoc>;
  /** Explica por qué no se puede unir ese origen con ese destino con ese tipo de relación; `undefined` si se puede. */
  canConnect?(document: TDoc, kind: string, sourceId: string, targetId: string): string | undefined;
  /**
   * Colocación propia de una vista (p. ej. la cuadrícula anidada de un mapa de capacidades). Si devuelve `undefined`, el
   * lienzo aplica el autolayout común por capas.
   */
  layout?(document: TDoc, viewId?: string): GraphLayout | undefined | Promise<GraphLayout | undefined>;
}

/** Id nuevo y único con la forma `base`, `base-2`, `base-3`… */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'nuevo';
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
