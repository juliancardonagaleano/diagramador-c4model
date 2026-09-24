import type { C4Document, LayoutDirection } from '../core/model/types';
import type { EmbedEvent, ExportFormat, HostAction, LoadAction } from './protocol';

export type { EmbedEvent, ExportFormat, HostAction, C4Document };

/**
 * SDK de anfitrión: crea un iframe con el diagramador en modo embebido y
 * gestiona el protocolo postMessage (handshake `init` → `load`, eventos, acciones).
 *
 *   const embed = createC4Embed({ container: '#editor', url: 'https://mi-host/diagramador/', document, autosave: true,
 *     onSave: ({ document, drawio }) => guardar(document), onExit: () => cerrar() });
 *   const xml = await embed.export('drawio');
 */
export interface C4EmbedOptions {
  /** Elemento (o selector) donde insertar el iframe. */
  container: HTMLElement | string;
  /** URL de la app del diagramador (se le añaden `embed=1&proto=json`). */
  url: string;
  /** Documento inicial (objeto o JSON). Si se omite, se abre en blanco. */
  document?: C4Document | string;
  autosave?: boolean;
  title?: string;
  readOnly?: boolean;
  theme?: 'light' | 'dark';
  ui?: 'full' | 'min';
  hideSidePanel?: boolean;
  /** Ejecutar autolayout al cargar. */
  autoLayout?: boolean;
  /** Origen esperado del iframe (targetOrigin). Por defecto se deduce de `url`. */
  origin?: string;
  /** Atributos extra del iframe (por ejemplo `title`, `allow`). */
  iframeAttributes?: Record<string, string>;
  onInit?: () => void;
  onLoad?: (payload: { document: C4Document; viewId?: string }) => void;
  onChange?: (document: C4Document) => void;
  onSave?: (payload: { document: C4Document; drawio?: string; exit: boolean }) => void;
  onExit?: (payload: { modified: boolean }) => void;
  onExport?: (payload: { format: ExportFormat; data: string; viewId?: string }) => void;
  /** El usuario navegó a otra vista (C1/C2/C3), por doble clic, breadcrumb o `setView`. */
  onViewChange?: (payload: { viewId: string; level: 'C1' | 'C2' | 'C3'; scopeId?: string; title?: string }) => void;
  onError?: (payload: { message: string; issues?: Array<{ path: string; message: string }> }) => void;
  /** Recibe todos los eventos del iframe. */
  onEvent?: (event: EmbedEvent) => void;
}

export interface C4Embed {
  iframe: HTMLIFrameElement;
  /** Promesa que se resuelve cuando el diagramador ha cargado el documento inicial. */
  ready: Promise<void>;
  load(document?: C4Document | string, options?: Omit<LoadAction, 'action' | 'document'>): Promise<C4Document>;
  merge(document: C4Document | string, autoLayout?: boolean): void;
  /** Exporta; para `drawio`, `notation` elige entre la librería C4 de draw.io ('c4', por defecto) y tarjetas ('card'). */
  export(format: ExportFormat, viewId?: string, notation?: 'c4' | 'card'): Promise<string>;
  autoLayout(options?: { viewId?: string; direction?: LayoutDirection; force?: boolean }): void;
  setView(viewId: string): void;
  status(message: string, modified?: boolean): void;
  dialog(title: string, message: string, button?: string): void;
  /** Pide al diagramador que emita `save` (y `exit` si se indica). */
  save(exit?: boolean): void;
  send(action: HostAction): void;
  destroy(): void;
}

