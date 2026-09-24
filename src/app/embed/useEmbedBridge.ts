import { Modal, Toast } from '@douyinfe/semi-ui';
import { useEffect, useRef } from 'react';
import { toDrawio } from '../../core/export/drawio/toDrawio';
import { autoLayoutDocument } from '../../core/layout/elkLayout';
import { viewLevel } from '../../core/model/factories';
import { formatIssues, validateDocument } from '../../core/model/schema';
import type { C4Document } from '../../core/model/types';
import { parseHostAction, PROTOCOL_VERSION, type EmbedEvent, type HostAction } from '../../embed/protocol';
import { isEmbedMode, useDocumentStore } from '../store/documentStore';
import { extractJson } from '../utils/files';

const params = new URLSearchParams(window.location.search);
const allowedOrigin = params.get('origin');

function post(event: EmbedEvent) {
  if (!isEmbedMode || window.parent === window) return;
  window.parent.postMessage(JSON.stringify(event), allowedOrigin ?? '*');
}

function parseIncomingDocument(input: C4Document | string): { ok: true; document: C4Document } | { ok: false; message: string; issues?: Array<{ path: string; message: string }> } {
  let json: unknown = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(extractJson(input));
    } catch (error) {
      return { ok: false, message: `El documento no es JSON válido: ${(error as Error).message}` };
    }
  }
  const result = validateDocument(json);
  if (!result.ok) return { ok: false, message: `Documento inválido:\n${formatIssues(result.issues)}`, issues: result.issues };
  return { ok: true, document: result.document };
}

/**
 * Lado "iframe" del protocolo: escucha los mensajes del anfitrión, aplica las
 * acciones sobre el store y emite eventos (init, load, autosave, save, export, exit…).
 */
