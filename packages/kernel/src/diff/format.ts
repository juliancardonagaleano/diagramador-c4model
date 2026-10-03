import { labelOf, ROOT_COLLECTION, type ChangedEntry, type DiffEntry, type DocumentDiff, type FieldChange, type MovedEntry } from './diff';

/**
 * Presentación de un `DocumentDiff`: texto de consola (con `+ − ~`), Markdown para pegar en una PR o un changelog y JSON.
 * Funciones puras (devuelven texto): quien las llama decide dónde escribirlo.
 */

export interface DiffFormatOptions {
  /** Encabezado: en el texto, la primera línea; en Markdown, el título (por defecto «Cambios entre versiones»). */
  title?: string;
  /** Línea bajo el encabezado, p. ej. qué se comparó con qué. */
  subtitle?: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** «2 añadidos, 1 quitado, 3 modificados (5 campos)»; «Sin cambios.» si no hay nada que contar. */
export function diffSummaryLine(diff: DocumentDiff): string {
  const { added, removed, changed, moved, fields, total } = diff.summary;
  if (total === 0) return moved > 0 ? `Sin cambios de contenido (${plural(moved, 'elemento reordenado', 'elementos reordenados')}).` : 'Sin cambios.';
  const parts = [
    added > 0 && plural(added, 'añadido', 'añadidos'),
    removed > 0 && plural(removed, 'quitado', 'quitados'),
    changed > 0 && `${plural(changed, 'modificado', 'modificados')} (${plural(fields, 'campo', 'campos')})`,
  ].filter(Boolean);
  return `${parts.join(', ')}${moved > 0 ? `; además, ${plural(moved, 'reordenado', 'reordenados')} (el orden no cuenta como cambio)` : ''}.`;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Un valor del documento en una línea: las cadenas entre comillas, las listas entre corchetes, lo largo recortado. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '(sin valor)';
  if (typeof value === 'string') return clip(JSON.stringify(value), 80);
  if (Array.isArray(value)) {
    const shown = value.slice(0, 6).map((v) => (v !== null && typeof v === 'object' ? (Array.isArray(v) ? formatValue(v) : labelOf(v as Record<string, unknown>, '…')) : typeof v === 'string' ? v : String(v)));
    return clip(`[${shown.join(', ')}${value.length > 6 ? `, … (+${value.length - 6})` : ''}]`, 100);
  }
  if (value !== null && typeof value === 'object') return clip(JSON.stringify(value), 100);
  return String(value);
}

/** `tags: +beta −legacy` para una lista de valores; `name: "A" → "B"` para el resto. */
function fieldText(field: FieldChange, quote: (text: string) => string): string {
  if (field.added || field.removed) {
    const parts = [...(field.added ?? []).map((v) => `+${quote(String(v))}`), ...(field.removed ?? []).map((v) => `−${quote(String(v))}`)];
    return parts.join(' ');
  }
  return `${quote(formatValue(field.before))} → ${quote(formatValue(field.after))}`;
}

/** El id solo se muestra si dice algo más que la etiqueta (y no en las posiciones `#2` ni en los campos sueltos del documento). */
const showsId = (e: DiffEntry): boolean => e.label !== e.id && !e.id.startsWith('#') && e.collection !== ROOT_COLLECTION;
const identity = (e: DiffEntry): string => `${e.label}${showsId(e) ? ` (${e.id})` : ''}${e.kind ? ` · ${e.kind}` : ''}`;

interface Group {
  collection: string;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: ChangedEntry[];
  moved: MovedEntry[];
}

/** Las entradas agrupadas por lista, en el orden del documento. */
function groups(diff: DocumentDiff): Group[] {
  return Object.keys(diff.summary.byCollection).map((collection) => ({
    collection,
    added: diff.added.filter((e) => e.collection === collection),
    removed: diff.removed.filter((e) => e.collection === collection),
    changed: diff.changed.filter((e) => e.collection === collection),
    moved: diff.moved.filter((e) => e.collection === collection),
  }));
}

/**
 * Texto de consola:
 *
 *     2 añadidos, 1 quitado, 1 modificado (2 campos).
 *
 *     model.elements
 *       + Cliente (cliente) · person
 *       − Base de datos (db) · container
 *       ~ API (api) · container
 *           name: "API" → "API v2"
 *           tags: +beta −legacy
 */
export function formatDiffText(diff: DocumentDiff, options: DiffFormatOptions = {}): string {
  const lines: string[] = [];
  if (options.title) lines.push(options.title);
  if (options.subtitle) lines.push(options.subtitle);
  lines.push(diffSummaryLine(diff));
  for (const group of groups(diff)) {
    lines.push('', group.collection);
    for (const e of group.added) lines.push(`  + ${identity(e)}`);
    for (const e of group.removed) lines.push(`  − ${identity(e)}`);
    for (const e of group.changed) {
      // Los campos sueltos del documento no son un elemento: se listan directamente bajo `documento`.
      if (e.collection === ROOT_COLLECTION) for (const f of e.fields) lines.push(`  ~ ${f.path}: ${fieldText(f, (t) => t)}`);
      else {
        lines.push(`  ~ ${identity(e)}`);
        for (const f of e.fields) lines.push(`      ${f.path}: ${fieldText(f, (t) => t)}`);
      }
    }
    if (group.moved.length > 0) lines.push(`  ↕ ${plural(group.moved.length, 'elemento reordenado', 'elementos reordenados')} (solo cambia el orden; el detalle, en --format json)`);
  }
  return `${lines.join('\n')}\n`;
}

const MD_SPECIAL = /([\\`*_[\]<>|#])/g;
const escapeMd = (text: string): string => text.replace(MD_SPECIAL, '\\$1');
/** Texto en código en línea; si el texto lleva comillas invertidas, con una valla más larga. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Markdown para una PR o un changelog: un apartado por lista, con lo añadido, quitado y modificado (y sus campos antes → después). */
export function formatDiffMarkdown(diff: DocumentDiff, options: DiffFormatOptions = {}): string {
  const lines: string[] = [`## ${escapeMd(options.title ?? 'Cambios entre versiones')}`];
  if (options.subtitle) lines.push('', options.subtitle);
  lines.push('', `**${diffSummaryLine(diff)}**`);
  const who = (e: DiffEntry): string => `${escapeMd(e.label)}${showsId(e) ? ` (${code(e.id)})` : ''}${e.kind ? ` · ${escapeMd(e.kind)}` : ''}`;
  for (const group of groups(diff)) {
    lines.push('', `### ${code(group.collection)}`, '');
    for (const e of group.added) lines.push(`- **Añadido:** ${who(e)}`);
    for (const e of group.removed) lines.push(`- **Quitado:** ${who(e)}`);
    for (const e of group.changed) {
      if (e.collection === ROOT_COLLECTION) for (const f of e.fields) lines.push(`- **Modificado:** ${code(f.path)}: ${fieldText(f, code)}`);
      else {
        lines.push(`- **Modificado:** ${who(e)}`);
        for (const f of e.fields) lines.push(`  - ${code(f.path)}: ${fieldText(f, code)}`);
      }
    }
    if (group.moved.length > 0) lines.push(`- **Reordenado:** ${plural(group.moved.length, 'elemento', 'elementos')} (solo cambia el orden, no cuenta como cambio)`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatDiffJson(diff: DocumentDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}
