/** Longitud máxima de un id del documento (la impone el esquema). */
export const MAX_ID_LENGTH = 120;

/**
 * Primer id libre a partir de `base` (`base`, `base-2`, `base-3`…), evitando también los `reserved`, y lo marca
 * como usado en `taken`. Compartido por los importadores para que los ids generados sean siempre únicos.
 */
export function pickId(base: string, taken: Set<string>, reserved: Set<string> = new Set()): string {
  const root = base.slice(0, MAX_ID_LENGTH - 6) || 'item';
  let candidate = root;
  for (let i = 2; taken.has(candidate) || reserved.has(candidate); i += 1) candidate = `${root}-${i}`;
  taken.add(candidate);
  return candidate;
}
