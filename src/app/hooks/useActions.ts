import { Toast } from '@douyinfe/semi-ui';
import { useCallback } from 'react';
import { toDrawio } from '../../core/export/drawio/toDrawio';
import { autoLayoutDocument } from '../../core/layout/elkLayout';
import { validateDocument, formatIssues } from '../../core/model/schema';
import type { LayoutDirection } from '../../core/model/types';
import { useDocumentStore } from '../store/documentStore';
import { downloadText, extractJson, pickTextFile, safeFilename } from '../utils/files';

/** Acciones de alto nivel compartidas por menús, toolbar y atajos. */
export function useActions() {
  const store = useDocumentStore;

  const exportDrawio = useCallback(async () => {
    const { doc } = store.getState();
    if (doc.views.length === 0) {
      Toast.warning('No hay vistas que exportar');
      return;
    }
    try {
      const laid = await autoLayoutDocument(doc);
      if (laid !== doc) store.getState().setDocument(laid, { activeViewId: store.getState().activeViewId ?? undefined });
      const xml = toDrawio(laid);
      downloadText(safeFilename(doc.workspace.name, 'drawio'), xml, 'application/xml');
      Toast.success('Archivo .drawio exportado');
    } catch (error) {
      Toast.error(`No se pudo exportar: ${(error as Error).message}`);
    }
  }, [store]);

  const saveJson = useCallback(() => {
    const { doc, markSaved } = store.getState();
    downloadText(safeFilename(doc.workspace.name, 'c4.json'), `${JSON.stringify(doc, null, 2)}\n`, 'application/json');
    markSaved();
    Toast.success('Documento JSON guardado');
  }, [store]);

  const importJsonText = useCallback(
    (text: string, mode: 'replace' | 'merge' = 'replace'): boolean => {
      let json: unknown;
      try {
        json = JSON.parse(extractJson(text));
      } catch (error) {
        Toast.error(`El texto no es JSON válido: ${(error as Error).message}`);
        return false;
      }
      const result = validateDocument(json);
      if (!result.ok) {
        Toast.error({ content: `Documento inválido:\n${formatIssues(result.issues)}`, duration: 8 });
        return false;
      }
      if (mode === 'merge') store.getState().mergeDocument(result.document);
      else store.getState().setDocument(result.document, { markSaved: true });
      return true;
    },
    [store],
  );

  const openJson = useCallback(async () => {
    const file = await pickTextFile();
    if (!file) return;
    if (importJsonText(file.content)) Toast.success(`"${file.name}" cargado`);
  }, [importJsonText]);

  const autoLayout = useCallback(
    async (direction?: LayoutDirection) => {
      const s = store.getState();
      if (direction) s.setUi({ direction });
      try {
        await s.runAutoLayout(undefined, { direction: direction ?? s.ui.direction, force: true });
      } catch (error) {
        Toast.error(`Autolayout falló: ${(error as Error).message}`);
      }
    },
    [store],
  );

  const deleteSelection = useCallback(() => {
    const s = store.getState();
    if (s.readOnly) return;
    const sel = s.selection;
    if (sel.kind === 'element') {
      const view = s.doc.views.find((v) => v.id === s.activeViewId);
      if (view && view.elements.some((e) => e.id === sel.id) && view.scopeId !== sel.id) {
        s.removeElementFromView(view.id, sel.id);
        s.select({ kind: 'none' });
      } else {
        s.removeElement(sel.id);
      }
    } else if (sel.kind === 'relationship') {
      s.removeRelationship(sel.id);
    }
  }, [store]);

  const undo = useCallback(() => store.temporal.getState().undo(), [store]);
  const redo = useCallback(() => store.temporal.getState().redo(), [store]);

  return { exportDrawio, saveJson, openJson, importJsonText, autoLayout, deleteSelection, undo, redo };
}
