/**
 * Vista previa renderizada de Mermaid. La librería `mermaid` es pesada (cada tipo de diagrama es un trozo aparte), así
 * que solo se descarga la primera vez que alguien pide ver el dibujo; el resto de la aplicación no la carga.
 */

export type MermaidRender =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; message: string };

type MermaidApi = typeof import('mermaid').default;

let loading: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    // `strict` sanea el SVG (sin scripts ni HTML libre) y `suppressErrorRendering` evita que Mermaid pegue su propio
    // dibujo de error en el documento: los errores se devuelven como resultado y los muestra quien llama.
    // Las etiquetas van como texto SVG (no como HTML dentro de `foreignObject`): el dibujo se muestra en un `<img>`,
    // donde el HTML incrustado se ve peor y algunos navegadores lo omiten.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false } });
    return mermaid;
  });
  // Si el trozo no se pudo descargar (sin red), el siguiente intento vuelve a probar en vez de quedarse con el fallo.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

// `mermaid.render` no admite dos dibujos a la vez (comparten un contenedor temporal), así que se encolan.
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

/** Tamaño natural del SVG según su `viewBox` (Mermaid lo entrega con `width="100%"`, que en un `<img>` no dice nada). */
export function svgSize(svg: string): { width: number; height: number } {
  const match = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  return width > 0 && height > 0 ? { width: Math.ceil(width), height: Math.ceil(height) } : { width: 640, height: 360 };
}

/** Motivo del fallo tal como lo da Mermaid (los de sintaxis traen el fragmento con una flecha bajo el error), acotado. */
function reason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim() || 'Error desconocido';
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/**
 * El `<img>` exige XML bien formado y Mermaid puede dejar HTML suelto (`<br>`) dentro de un `foreignObject`. Si el SVG no
 * es XML válido se vuelve a serializar a partir del árbol que forma el navegador, que sí lo es.
 */
export function wellFormedSvg(svg: string): string {
  if (!new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')) return svg;
  const root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  if (!root) return svg;
  // El serializador declara él mismo los espacios de nombres: los `xmlns` que quedaron como atributos saldrían duplicados.
  for (const node of [root, ...root.querySelectorAll('*')]) node.removeAttribute('xmlns');
  return new XMLSerializer().serializeToString(root);
}

async function draw(text: string): Promise<MermaidRender> {
  if (!text.trim()) return { ok: false, message: 'No hay texto de Mermaid que dibujar.' };
  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch (error) {
    return { ok: false, message: `No se pudo cargar la librería de Mermaid: ${reason(error)}` };
  }
  const id = `iark-mermaid-${++counter}`;
  try {
    const rendered = await mermaid.render(id, text);
    const svg = wellFormedSvg(rendered.svg);
    return { ok: true, svg, ...svgSize(svg) };
  } catch (error) {
    // Aun con el error suprimido, Mermaid puede dejar su contenedor temporal en el documento.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
    return { ok: false, message: reason(error) };
  }
}

/** Dibuja el texto de Mermaid y devuelve el SVG, o el motivo por el que no se pudo. Nunca lanza. */
export function renderMermaid(text: string): Promise<MermaidRender> {
  const run = queue.then(() => draw(text));
  queue = run;
  return run;
}
