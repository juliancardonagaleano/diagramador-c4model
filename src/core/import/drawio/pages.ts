import { DrawioImportError, parseXml, type XmlNode } from './xml';

/** Celda de draw.io ya normalizada (sea un `<mxCell>` suelto o envuelto en `<object>`/`<UserObject>`). */
export interface RawCell {
  id: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  visible: boolean;
  style: string;
  /** Etiqueta cruda (puede ser HTML y contener placeholders `%prop%` sin resolver). */
  value: string;
  /** Propiedades del `<object>` (c4Name, link, placeholders…); vacío si la celda no estaba envuelta. */
  attrs: Record<string, string>;
  geometry?: { x?: number; y?: number; width?: number; height?: number; relative: boolean };
}

export interface DrawioPage {
  /** Id de la página (`<diagram id>`), usado por los enlaces `data:page/id,<id>`. */
  id?: string;
  name: string;
  cells: RawCell[];
}

/** Tope de la descompresión de una página: protege de archivos que se expanden de forma desproporcionada. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const COMPRESSED_UNSUPPORTED =
  'Este entorno no puede descomprimir páginas comprimidas de draw.io (requiere Node 20.12+ o un navegador reciente). ' +
  'En draw.io usa Archivo ▸ Propiedades, desmarca «Comprimido» y vuelve a guardar el archivo.';

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw')) as ReadableStream<Uint8Array>;
  } catch {
    throw new DrawioImportError(COMPRESSED_UNSUPPORTED);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_INFLATED_BYTES) {
        await reader.cancel();
        throw new DrawioImportError('Una página comprimida se expande a demasiado tamaño; el archivo no parece un diagrama de draw.io');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DrawioImportError) throw error;
    throw new DrawioImportError('No se pudo descomprimir una página del archivo: los datos están corruptos');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Contenido de una página comprimida: base64 → deflate sin cabecera → texto (URL-encoded) → XML. */
async function decodeDiagram(content: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const binary = atob(content.replace(/\s+/g, ''));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    throw new DrawioImportError('El contenido de una página no es un diagrama de draw.io (ni XML ni base64 comprimido)');
  }
  const text = new TextDecoder().decode(await inflateRaw(bytes));
  if (text.trimStart().startsWith('<')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    throw new DrawioImportError('No se pudo decodificar una página comprimida del archivo');
  }
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toCell(node: XmlNode): RawCell | null {
  const wrapped = node.tag === 'object' || node.tag === 'UserObject';
  if (!wrapped && node.tag !== 'mxCell') return null;
  const inner = wrapped ? node.children.find((c) => c.tag === 'mxCell') : node;
  if (!inner) return null;
  const id = (wrapped ? node.attrs.id : inner.attrs.id) ?? '';
  if (id === '') return null;

  const attrs = Object.create(null) as Record<string, string>;
  if (wrapped) {
    for (const [key, value] of Object.entries(node.attrs)) if (key !== 'id' && key !== 'label') attrs[key] = value;
  }
  const geo = inner.children.find((c) => c.tag === 'mxGeometry');
  return {
    id,
    parent: inner.attrs.parent,
    source: inner.attrs.source,
    target: inner.attrs.target,
    vertex: inner.attrs.vertex === '1',
    edge: inner.attrs.edge === '1',
    visible: inner.attrs.visible !== '0' && node.attrs.visible !== '0',
    style: inner.attrs.style ?? '',
    value: (wrapped ? (node.attrs.label ?? inner.attrs.value) : inner.attrs.value) ?? '',
    attrs,
    geometry: geo
      ? { x: num(geo.attrs.x), y: num(geo.attrs.y), width: num(geo.attrs.width), height: num(geo.attrs.height), relative: geo.attrs.relative === '1' }
      : undefined,
  };
}

function cellsOf(model: XmlNode): RawCell[] {
  const root = model.children.find((c) => c.tag === 'root');
  if (!root) return [];
  const cells: RawCell[] = [];
  for (const child of root.children) {
    const cell = toCell(child);
    if (cell) cells.push(cell);
  }
  return cells;
}

/**
 * Lee las páginas de un archivo de draw.io: `<mxfile>` con `<diagram>` (sin comprimir o comprimidos) o un
 * `<mxGraphModel>` suelto (lo que da "Extras ▸ Editar diagrama").
 */
export async function readPages(text: string): Promise<DrawioPage[]> {
  const root = parseXml(text);
  if (root.tag === 'mxGraphModel') return [{ name: 'Página 1', cells: cellsOf(root) }];
  if (root.tag !== 'mxfile') {
    throw new DrawioImportError(`No parece un archivo de draw.io: se esperaba <mxfile> o <mxGraphModel> y se encontró <${root.tag}>`);
  }
  const diagrams = root.children.filter((c) => c.tag === 'diagram');
  if (diagrams.length === 0) throw new DrawioImportError('El archivo de draw.io no contiene ninguna página');

  const pages: DrawioPage[] = [];
  for (const [i, diagram] of diagrams.entries()) {
    let model = diagram.children.find((c) => c.tag === 'mxGraphModel');
    if (!model && diagram.text) {
      const decoded = parseXml(await decodeDiagram(diagram.text));
      if (decoded.tag !== 'mxGraphModel') throw new DrawioImportError(`La página ${i + 1} comprimida no contiene un <mxGraphModel>`);
      model = decoded;
    }
    pages.push({ id: diagram.attrs.id, name: diagram.attrs.name?.trim() || `Página ${i + 1}`, cells: model ? cellsOf(model) : [] });
  }
  return pages;
}
