/**
 * Acepta JSON puro o envuelto en un bloque ```json ... ``` (salida típica de una IA), o con
 * texto sobrante antes/después del objeto (p. ej. una nota del modelo tras el cierre `}`).
 * Usado tanto por el CLI (`cli/io.ts`) como por la app web (`app/utils/files.ts`, pestaña "IA").
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
