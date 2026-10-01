import type { ShapeKind } from '@iark/kernel';
import type { InteractionStyle, NodeKind } from './types';

/**
 * Notación de los nodos, la misma en el lienzo, el SVG y draw.io: API hexágono, pasarela flecha, broker barra, cola tubo,
 * tópico abanico y almacén cilindro, como en los diagramas de patrones de integración empresarial.
 */
export const NODE_SHAPES: Record<NodeKind, ShapeKind> = {
  system: 'rect',
  api: 'hexagon',
  gateway: 'chevron',
  broker: 'bar',
  queue: 'pipe',
  topic: 'fan',
  store: 'cylinder',
  connector: 'rounded',
  scheduler: 'clock',
  user: 'actor',
  mcp: 'card',
  pattern: 'diamond',
};

export const KIND_COLORS: Record<NodeKind, string> = {
  system: '#1168bd',
  api: '#0b7285',
  gateway: '#7048e8',
  broker: '#c2410c',
  queue: '#d9480f',
  topic: '#b45309',
  store: '#2b8a3e',
  connector: '#a61e4d',
  scheduler: '#4263eb',
  user: '#343a40',
  mcp: '#9c36b5',
  pattern: '#e67700',
};

export const NODE_SIZES: Record<NodeKind, { width: number; height: number }> = {
  system: { width: 200, height: 88 },
  api: { width: 180, height: 76 },
  gateway: { width: 200, height: 76 },
  broker: { width: 200, height: 76 },
  queue: { width: 180, height: 64 },
  topic: { width: 180, height: 72 },
  store: { width: 170, height: 84 },
  connector: { width: 170, height: 64 },
  scheduler: { width: 160, height: 124 },
  user: { width: 120, height: 110 },
  mcp: { width: 190, height: 100 },
  pattern: { width: 210, height: 104 },
};

/** Carácter corto de cada tipo, para la paleta y los títulos de grupo. */
export const NODE_GLYPHS: Record<NodeKind, string> = {
  system: '▣',
  api: '⬡',
  gateway: '⇨',
  broker: '▬',
  queue: '⇒',
  topic: '⋔',
  store: '⛁',
  connector: '⌁',
  scheduler: '⏱',
  user: '☺',
  mcp: '◈',
  pattern: '◇',
};

export const STYLE_LABELS: Record<InteractionStyle, string> = {
  'request-response': 'Petición-respuesta',
  'async-message': 'Mensaje asíncrono',
  event: 'Evento',
  batch: 'Lote',
  stream: 'Flujo continuo',
};