export function useEmbedBridge(): { save: (exit: boolean) => Promise<void>; exit: () => void } {
  const autosave = useRef(false);
  const store = useDocumentStore;

  const save = async (exit: boolean) => {
    const { doc, markSaved } = store.getState();
    let drawio: string | undefined;
    try {
      drawio = doc.views.length ? toDrawio(await autoLayoutDocument(doc)) : undefined;
    } catch {
      drawio = undefined;
    }
    markSaved();
    post({ event: 'save', document: doc, drawio, exit });
    if (exit) post({ event: 'exit', modified: false });
  };

  const exit = () => {
    const { modified } = store.getState();
    if (modified) {
      Modal.confirm({
        title: 'Salir sin guardar',
        content: 'Hay cambios sin guardar. ¿Deseas salir de todos modos?',
        okText: 'Salir',
        cancelText: 'Cancelar',
        okType: 'danger',
        onOk: () => post({ event: 'exit', modified: true }),
      });
      return;
    }
    post({ event: 'exit', modified: false });
  };

  useEffect(() => {
    if (!isEmbedMode) return;

    const applyLoad = async (action: Extract<HostAction, { action: 'load' }>) => {
      const s = store.getState();
      autosave.current = !!action.autosave;
      if (action.theme) s.setUi({ theme: action.theme });
      if (action.readOnly !== undefined) s.setReadOnly(action.readOnly);
      if (action.title) s.setStatusMessage(null);
      let document: C4Document;
      if (action.document === undefined) {
        s.newDocument();
        document = store.getState().doc;
      } else {
        const parsed = parseIncomingDocument(action.document);
        if (!parsed.ok) {
          post({ event: 'error', message: parsed.message, issues: parsed.issues });
          return;
        }
        document = parsed.document;
        if (action.autoLayout) document = await autoLayoutDocument(document, { force: true });
        s.setDocument(document, { activeViewId: action.viewId, markSaved: true });
        store.temporal.getState().clear();
      }
      if (action.title) s.setWorkspaceName(action.title);
      store.getState().markSaved();
      post({ event: 'load', document: store.getState().doc, viewId: store.getState().activeViewId ?? undefined });
    };

    const handle = async (action: HostAction) => {
      const s = store.getState();
      switch (action.action) {
        case 'load':
          await applyLoad(action);
          break;
        case 'configure':
          if (action.theme) s.setUi({ theme: action.theme });
          if (action.ui === 'min') s.setUi({ showHeader: false, showSidebar: false, showMinimap: false });
          if (action.hideSidePanel !== undefined) s.setUi({ showSidebar: !action.hideSidePanel });
          break;
        case 'merge': {
          const parsed = parseIncomingDocument(action.document);
          if (!parsed.ok) {
            post({ event: 'error', message: parsed.message, issues: parsed.issues });
            return;
          }
          s.mergeDocument(parsed.document);
          if (action.autoLayout !== false) {
            const id = store.getState().activeViewId;
            if (id) await store.getState().runAutoLayout(id, { force: true });
          }
          break;
        }
        case 'export': {
          try {
            const doc = await autoLayoutDocument(s.doc);
            let data: string;
            if (action.format === 'json') data = JSON.stringify(action.viewId ? { ...doc, views: doc.views.filter((v) => v.id === action.viewId) } : doc, null, 2);
            else if (action.format === 'drawio') data = toDrawio(doc, { viewIds: action.viewId ? [action.viewId] : undefined, notation: action.notation });
            else {
              post({ event: 'error', message: `Formato de exportación no soportado todavía: ${action.format}`, requestId: action.requestId });
              return;
            }
            post({ event: 'export', format: action.format, data, viewId: action.viewId, requestId: action.requestId });
          } catch (error) {
            post({ event: 'error', message: (error as Error).message, requestId: action.requestId });
          }
          break;
        }
        case 'autoLayout': {
          const id = action.viewId ?? s.activeViewId;
          if (!id) return;
          if (action.direction) s.setUi({ direction: action.direction });
          if (action.distribution) s.setUi({ distribution: action.distribution });
          await s.runAutoLayout(id, { direction: action.direction, distribution: action.distribution, force: action.force ?? true });
          post({ event: 'autoLayout', viewId: id, direction: store.getState().lastLayoutQuality?.direction });
          break;
        }
        case 'setView':
          if (s.doc.views.some((v) => v.id === action.viewId)) s.setActiveView(action.viewId);
          else post({ event: 'error', message: `La vista "${action.viewId}" no existe` });
          break;
        case 'status':
          s.setStatusMessage(action.message, action.modified);
          break;
        case 'dialog':
          Modal.info({ title: action.title, content: action.message, okText: action.button ?? 'Aceptar', hasCancel: false });
          break;
        case 'save':
          await save(!!action.exit);
          break;
        case 'exit':
          post({ event: 'exit', modified: store.getState().modified });
          break;
      }
    };

    const listener = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const parsed = parseHostAction(event.data);
      if (!parsed.ok) {
        if (event.data && typeof event.data === 'object' && 'action' in event.data) post({ event: 'error', message: parsed.error });
        return;
      }
      void handle(parsed.action).catch((error) => {
        Toast.error((error as Error).message);
        post({ event: 'error', message: (error as Error).message });
      });
    };
    window.addEventListener('message', listener);

    if (params.get('configure') === '1') post({ event: 'configure' });
    post({ event: 'init', version: PROTOCOL_VERSION });

    // Autosave/change con throttle.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastDoc = store.getState().doc;
    let lastViewId = store.getState().activeViewId;
    const unsub = store.subscribe((state) => {
      if (state.activeViewId !== lastViewId) {
        lastViewId = state.activeViewId;
        const view = state.doc.views.find((v) => v.id === state.activeViewId);
        if (view) post({ event: 'viewChange', viewId: view.id, level: viewLevel(view), scopeId: view.scopeId, title: view.title });
      }
      if (state.doc === lastDoc) return;
      lastDoc = state.doc;
      if (!state.modified) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const doc = store.getState().doc;
        post({ event: 'change', document: doc });
        if (autosave.current) post({ event: 'autosave', document: doc });
      }, 500);
    });

    return () => {
      window.removeEventListener('message', listener);
      unsub();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { save, exit };
}
