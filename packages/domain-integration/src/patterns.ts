import type { IntegrationPattern } from './types';

export interface PatternInfo {
  label: string;
  /** Carácter corto para la paleta y las listas. */
  glyph: string;
  /** Icono del patrón: trazados SVG (solo trazo) en una caja de 16 × 16. Es el que se dibuja sobre la línea y en el nodo de patrón. */
  icon: string[];
}

export const PATTERN_INFO: Record<IntegrationPattern, PatternInfo> = {
  'content-based-router': { label: 'Enrutador por contenido', glyph: '⑂', icon: ['M2 8 H14'] },
  'message-translator': { label: 'Traductor de mensajes', glyph: '⇆', icon: ['M2 8 H14'] },
  splitter: { label: 'Divisor', glyph: '⋔', icon: ['M2 8 H14'] },
  aggregator: { label: 'Agregador', glyph: '⋃', icon: ['M2 8 H14'] },
  filter: { label: 'Filtro', glyph: '⏷', icon: ['M2 8 H14'] },
  enricher: { label: 'Enriquecedor', glyph: '⊕', icon: ['M2 8 H14'] },
  'publish-subscribe': { label: 'Publicación-suscripción', glyph: '≋', icon: ['M2 8 H14'] },
  'polling-consumer': { label: 'Consumidor por sondeo', glyph: '⟳', icon: ['M2 8 H14'] },
  'idempotent-receiver': { label: 'Receptor idempotente', glyph: '≡', icon: ['M2 8 H14'] },
  'dead-letter-channel': { label: 'Cola de mensajes muertos', glyph: '☠', icon: ['M2 8 H14'] },
  saga: { label: 'Saga', glyph: '↺', icon: ['M2 8 H14'] },
  'circuit-breaker': { label: 'Cortacircuitos', glyph: '⏻', icon: ['M2 8 H14'] },
  'wire-tap': { label: 'Escucha de línea (wire tap)', glyph: '⊸', icon: ['M2 8 H14'] },
  'claim-check': { label: 'Comprobante (claim check)', glyph: '🎫', icon: ['M2 8 H14'] },
  'scatter-gather': { label: 'Dispersar y recoger', glyph: '⇶', icon: ['M2 8 H14'] },
  resequencer: { label: 'Reordenador', glyph: '⇅', icon: ['M2 8 H14'] },
  'transactional-outbox': { label: 'Bandeja de salida transaccional', glyph: '⤓', icon: ['M2 8 H14'] },
  retry: { label: 'Reintento', glyph: '↻', icon: ['M2 8 H14'] },
};