export function createC4Embed(options: C4EmbedOptions): C4Embed {
  const container =
    typeof options.container === 'string' ? document.querySelector<HTMLElement>(options.container) : options.container;
  if (!container) throw new Error('createC4Embed: no se encontró el contenedor');

  const url = new URL(options.url, window.location.href);
  url.searchParams.set('embed', '1');
  url.searchParams.set('proto', 'json');
  url.searchParams.set('origin', window.location.origin);
  if (options.ui) url.searchParams.set('ui', options.ui);
  if (options.theme) url.searchParams.set('theme', options.theme);
  const targetOrigin = options.origin ?? url.origin;

  const iframe = document.createElement('iframe');
  iframe.src = url.toString();
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.setAttribute('title', options.title ?? 'Diagramador C4');
  for (const [k, v] of Object.entries(options.iframeAttributes ?? {})) iframe.setAttribute(k, v);
  container.appendChild(iframe);

  const send = (action: HostAction) => {
    iframe.contentWindow?.postMessage(JSON.stringify(action), targetOrigin);
  };

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const pendingExports = new Map<string, { resolve: (data: string) => void; reject: (e: Error) => void }>();
  const pendingLoads: Array<{ resolve: (doc: C4Document) => void; reject: (e: Error) => void }> = [];
  let counter = 0;

  const initialLoad = (): HostAction => ({
    action: 'load',
    document: options.document,
    autosave: options.autosave,
    title: options.title,
    readOnly: options.readOnly,
    theme: options.theme,
    autoLayout: options.autoLayout,
  });

  const listener = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (targetOrigin !== '*' && event.origin !== targetOrigin) return;
    let data: unknown = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object' || !('event' in data)) return;
    const msg = data as EmbedEvent;
    options.onEvent?.(msg);
    switch (msg.event) {
      case 'configure':
        send({
          action: 'configure',
          theme: options.theme,
          ui: options.ui,
          hideSidePanel: options.hideSidePanel,
        });
        break;
      case 'init':
        options.onInit?.();
        send(initialLoad());
        break;
      case 'load':
        resolveReady();
        pendingLoads.splice(0).forEach((p) => p.resolve(msg.document));
        options.onLoad?.({ document: msg.document, viewId: msg.viewId });
        break;
      case 'change':
      case 'autosave':
        options.onChange?.(msg.document);
        break;
      case 'save':
        options.onSave?.({ document: msg.document, drawio: msg.drawio, exit: msg.exit });
        break;
      case 'viewChange':
        options.onViewChange?.({ viewId: msg.viewId, level: msg.level, scopeId: msg.scopeId, title: msg.title });
        break;
      case 'exit':
        options.onExit?.({ modified: msg.modified });
        break;
      case 'export': {
        const p = msg.requestId ? pendingExports.get(msg.requestId) : undefined;
        if (p && msg.requestId) {
          pendingExports.delete(msg.requestId);
          p.resolve(msg.data);
        }
        options.onExport?.({ format: msg.format, data: msg.data, viewId: msg.viewId });
        break;
      }
      case 'error': {
        const p = msg.requestId ? pendingExports.get(msg.requestId) : undefined;
        if (p && msg.requestId) {
          pendingExports.delete(msg.requestId);
          p.reject(new Error(msg.message));
        }
        pendingLoads.splice(0).forEach((l) => l.reject(new Error(msg.message)));
        options.onError?.({ message: msg.message, issues: msg.issues });
        break;
      }
      default:
        break;
    }
  };
  window.addEventListener('message', listener);

  return {
    iframe,
    ready,
    load(doc, opts = {}) {
      return new Promise((resolve, reject) => {
        pendingLoads.push({ resolve, reject });
        send({ action: 'load', document: doc, ...opts });
      });
    },
    merge(doc, autoLayout) {
      send({ action: 'merge', document: doc, autoLayout });
    },
    export(format, viewId, notation) {
      const requestId = `exp-${++counter}`;
      return new Promise((resolve, reject) => {
        pendingExports.set(requestId, { resolve, reject });
        send({ action: 'export', format, viewId, requestId, notation });
      });
    },
    autoLayout(opts = {}) {
      send({ action: 'autoLayout', ...opts });
    },
    setView(viewId) {
      send({ action: 'setView', viewId });
    },
    status(message, modified) {
      send({ action: 'status', message, modified });
    },
    dialog(title, message, button) {
      send({ action: 'dialog', title, message, button });
    },
    save(exit = false) {
      send({ action: 'save', exit });
    },
    send,
    destroy() {
      window.removeEventListener('message', listener);
      iframe.remove();
    },
  };
}

export default createC4Embed;
