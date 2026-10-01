import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, stringify, type Document, type YAMLParseError } from 'yaml';
import { describeJsonError, isRecord, orderKeys, parseJson, prettyJson, stripBom, type TextPosition } from './json';

export type Path = ReadonlyArray<string | number>;
export type Locate = (path: Path) => TextPosition | undefined;

export interface Parsed {
  kind: 'json' | 'yaml';
  value: unknown;
  /** Posición en el texto de una ruta del documento (la clave o el elemento); `undefined` si no se puede ubicar. */
  locate: Locate;
}

export type ParseOutcome = ({ ok: true } & Parsed) | { ok: false; message: string; line: number; column: number };

const YAML_OUTPUT = { indent: 2, lineWidth: 0 } as const;

export class Reporter {
  readonly diagnostics: AttachmentDiagnostic[] = [];

  constructor(private readonly locate?: Locate) {}

  add(severity: AttachmentDiagnostic['severity'], message: string, path?: Path): void {
    const at = path ? this.locate?.(path) : undefined;
    this.diagnostics.push(at ? { severity, message, line: at.line, column: at.column } : { severity, message });
  }

  error(message: string, path?: Path): void {
    this.add('error', message, path);
  }

  warning(message: string, path?: Path): void {
    this.add('warning', message, path);
  }

  info(message: string, path?: Path): void {
    this.add('info', message, path);
  }
}

