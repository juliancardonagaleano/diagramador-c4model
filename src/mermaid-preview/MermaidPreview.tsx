import { useEffect, useState } from 'react';
import './mermaid-preview.css';
import { renderMermaid, type MermaidRender } from './render';

/** Data URL de un SVG: en un `<img>` no ejecuta scripts ni recibe los estilos de la página. */
const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export interface MermaidPreviewProps {
  /** Texto de Mermaid a dibujar. */
  text: string;
  /** Descripción accesible del dibujo. */
  label?: string;
}

/** Dibuja un texto de Mermaid (la librería se descarga la primera vez). Muestra el motivo si no se puede dibujar. */
export function MermaidPreview({ text, label = 'Vista previa de Mermaid' }: MermaidPreviewProps) {
  const [result, setResult] = useState<{ text: string; render: MermaidRender } | undefined>();
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    let current = true;
    void renderMermaid(text).then((render) => {
      if (current) setResult({ text, render });
    });
    return () => {
      current = false;
    };
  }, [text]);

  // Mientras el texto nuevo se dibuja no se enseña el dibujo del anterior como si fuera suyo.
  const render = result?.text === text ? result.render : undefined;
  if (!render) {
    return (
      <p className="mmd-status" role="status">
        Dibujando con Mermaid…
      </p>
    );
  }
  if (!render.ok) {
    return (
      <p className="mmd-error" role="alert">
        No se pudo dibujar: {render.message}
      </p>
    );
  }
  return (
    <div className="mmd-preview">
      <label className="mmd-actual">
        <input type="checkbox" checked={actualSize} onChange={(e) => setActualSize(e.target.checked)} /> Tamaño real
      </label>
      <div className={`mmd-canvas${actualSize ? ' actual' : ''}`} data-testid="mermaid-preview">
        <img src={svgDataUrl(render.svg)} width={render.width} height={render.height} alt={label} />
      </div>
    </div>
  );
}
