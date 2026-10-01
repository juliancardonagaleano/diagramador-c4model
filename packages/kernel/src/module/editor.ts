/**
 * Descriptor de edición interactiva de un módulo (`DomainModule.editor`). Lo comparten los cinco diagramadores: cada módulo
 * declara su notación (figuras, colores, tipos de relación), cómo proyectar su documento a un grafo dibujable, qué campos
 * tiene cada tipo y qué operaciones lo modifican; el lienzo, la barra de herramientas, el panel de propiedades, los atajos
 * y el deshacer son comunes y no conocen ningún dominio.
 */

import type { GraphLayout } from '../graph/layout';
import type { ShapeKind } from '../graph/shapes';
import type { EdgeMark } from '../graph/svg';

export type { ShapeKind } from '../graph/shapes';
export type { EdgeMark } from '../graph/svg';

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
  /** Insignias gráficas sobre la línea: el número de paso, el icono de un patrón… (se dibujan antes que la etiqueta). */
  marks?: EdgeMark[];
  /** Grosor que sustituye al de la notación (p. ej. criticidad alta). */
  width?: number;
}

export interface EditorGraph {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

export type FieldSpec =
  | { key: string; label: string; type: 'text' | 'longtext' | 'boolean'; hint?: string }
  | { key: string; label: string; type: 'number'; hint?: string; min?: number; step?: number }
  | {
      key: string;
      label: string;
      type: 'select';
      options: Array<{ value: string; label: string }>;
      hint?: string;
      allowEmpty?: boolean;
      /** El valor es el id de un adjunto (`EditorSpec.attachments`): el panel de propiedades ofrece abrirlo en su editor o crear uno nuevo. */
      opensAttachment?: boolean;
    }
  | { key: string; label: string; type: 'list'; hint?: string };

/** Qué se está editando: un nodo o una relación de cierto tipo. */
export interface EditorTarget {
  type: 'node' | 'edge';
  kind: string;
}

export type EditResult<TDoc> = { ok: true; document: TDoc; id?: string } | { ok: false; reason: string };

/**
 * Operación del módulo sobre la selección actual (p. ej. «Agrupar en dominio»). El lienzo las ofrece en su barra de
 * herramientas; `needs` dice cuántos elementos tienen que estar seleccionados para que el botón esté activo.
 */
export interface EditorAction<TDoc> {
  id: string;
  label: string;
  hint?: string;
  /** `none`: no usa la selección; `one`: exactamente un elemento; `many`: uno o más. */
  needs: 'none' | 'one' | 'many';
  /** Si se pide un texto antes de ejecutarla (el nombre del dominio); `suggestions` propone valores ya usados. */
  prompt?: { label: string; placeholder?: string; initial?(document: TDoc, ids: string[]): string; suggestions?(document: TDoc): string[] };
  /** Motivo por el que no se puede ejecutar con esta selección, o `undefined` si se puede. */
  disabled?(document: TDoc, ids: string[]): string | undefined;
  run(document: TDoc, ids: string[], input?: string): EditResult<TDoc>;
}

export type AttachmentLanguage = 'json' | 'yaml' | 'proto' | 'graphql' | 'xml' | 'text';

export interface AttachmentFormat {
  id: string;
  label: string;
  language: AttachmentLanguage;
  /** Extensión de archivo al descargarlo (`.proto`, `.json`…). */
  extension: string;
  description?: string;
}

export interface AttachmentDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Línea y columna (desde 1) si se conocen. */
  line?: number;
  column?: number;
}

export type AttachmentTextResult = { ok: true; text: string } | { ok: false; reason: string };

export interface AttachmentInfo {
  id: string;
  name: string;
  format: string;
  version?: string;
  /** Cuántos elementos del documento lo usan. */
  uses: number;
}

export interface AttachmentDetail extends AttachmentInfo {
  description?: string;
  url?: string;
  /** Contenido editable. */
  text: string;
  /** Elementos del documento que lo usan (nodos y relaciones), para saltar a ellos. */
  usedBy: Array<{ id: string; name: string; kind: string }>;
}

/** Conversión de un adjunto a otro formato o forma (p. ej. JSON ↔ YAML); sustituye el texto. */
export interface AttachmentTransform {
  id: string;
  label: string;
  /** Formatos a los que se ofrece; si falta, a todos. */
  formats?: string[];
  run(text: string, context: { name: string; format: string }): AttachmentTextResult;
}

/**
 * Documentos de texto con editor propio que cuelgan del documento del módulo y se asocian a sus elementos: los contratos
 * de una integración (OpenAPI, .proto, CloudEvents, MCP…). El banco de trabajo los lista en una pestaña, valida y formatea
 * su contenido y deja crear uno desde el panel de propiedades de un elemento; no sabe de qué dominio son.
 */
export interface AttachmentSpec<TDoc> {
  /** Título de la pestaña en plural y nombre en singular («Contratos» / «contrato»). */
  label: string;
  singular: string;
  formats: AttachmentFormat[];
  list(document: TDoc): AttachmentInfo[];
  read(document: TDoc, id: string): AttachmentDetail | undefined;
  /** Problemas del contenido para ese formato (sintaxis y reglas del formato). */
  check(format: string, text: string): AttachmentDiagnostic[];
  /** Reescribe el contenido en su forma canónica; falla si el texto no se puede interpretar. */
  reformat(format: string, text: string, context: { name: string }): AttachmentTextResult;
  /** Contenido inicial de un adjunto nuevo. */
  template(format: string, name: string): string;
  /** Resumen legible del contenido (operaciones, mensajes, herramientas…). */
  summary?(format: string, text: string): string[];
  transforms?: AttachmentTransform[];
  add(document: TDoc, format: string, name: string): EditResult<TDoc>;
  update(document: TDoc, id: string, patch: { name?: string; format?: string; version?: string; description?: string; url?: string; text?: string }): EditResult<TDoc>;
  remove(document: TDoc, id: string): EditResult<TDoc>;
  /** Crea un adjunto del formato que mejor encaja con el elemento `targetId` y se lo asigna; `id` es el del adjunto nuevo. */
  createFor?(document: TDoc, targetId: string): EditResult<TDoc>;
  /** Formato recomendado para un elemento (para ofrecer «Nuevo contrato (OpenAPI)»). */
  suggestFormat?(document: TDoc, targetId: string): string | undefined;
}

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
  /** `parentId` es el contenedor seleccionado (si encaja); `viewId`, la vista abierta (p. ej. para crear el recurso en el entorno que se está viendo). */
  addNode(document: TDoc, kind: string, name: string, parentId?: string, viewId?: string): EditResult<TDoc>;
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
  /** Operaciones sobre la selección (la barra del lienzo las muestra tras los botones de edición). */
  actions?: Array<EditorAction<TDoc>>;
  /** Documentos de texto asociados a los elementos, con su propio editor (los contratos de una integración). */
  attachments?: AttachmentSpec<TDoc>;
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
