import type { IntegrationPattern } from './types';

export interface PatternInfo {
  label: string;
  /** Carácter corto para la paleta y las listas. */
  glyph: string;
  /** Icono del patrón: trazados SVG (solo trazo) en una caja de 16 × 16. Es el que se dibuja sobre la línea y en el nodo de patrón. */
  icon: string[];
}

export const PATTERN_INFO: Record<IntegrationPattern, PatternInfo> = {
  'content-based-router': { label: 'Enrutador por contenido', glyph: '⑂', icon: ['M1 8 H3', 'M3 8 L6 5 L9 8 L6 11 Z', 'M9 8 L11 4 H15', 'M13 2.5 L15 4 L13 5.5', 'M9 8 L11 12 H15', 'M13 10.5 L15 12 L13 13.5'] },
  'message-translator': { label: 'Traductor de mensajes', glyph: '⇆', icon: ['M3 3 H1.5 V13 H3', 'M13 3 H14.5 V13 H13', 'M5 6 H11', 'M9.5 4.5 L11 6 L9.5 7.5', 'M11 10 H5', 'M6.5 8.5 L5 10 L6.5 11.5'] },
  splitter: { label: 'Divisor', glyph: '⋔', icon: ['M1 8 H13.5', 'M12 6.5 L13.5 8 L12 9.5', 'M5 8 L8 3 H13.5', 'M12 1.5 L13.5 3 L12 4.5', 'M5 8 L8 13 H13.5', 'M12 11.5 L13.5 13 L12 14.5'] },
  aggregator: { label: 'Agregador', glyph: '⋃', icon: ['M1.5 3 H8 L11 8', 'M1.5 8 H11', 'M1.5 13 H8 L11 8', 'M11 8 H14.5', 'M12.5 6 L14.5 8 L12.5 10'] },
  filter: { label: 'Filtro', glyph: '⏷', icon: ['M2 3 H14 L9.5 8.5 V13 L6.5 11.5 V8.5 Z'] },
  enricher: { label: 'Enriquecedor', glyph: '⊕', icon: ['M2 2 H14 V14 H2 Z', 'M8 5 V11', 'M5 8 H11'] },
  'publish-subscribe': { label: 'Publicación-suscripción', glyph: '≋', icon: ['M1 8 A1.5 1.5 0 1 0 4 8 A1.5 1.5 0 1 0 1 8 Z', 'M4 8 L13 3', 'M4 8 H14.5', 'M4 8 L13 13'] },
  'polling-consumer': { label: 'Consumidor por sondeo', glyph: '⟳', icon: ['M13.2 9.9 A5.5 5.5 0 1 1 11.9 4.1', 'M11.9 1.1 V4.1 H8.9', 'M8 5.5 V8 L10 9.5'] },
  'idempotent-receiver': { label: 'Receptor idempotente', glyph: '≡', icon: ['M1 9 L4 12 L11 4', 'M7 11 L8 12 L15 4'] },
  'dead-letter-channel': { label: 'Cola de mensajes muertos', glyph: '☠', icon: ['M2 3 V14 H14 V3', 'M5.5 6 L10.5 11', 'M10.5 6 L5.5 11'] },
  saga: { label: 'Saga', glyph: '↺', icon: ['M1.7 4 A1.3 1.3 0 1 0 4.3 4 A1.3 1.3 0 1 0 1.7 4 Z', 'M6.7 4 A1.3 1.3 0 1 0 9.3 4 A1.3 1.3 0 1 0 6.7 4 Z', 'M11.7 4 A1.3 1.3 0 1 0 14.3 4 A1.3 1.3 0 1 0 11.7 4 Z', 'M4.3 4 H6.7', 'M9.3 4 H11.7', 'M13 5.5 C13 14.5 3 14.5 3 7.5', 'M1.5 9 L3 7.5 L4.5 9'] },
  'circuit-breaker': { label: 'Cortacircuitos', glyph: '⏻', icon: ['M1 11 H4', 'M4 11 L11 4.5', 'M12 11 H15', 'M12 9 V13'] },
  'wire-tap': { label: 'Escucha de línea (wire tap)', glyph: '⊸', icon: ['M1 5 H14', 'M12 3 L14 5 L12 7', 'M7.5 5 V9.5', 'M5 12 A2.5 2.5 0 1 0 10 12 A2.5 2.5 0 1 0 5 12 Z'] },
  'claim-check': { label: 'Comprobante (claim check)', glyph: '🎫', icon: ['M1.5 4 H14.5 V6.5 A1.5 1.5 0 0 0 14.5 9.5 V12 H1.5 V9.5 A1.5 1.5 0 0 0 1.5 6.5 Z', 'M10 4.5 V6 M10 7.25 V8.75 M10 10 V11.5', 'M3.5 7 H7.5', 'M3.5 9.5 H7.5'] },
  'scatter-gather': { label: 'Dispersar y recoger', glyph: '⇶', icon: ['M1 8 A1.5 1.5 0 1 0 4 8 A1.5 1.5 0 1 0 1 8 Z', 'M12 8 A1.5 1.5 0 1 0 15 8 A1.5 1.5 0 1 0 12 8 Z', 'M4 7 C6 3 10 3 12 7', 'M4 8 H12', 'M4 9 C6 13 10 13 12 9'] },
  resequencer: { label: 'Reordenador', glyph: '⇅', icon: ['M2 4 H5 C9 4 7 12 11 12 H14', 'M2 12 H5 C9 12 7 4 11 4 H14', 'M12 2.5 L14 4 L12 5.5', 'M12 10.5 L14 12 L12 13.5'] },
  'transactional-outbox': { label: 'Bandeja de salida transaccional', glyph: '⤓', icon: ['M2 10 V14 H14 V10', 'M8 2 V10', 'M5 7 L8 10 L11 7'] },
  retry: { label: 'Reintento', glyph: '↻', icon: ['M3.1 7.1 A5 5 0 0 1 11.5 4.5', 'M11.5 1.5 V4.5 H8.5', 'M12.9 8.9 A5 5 0 0 1 4.5 11.5', 'M4.5 14.5 V11.5 H7.5'] },
};