/** Los diagnósticos sin posición primero y el resto por línea y columna; a igual posición se conserva el orden de detección. */
export function sortDiagnostics(list: AttachmentDiagnostic[]): AttachmentDiagnostic[] {
  const rank = (item: AttachmentDiagnostic): number => (item.line === undefined ? -1 : item.line * 100000 + (item.column ?? 0));
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

export function failureDiagnostic(failure: { message: string; line: number; column: number }): AttachmentDiagnostic[] {
  return [{ severity: 'error', message: failure.message, line: failure.line, column: failure.column }];
}

export function slugify(text: string, fallback: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function pascalCase(text: string, fallback: string): string {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  if (!joined) return fallback;
  return /^[0-9]/.test(joined) ? `${fallback}${joined}` : joined;
}

export function looksLikeJson(text: string): boolean {
  return /^\s*[{[]/.test(stripBom(text));
}

export function parseStructured(text: string, allowYaml: boolean): ParseOutcome {
  const source = stripBom(text);
  if (!allowYaml || looksLikeJson(source)) {
    const result = parseJson(source);
    return result.ok ? { ok: true, kind: 'json', value: result.value, locate: lazyLocator(source) } : result;
  }
  const read = readYaml(source);
  if (!read.ok) return read;
  try {
    return { ok: true, kind: 'yaml', value: read.doc.toJS(), locate: documentLocator(read.doc, read.lineCounter) };
  } catch (error) {
    return { ok: false, message: `YAML no válido: ${error instanceof Error ? error.message : String(error)}`, line: 1, column: 1 };
  }
}

export function reformatStructured(text: string, options: { yaml: boolean; order?: readonly string[] }): AttachmentTextResult {
  const source = stripBom(text);
  if (!options.yaml || looksLikeJson(source)) {
    const parsed = parseJson(source);
    if (!parsed.ok) return { ok: false, reason: describeJsonError(parsed) };
    return { ok: true, text: prettyJson(orderValue(parsed.value, options.order)) };
  }
  const read = readYaml(source);
  if (!read.ok) return { ok: false, reason: describeJsonError(read) };
  const { doc } = read;
  if (options.order && isMap(doc.contents)) {
    const order = options.order;
    const rank = (item: { key: unknown }): number => {
      const index = isScalar(item.key) ? order.indexOf(String(item.key.value)) : -1;
      return index === -1 ? order.length : index;
    };
    doc.contents.items.sort((a, b) => rank(a) - rank(b));
  }
  return { ok: true, text: doc.toString(YAML_OUTPUT) };
}

/** Un origen YAML que se pide en YAML se reescribe sin pasar por JSON para no perder sus comentarios. */
export function convertStructured(text: string, target: 'json' | 'yaml', order?: readonly string[]): AttachmentTextResult {
  const source = stripBom(text);
  if (target === 'yaml' && !looksLikeJson(source)) return reformatStructured(source, { yaml: true, order });
  const parsed = parseStructured(source, true);
  if (!parsed.ok) return { ok: false, reason: describeJsonError(parsed) };
  const value = orderValue(parsed.value, order);
  return { ok: true, text: target === 'json' ? prettyJson(value) : stringify(value, YAML_OUTPUT) };
}

function orderValue(value: unknown, order?: readonly string[]): unknown {
  return order && isRecord(value) ? orderKeys(value, order) : value;
}

export function checkInfo(info: unknown, report: Reporter): void {
  if (!isRecord(info)) {
    report.error('Falta «info» (un objeto con «title» y «version»).', []);
    return;
  }
  if (typeof info.title !== 'string' || info.title.trim() === '') report.error('Falta «info.title» (texto no vacío).', ['info']);
  if (info.version === undefined || info.version === null || info.version === '') report.error('Falta «info.version».', ['info']);
  else if (typeof info.version !== 'string') report.error('«info.version» debe ser texto; en YAML ponla entre comillas (p. ej. "1.0.0").', ['info', 'version']);
}

const DATA_KEYS = new Set(['example', 'default', 'enum', 'const']);

/** Valor al que apunta una referencia local (`#/components/schemas/X`), o `undefined` si no existe. */
export function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  const pointer = ref.slice(1);
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let node = root;
  for (const part of pointer.slice(1).split('/')) {
    const key = decodePointerPart(part);
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(key) || Number(key) >= node.length) return undefined;
      node = node[Number(key)];
    } else if (isRecord(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** Comprueba los `$ref` locales; los que apuntan a otros documentos o a anclas no se verifican. */
export function checkLocalRefs(root: unknown, report: Reporter): void {
  const checkRef = (node: Record<string, unknown>, path: Path): void => {
    const ref = node.$ref;
    if (typeof ref !== 'string' || !/^#(\/|$)/.test(ref)) return;
    if (resolveLocalRef(root, ref) === undefined) report.error(`La referencia «${ref}» no existe en el documento.`, [...path, '$ref']);
  };
  const visit = (node: unknown, path: Path): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!isRecord(node)) return;
    checkRef(node, path);
    for (const [key, child] of Object.entries(node)) {
      if (DATA_KEYS.has(key)) continue;
      if (key === 'examples') {
        if (isRecord(child)) for (const [name, example] of Object.entries(child)) if (isRecord(example)) checkRef(example, [...path, key, name]);
        continue;
      }
      visit(child, [...path, key]);
    }
  };
  visit(root, []);
}

function decodePointerPart(part: string): string {
  let decoded = part;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    decoded = part;
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

const YAML_MESSAGES: Record<string, string> = {
  BAD_INDENT: 'sangría incorrecta',
  TAB_AS_INDENT: 'no se pueden usar tabuladores para sangrar',
  DUPLICATE_KEY: 'clave duplicada en el mismo mapa',
  MISSING_CHAR: 'falta un carácter de cierre o de separación',
  MULTIPLE_DOCS: 'hay varios documentos YAML (separados por ---) y solo se admite uno',
  UNEXPECTED_TOKEN: 'elemento inesperado',
  BLOCK_AS_IMPLICIT_KEY: 'una clave implícita no puede ser un bloque',
  BLOCK_IN_FLOW: 'un bloque no puede ir dentro de una colección de flujo ({…} o […])',
  BAD_SCALAR_START: 'un valor no puede empezar por ese carácter (ponlo entre comillas)',
  MULTILINE_IMPLICIT_KEY: 'una clave implícita debe ocupar una sola línea',
  BAD_ALIAS: 'alias no válido',
  BAD_DQ_ESCAPE: 'secuencia de escape no válida en una cadena entre comillas dobles',
  TAG_RESOLVE_FAILED: 'etiqueta no reconocida',
  BAD_DIRECTIVE: 'directiva no válida',
  MULTIPLE_ANCHORS: 'un nodo no puede tener varias anclas',
  MULTIPLE_TAGS: 'un nodo no puede tener varias etiquetas',
  KEY_OVER_1024_CHARS: 'una clave implícita no puede superar los 1024 caracteres',
};

type ReadResult = { ok: true; doc: Document; lineCounter: LineCounter } | { ok: false; message: string; line: number; column: number };

function readYaml(source: string): ReadResult {
  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(source, { lineCounter, prettyErrors: false });
  } catch (error) {
    return { ok: false, message: `YAML no válido: ${error instanceof Error ? error.message : String(error)}`, line: 1, column: 1 };
  }
  const first: YAMLParseError | undefined = doc.errors[0];
  if (first) {
    const at = lineCounter.linePos(first.pos[0]);
    const reason = YAML_MESSAGES[first.code] ?? first.message.split('\n')[0] ?? first.code;
    return { ok: false, message: `YAML no válido: ${reason}`, line: at.line, column: at.col };
  }
  return { ok: true, doc, lineCounter };
}

function lazyLocator(source: string): Locate {
  let ready: Locate | null | undefined;
  return (path) => {
    if (ready === undefined) {
      try {
        const lineCounter = new LineCounter();
        ready = documentLocator(parseDocument(source, { lineCounter, prettyErrors: false }), lineCounter);
      } catch {
        ready = null;
      }
    }
    return ready ? ready(path) : undefined;
  };
}

function rangeStart(node: unknown): number | undefined {
  return (node as { range?: [number, number, number] | null } | null | undefined)?.range?.[0];
}

function documentLocator(doc: Document, lineCounter: LineCounter): Locate {
  return (path) => {
    let node: unknown = doc.contents;
    let offset = rangeStart(node);
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        offset = rangeStart(pair.key) ?? offset;
        node = pair.value;
      } else if (isSeq(node)) {
        const item: unknown = node.items[Number(segment)];
        if (item === undefined) break;
        offset = rangeStart(item) ?? offset;
        node = item;
      } else {
        break;
      }
    }
    if (offset === undefined) return undefined;
    const at = lineCounter.linePos(offset);
    return { line: at.line, column: at.col };
  };
}
