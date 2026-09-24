/**
 * Tipos del documento C4. Este es el contrato JSON principal de la herramienta:
 * un modelo semántico compartido (elementos + relaciones) y N vistas que eligen
 * qué mostrar y dónde. Las coordenadas son absolutas y opcionales: un elemento
 * sin `x`/`y` se posiciona con autolayout.
 */

export const DOCUMENT_VERSION = '1.0' as const;

export type ElementType = 'person' | 'softwareSystem' | 'container' | 'component';
export type ElementShape = 'default' | 'database' | 'queue' | 'browser' | 'mobile';
export type ViewType = 'systemContext' | 'container' | 'component';
export type LayoutDirection = 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';

export interface C4Element {
  id: string;
  type: ElementType;
  name: string;
  description?: string;
  technology?: string;
  tags?: string[];
  external?: boolean;
  /** Elemento contenedor lógico: container → softwareSystem, component → container. */
  parentId?: string;
  shape?: ElementShape;
  /** Color de acento opcional (hex) que sustituye al color C4 por defecto. */
  color?: string;
}

export interface C4Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  description?: string;
  technology?: string;
  tags?: string[];
}

export interface C4ViewElement {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface C4LayoutOptions {
  direction?: LayoutDirection;
  /** Separación entre nodos de la misma capa (px). */
  spacing?: number;
  /** Separación entre capas (px). */
  layerSpacing?: number;
}

export interface C4View {
  id: string;
  type: ViewType;
  /** Sistema (systemContext/container) o contenedor (component) del que trata la vista. */
  scopeId?: string;
  title?: string;
  description?: string;
  elements: C4ViewElement[];
  layout?: C4LayoutOptions;
}

export interface C4Workspace {
  name: string;
  description?: string;
}

export interface C4Model {
  elements: C4Element[];
  relationships: C4Relationship[];
}

export interface C4Document {
  version: typeof DOCUMENT_VERSION;
  workspace: C4Workspace;
  model: C4Model;
  views: C4View[];
}

/** Tamaños por defecto de los nodos (px), compartidos por app, layout y export. */
export const DEFAULT_SIZES: Record<ElementType, { width: number; height: number }> = {
  person: { width: 200, height: 170 },
  softwareSystem: { width: 240, height: 130 },
  container: { width: 240, height: 130 },
  component: { width: 240, height: 130 },
};

export const BOUNDARY_PADDING = { top: 56, right: 32, bottom: 32, left: 32 } as const;

/** Colores C4 canónicos por tipo (los de c4model.com / Structurizr). */
export const C4_COLORS: Record<ElementType, string> = {
  person: '#08427B',
  softwareSystem: '#1168BD',
  container: '#438DD5',
  component: '#85BBF0',
};
export const C4_EXTERNAL_COLOR = '#999999';

export const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  person: 'Persona',
  softwareSystem: 'Sistema de software',
  container: 'Contenedor',
  component: 'Componente',
};

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  systemContext: 'Contexto del sistema',
  container: 'Contenedores',
  component: 'Componentes',
};

/** Tipo de elemento que puede ser padre de cada tipo. */
export const PARENT_TYPE: Partial<Record<ElementType, ElementType>> = {
  container: 'softwareSystem',
  component: 'container',
};

/** Tipo de elemento que debe tener el `scopeId` de cada tipo de vista. */
export const VIEW_SCOPE_TYPE: Record<ViewType, ElementType> = {
  systemContext: 'softwareSystem',
  container: 'softwareSystem',
  component: 'container',
};
