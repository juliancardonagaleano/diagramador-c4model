import { useEffect, useRef } from 'react';
import { pretty } from '@iark/kernel';
import { createIarkEmbed, type IarkEmbed } from '../../embed/iark-embed';
import './canvas.css';

export interface C4EmbedCanvasProps {
  /** Documento C4 válido actual; sin él el lienzo avisa. */
  document: unknown | undefined;
  text: string;
  viewId?: string;
  readOnly: boolean;
  theme?: 'light' | 'dark';
  onText(text: string): void;
  onView?(viewId: string): void;
  /** Elementos del documento que enlazan con otros módulos, para seguirlos desde aquí. */
  refs?: Array<{ id: string; name: string; ref: string }>;
  onFollow?(urn: string): void;
}

/**
 * Lienzo del módulo C4: el editor principal (`index.html`) embebido con su protocolo `postMessage`. El editor ya es
 * interactivo (arrastrar, conectar, C1 → C2 → C3, autolayout, atajos), así que el banco de trabajo solo sincroniza el
 * documento en ambos sentidos y la vista activa.
 */
export function C4EmbedCanvas({ document, text, viewId, readOnly, theme, onText, onView, refs = [], onFollow }: C4EmbedCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const embed = useRef<IarkEmbed | undefined>(undefined);
  /** Último documento que vino del editor, para no devolvérselo. */
  const fromEditor = useRef<string | undefined>(undefined);
  const ready = useRef(false);
  const latest = useRef({ document, text, onText, onView });
  latest.current = { document, text, onText, onView };

  useEffect(() => {
    if (!container.current) return;
    const url = new URL('./', window.location.href).toString();
    const instance = createIarkEmbed({
      container: container.current,
      url,
      origin: window.location.origin,
      autosave: true,
      ui: 'min',
      hideSidePanel: false,
      theme,
      readOnly,
      document: latest.current.document as never,
      iframeAttributes: { title: 'Editor C4', 'data-testid': 'c4-embed' },
      onLoad: () => {
        ready.current = true;
      },
      onChange: (doc) => {
        const next = pretty(doc);
        fromEditor.current = next;
        if (next !== latest.current.text) latest.current.onText(next);
      },
      onSave: ({ document: doc }) => {
        const next = pretty(doc);
        fromEditor.current = next;
        if (next !== latest.current.text) latest.current.onText(next);
      },
      onViewChange: ({ viewId: id }) => latest.current.onView?.(id),
    });
    embed.current = instance;
    return () => {
      instance.destroy();
      embed.current = undefined;
      ready.current = false;
    };
    // El iframe se crea una vez; el documento y la vista se sincronizan en los efectos siguientes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Documento cambiado fuera del editor (pestaña JSON, importación, «Cargar ejemplo»): se le envía al iframe.
  useEffect(() => {
    if (document === undefined || !ready.current || !embed.current) return;
    if (fromEditor.current === text) return;
    void embed.current.load(document as never, { readOnly, autosave: true, viewId }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, readOnly]);

  useEffect(() => {
    if (viewId && ready.current) embed.current?.setView(viewId);
  }, [viewId]);

  return (
    <div className="cv-root" data-testid="module-canvas" data-module="c4">
      {refs.length > 0 && onFollow && (
        <div className="cv-toolbar cv-refs" role="toolbar" aria-label="Enlaces a otros módulos">
          <span className="cv-edge-kind">Enlaces</span>
          {refs.map((r) => (
            <button key={r.id} type="button" className="cv-tool" onClick={() => onFollow(r.ref)} title={`Ir a ${r.ref}`} data-testid={`c4-ref-${r.id}`}>
              {r.name} ⤷
            </button>
          ))}
        </div>
      )}
      {document === undefined && (
        <div className="cv-empty" role="status">
          El documento no es válido: corrígelo en la pestaña JSON para volver a editarlo en el lienzo.
        </div>
      )}
      <div className="cv-embed" ref={container} hidden={document === undefined} />
    </div>
  );
}
