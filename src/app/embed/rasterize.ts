/**
 * Convierte un SVG autocontenido en un PNG (data URL) dibujándolo en un lienzo del navegador. El SVG no lleva fuentes ni
 * hojas de estilo externas, así que el navegador lo pinta tal cual; `scale` multiplica la resolución (2 = nítido en pantallas
 * densas).
 */
export function svgToPngDataUrl(svg: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const size = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    const width = size ? Number(size[1]) : 1200;
    const height = size ? Number(size[2]) : 800;
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('El navegador no ofrece un lienzo 2D para generar el PNG.');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo dibujar el SVG para convertirlo en PNG.'));
    };
    image.src = url;
  });
}
