/** Descarga `data` como archivo desde el navegador. */
export function downloadText(fileName: string, data: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: `${mime};charset=utf-8` }));
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Data URL de un SVG: en un `<img>` no ejecuta scripts aunque el contenido venga de una fuente externa. */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const readFile = (file: File): Promise<string> => file.text();

/** Nombre de archivo seguro para descargar a partir del nombre del documento. */
export function fileStem(name: string | undefined, fallback: string): string {
  const stem = (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return stem || fallback;
}
