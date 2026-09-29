/** Utilidades de texto y estilo de draw.io: etiquetas HTML, placeholders y cadenas `style`. */

export interface ParsedStyle {
  /** Estilos con nombre sin valor (`text`, `group`, `edgeLabel`…). */
  flags: Set<string>;
  props: Record<string, string>;
}

/** `rounded=1;whiteSpace=wrap;text;` → propiedades y estilos con nombre. */
export function parseStyle(style: string): ParsedStyle {
  const flags = new Set<string>();
  const props = Object.create(null) as Record<string, string>;
  for (const part of style.split(';')) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) flags.add(token);
    else props[token.slice(0, eq).trim()] = token.slice(eq + 1).trim();
  }
  return { flags, props };
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodifica entidades HTML en una sola pasada (así `&amp;lt;` da `&lt;`, no `<`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sustituye los `%propiedad%` de una etiqueta con las propiedades del `<object>` (solo si la celda tiene
 * `placeholders="1"`, como hace draw.io). Los valores se escapan para que su texto no se interprete como HTML.
 */
export function resolvePlaceholders(label: string, attrs: Record<string, string>, isHtml: boolean): string {
  if (attrs.placeholders !== '1') return label;
  return label.replace(/%(\w+)%/g, (_, name: string) => {
    const value = attrs[name] ?? '';
    return isHtml ? escapeHtml(value) : value;
  });
}

/**
 * Convierte una etiqueta (HTML si la celda tiene `html=1`, texto plano si no) en sus líneas de texto:
 * `<b>Nombre</b><div>[Tipo]</div><br>Descripción` → `['Nombre', '[Tipo]', 'Descripción']`.
 */
export function labelToLines(label: string, isHtml: boolean): string[] {
  let text = label;
  if (isHtml) {
    text = decodeHtmlEntities(
      text
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*(div|p|li|h[1-6]|tr)\s*>/gi, '\n')
        .replace(/<\s*(div|p|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    );
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Línea del estilo `[Contenedor: Java]` o `[JSON/HTTPS]`; devuelve su contenido sin corchetes. */
export function bracketContent(line: string): string | null {
  const match = /^\[(.+)\]$/.exec(line);
  return match ? match[1].trim() : null;
}
