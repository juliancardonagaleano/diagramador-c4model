import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** Error al leer o interpretar un archivo de draw.io (mensaje pensado para mostrarse tal cual al usuario). */
export class DrawioImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawioImportError';
  }
}

/** Nodo XML mínimo: lo único que hace falta para leer un `.drawio`. */
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Texto directo del nodo, sin espacios en los extremos (el contenido de una página comprimida). */
  text: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  processEntities: true,
  // Decodifica también las referencias numéricas (`&#10;`, `&#x41;`) que emiten draw.io y este exportador.
  htmlEntities: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type ParsedItem = Record<string, unknown>;

function build(tag: string, items: ParsedItem[], rawAttrs: unknown): XmlNode {
  // Sin prototipo: un atributo llamado `__proto__` o `constructor` del archivo no puede pisar nada.
  const attrs = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries((rawAttrs ?? {}) as Record<string, unknown>)) {
    attrs[key.replace(/^@_/, '')] = String(value);
  }
  const node: XmlNode = { tag, attrs, children: [], text: '' };
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (key === ':@') continue;
      if (key === '#text') node.text += String(item[key]);
      else node.children.push(build(key, item[key] as ParsedItem[], item[':@']));
    }
  }
  node.text = node.text.trim();
  return node;
}

/**
 * Parsea y valida un documento XML. Rechaza los DOCTYPE/entidades propias (draw.io nunca los emite y son
 * el vector de las bombas de expansión de entidades) y da el motivo y la línea si el XML está mal formado.
 */
export function parseXml(text: string): XmlNode {
  const source = text.replace(/^﻿/, '');
  if (!source.trim()) throw new DrawioImportError('El archivo está vacío');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new DrawioImportError('El XML declara un DOCTYPE o entidades propias, que no se admiten por seguridad');
  }
  const valid = XMLValidator.validate(source);
  if (valid !== true) {
    throw new DrawioImportError(`El archivo no es un XML válido: ${valid.err.msg} (línea ${valid.err.line})`);
  }
  try {
    const items = parser.parse(source) as ParsedItem[];
    for (const item of items) {
      for (const key of Object.keys(item)) {
        if (key !== ':@' && key !== '#text') return build(key, item[key] as ParsedItem[], item[':@']);
      }
    }
  } catch (error) {
    if (error instanceof RangeError) throw new DrawioImportError('El XML está demasiado anidado');
    throw error;
  }
  throw new DrawioImportError('El archivo no contiene ningún elemento XML');
}
