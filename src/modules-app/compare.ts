import { analyzeText, analyzeValue, importText, type AnyModule, type DiffEntry, type DocumentDiff } from '@iark/kernel';

/**
 * Comparar versiones en el banco de trabajo: lo que no es interfaz. Se abre (o pega) otra versión del documento, se compara
 * en el navegador con `diffDocuments` y de la diferencia salen las marcas del lienzo (qué elementos son nuevos y cuáles
 * cambiaron) y los elementos que ya no están.
 */

export type ComparableResult = { ok: true; document: unknown; importer?: string } | { ok: false; reason: string };

/**
 * El documento que hay en el texto de un archivo abierto (o pegado) para compararlo: el JSON del módulo, validado con su
 * esquema, o cualquier fuente que un importador del módulo reconozca (como al abrir un archivo en el banco de trabajo).
 */
export async function readComparable(module: AnyModule, text: string, file: string): Promise<ComparableResult> {
  if (!text.trim()) return { ok: false, reason: 'No hay nada que comparar: el texto está vacío.' };
  if (/\.json$/i.test(file) || /^\s*(\{|\[|```json)/i.test(text)) {
    const analysis = analyzeText(module, text);
    if (analysis.status === 'ok') return { ok: true, document: analysis.document };
    // Un JSON que no es del módulo pero que un importador reconoce (el manifest.json de dbt, un plan de Terraform) se importa.
    if (!module.importers.some((i) => i.detect?.(text))) {
      if (analysis.status === 'syntax') return { ok: false, reason: `«${file}» no es JSON válido: ${analysis.error}` };
      if (analysis.status === 'schema') {
        const first = analysis.issues[0];
        return { ok: false, reason: `«${file}» no cumple el esquema del módulo «${module.id}» (${analysis.issues.length} problemas; el primero: ${first.path}: ${first.message}).` };
      }
    }
  }
  try {
    const imported = await importText(module, text, undefined, { file, fallbackName: file.replace(/\.[^.]+$/, '') });
    const analysis = analyzeValue(module, imported.document);
    if (analysis.status !== 'ok') return { ok: false, reason: `«${file}» se importó, pero el resultado no cumple el esquema del módulo «${module.id}».` };
    return { ok: true, document: analysis.document, importer: imported.importer };
  } catch (error) {
    return { ok: false, reason: `No se pudo leer «${file}» como un documento del módulo «${module.id}»: ${(error as Error).message}` };
  }
}

export type Mark = 'added' | 'modified';

/** Lo que ve el lienzo de la comparación: qué elementos marcar y cuáles de la versión base ya no están. */
export interface CanvasCompare {
  marks: ReadonlyMap<string, Mark>;
  /** Ids de los elementos de la versión base que ya no están en el documento actual. */
  removed: ReadonlySet<string>;
  /** La versión base, para dibujar de ella los elementos quitados. */
  base: unknown;
}

const NESTED = /^[^[\]]+\[(.+?)\]\./;

/** Un elemento anidado (la columna de una tabla, un elemento de una vista) cuelga de otro: el de la lista `assets[t].columns` es `t`. */
export const isNested = (entry: DiffEntry): boolean => NESTED.test(entry.collection);

/**
 * El elemento del documento al que se refiere un cambio, y que se puede seleccionar en el lienzo: él mismo, o el elemento del que
 * cuelga si es una parte suya (una columna, un paso). Los campos sueltos del documento y las listas sin ids no tienen ninguno.
 */
export function elementOf(entry: DiffEntry): string | undefined {
  if (entry.collection === 'documento') return undefined;
  const parent = NESTED.exec(entry.collection)?.[1];
  if (parent) return parent;
  return entry.id.startsWith('#') ? undefined : entry.id;
}

/**
 * Marcas del lienzo: lo añadido es nuevo; lo modificado, y todo elemento que gana, pierde o cambia una parte suya, es modificado;
 * lo quitado no está en el documento actual (se lista y, si el lienzo puede, se dibuja como fantasma).
 */
export function compareMarks(diff: DocumentDiff, base: unknown): CanvasCompare {
  const marks = new Map<string, Mark>();
  const removed = new Set<string>();
  for (const e of diff.added) {
    const id = elementOf(e);
    if (!id) continue;
    if (isNested(e)) marks.set(id, marks.get(id) ?? 'modified');
    else marks.set(id, 'added');
  }
  for (const e of diff.changed) {
    const id = elementOf(e);
    if (id && marks.get(id) !== 'added') marks.set(id, 'modified');
  }
  for (const e of diff.removed) {
    const id = elementOf(e);
    if (!id) continue;
    if (isNested(e)) marks.set(id, marks.get(id) ?? 'modified');
    else removed.add(id);
  }
  return { marks, removed, base };
}
