import { Modal, Toast } from '@douyinfe/semi-ui';
import { createElement, useCallback } from 'react';
import { toDrawio, type DrawioNotation } from '../../core/export/drawio/toDrawio';
import { autoLayoutDocument } from '../../core/layout/elkLayout';
import { DrawioImportError, fromDrawio } from '../../core/import/drawio/fromDrawio';
import { validateDocument, formatIssues } from '../../core/model/schema';
import type { LayoutDirectionOption, LayoutDistribution } from '../../core/model/types';
import { useDocumentStore } from '../store/documentStore';
import { downloadText, extractJson, pickTextFile, safeFilename } from '../utils/files';

/** Acciones de alto nivel compartidas por menús, toolbar y atajos. */
export function useActions() {
  const store = useDocumentStore;

  const exportDrawio = useCallback(
    async (notation?: DrawioNotation) => {
      const { doc, ui } = store.getState();
      const chosen = notation ?? (ui.nodeStyle === 'card' ? 'card' : 'c4');
      if (doc.views.length === 0) {
        Toast.warning('No hay vistas que exportar');
        return;
      }
      try {
        const laid = await autoLayoutDocument(doc, { density: ui.density });
        // Las vistas que aún no tenían posiciones (nunca abiertas) quedan colocadas en el documento. Se
        // aplica en silencio: exportar no es una edición, así que no marca "Cambios sin guardar", no
        // deselecciona y no añade un paso al historial de deshacer (antes lo hacía siempre, porque
        // autoLayoutDocument devuelve un objeto nuevo aunque no cambie nada).
        if (JSON.stringify(laid) !== JSON.stringify(doc)) {
          const temporal = store.temporal.getState();
          temporal.pause();
          store.setState({ doc: laid });
          temporal.resume();
        }
        const xml = toDrawio(laid, { notation: chosen });
        downloadText(safeFilename(`${doc.workspace.name}${chosen === 'card' ? '-tarjetas' : ''}`, 'drawio'), xml, 'application/xml');
        Toast.success(`Archivo .drawio exportado (${chosen === 'card' ? 'tarjetas' : 'notación C4'})`);
      } catch (error) {
        Toast.error(`No se pudo exportar: ${(error as Error).message}`);
      }
    },
    [store],
  );

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

  /**
   * Importa un `.drawio` (cada página pasa a ser una vista). Lo importado no está guardado como JSON, así que el
   * documento queda "con cambios sin guardar"; lo que no se pudo importar se lista en un aviso.
   */
  const importDrawio = useCallback(async () => {
    const file = await pickTextFile('.drawio,.xml,application/xml,text/xml');
    if (!file) return;
    try {
      const { document, warnings } = await fromDrawio(file.content, { name: file.name.replace(/\.(drawio|xml)$/i, '') });
      store.getState().setDocument(document, { markSaved: false });
      Toast.success(
        `"${file.name}" importado: ${document.model.elements.length} elementos, ${document.model.relationships.length} relaciones, ${document.views.length} vistas`,
      );
      if (warnings.length > 0) {
        Modal.warning({
          title: `Importado con ${warnings.length} aviso(s)`,
          content: createElement(
            'ul',
            { className: 'list-disc pl-5 space-y-1 text-sm max-h-72 overflow-auto' },
            warnings.map((w, i) => createElement('li', { key: i }, w)),
          ),
          okText: 'Entendido',
          hasCancel: false,
        });
      }
    } catch (error) {
      const reason = error instanceof DrawioImportError ? error.message : `error inesperado (${(error as Error).message})`;
      Toast.error({ content: `No se pudo importar "${file.name}": ${reason}`, duration: 8 });
    }
  }, [store]);

  const autoLayout = useCallback(
    async (direction?: LayoutDirectionOption, distribution?: LayoutDistribution) => {
      const s = store.getState();
      if (direction) s.setUi({ direction });
      if (distribution) s.setUi({ distribution });
      try {
        await s.runAutoLayout(undefined, {
          direction: direction ?? s.ui.direction,
          distribution: distribution ?? s.ui.distribution,
          density: s.ui.density,
          force: true,
        });
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

  return { exportDrawio, saveJson, openJson, importDrawio, importJsonText, autoLayout, deleteSelection, undo, redo };
}
