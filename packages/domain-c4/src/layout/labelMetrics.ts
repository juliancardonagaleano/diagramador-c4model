/**
 * Estimación del tamaño de las etiquetas de relación sin DOM, para que el
 * autolayout (ELK) reserve espacio y para medir solapes. Coincide con el CSS de
 * la app (fuente 11 px en negrita + tecnología en 10 px monoespaciada, máx. 180 px).
 */

export interface LabelSize {
  width: number;
  height: number;
}

export const LABEL_MAX_WIDTH = 180;
export const LABEL_PADDING_X = 12;
const CHAR_WIDTH = 6.4;
const LINE_HEIGHT = 14;
const TECH_LINE_HEIGHT = 13;
const PADDING_Y = 6;

export function estimateLabelSize(description?: string, technology?: string): LabelSize | null {
  const desc = (description ?? '').trim();
  const tech = (technology ?? '').trim();
  if (!desc && !tech) return null;
  const maxTextWidth = LABEL_MAX_WIDTH - LABEL_PADDING_X;
  const descWidth = desc.length * CHAR_WIDTH;
  const descLines = desc ? Math.max(1, Math.ceil(descWidth / maxTextWidth)) : 0;
  const techWidth = tech ? (tech.length + 2) * CHAR_WIDTH * 0.95 : 0;
  const width = Math.min(LABEL_MAX_WIDTH, Math.max(descLines > 1 ? maxTextWidth : descWidth, techWidth) + LABEL_PADDING_X);
  const height = descLines * LINE_HEIGHT + (tech ? TECH_LINE_HEIGHT : 0) + PADDING_Y;
  return { width: Math.round(width), height: Math.round(height) };
}
