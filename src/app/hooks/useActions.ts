import { Modal, Toast } from '@douyinfe/semi-ui';
import { createElement, useCallback } from 'react';
import { toDrawio, type DrawioNotation } from '@core/export/drawio/toDrawio';
import { autoLayoutDocument } from '@core/layout/elkLayout';
import { DrawioImportError, fromDrawio } from '@core/import/drawio/fromDrawio';
import { DslImportError, fromStructurizrDsl } from '@core/import/structurizr/fromStructurizrDsl';
import { fromMermaid, MermaidImportError } from '@core/import/mermaid/fromMermaid';
import { toMermaid, type MermaidFormat } from '@core/export/mermaid/toMermaid';
import type { C4Document } from '@core/model/types';
import { validateDocument, formatIssues } from '@core/model/schema';
import type { LayoutDirectionOption, LayoutDistribution } from '@core/model/types';
import { pauseHistory, useDocumentStore } from '../store/documentStore';
import { downloadText, extractJson, pickTextFile, safeFilename } from '../utils/files';

/** Lo que devuelve cualquiera de los importadores del núcleo. */
interface ImportResult {
  document: C4Document;
  warnings: string[];
}

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
          const resumeHistory = pauseHistory();
          try {
            store.setState({ doc: laid });
          } finally {
            resumeHistory();
          }
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
   * Flujo común de las importaciones desde otro formato (.drawio, DSL de Structurizr): elegir el archivo, convertirlo
   * y cargarlo. Lo importado no está guardado como JSON, así que el documento queda "con cambios sin guardar"; lo que
   * no se pudo importar se lista en un aviso y los errores muestran su motivo sin tocar el diagrama actual.
   */
  const importFrom = useCallback(
    async (accept: string, convert: (file: { name: string; content: string }) => Promise<ImportResult> | ImportResult) => {
      const file = await pickTextFile(accept);
      if (!file) return;
      try {
        const { document, warnings } = await convert(file);
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
        const known = error instanceof DrawioImportError || error instanceof DslImportError || error instanceof MermaidImportError;
        const reason = known ? error.message : `error inesperado (${(error as Error).message})`;
        Toast.error({ content: `No se pudo importar "${file.name}": ${reason}`, duration: 8 });
      }
    },
    [store],
  );

  /** Importa un `.drawio`: cada página pasa a ser una vista. */
  const importDrawio = useCallback(
    () => importFrom('.drawio,.xml,application/xml,text/xml', (file) => fromDrawio(file.content, { name: file.name.replace(/\.(drawio|xml)$/i, '') })),
    [importFrom],
  );

  /** Importa un DSL de Structurizr. Sin coordenadas: las vistas se colocan solas con el autolayout al abrirlas. */
  const importDsl = useCallback(
    () => importFrom('.dsl,.txt,text/plain', (file) => fromStructurizrDsl(file.content, { fallbackName: file.name.replace(/\.(dsl|txt)$/i, '') })),
    [importFrom],
  );

  /** Importa un diagrama de Mermaid (C4 nativo, flowchart, sequenceDiagram o erDiagram). Sin coordenadas: se colocan con el autolayout. */
  const importMermaid = useCallback(
    () =>
      importFrom('.mmd,.mermaid,.md,.txt,text/plain,text/markdown', (file) =>
        fromMermaid(file.content, { fallbackName: file.name.replace(/\.(mmd|mermaid|md|txt)$/i, '') }),
      ),
    [importFrom],
  );

  /** Exporta la vista activa como texto de Mermaid: descarga un `.mmd` o lo copia al portapapeles. */
  const exportMermaid = useCallback(
    async (format: MermaidFormat = 'c4', target: 'file' | 'clipboard' = 'file') => {
      const { doc, activeViewId } = store.getState();
      if (doc.views.length === 0) {
        Toast.warning('No hay vistas que exportar');
        return;
      }
      try {
        const text = toMermaid(doc, { viewId: activeViewId ?? undefined, format });
        if (target === 'clipboard') {
          await navigator.clipboard.writeText(text);
          Toast.success('Mermaid copiado al portapapeles');
        } else {
          downloadText(safeFilename(`${doc.workspace.name}${format === 'flowchart' ? '-flujo' : ''}`, 'mmd'), text, 'text/plain');
          Toast.success(`Archivo Mermaid exportado (${format === 'flowchart' ? 'diagrama de flujo' : 'C4 nativo'})`);
        }
      } catch (error) {
        Toast.error(`No se pudo exportar a Mermaid: ${(error as Error).message}`);
      }
    },
    [store],
  );

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

  return { exportDrawio, exportMermaid, saveJson, openJson, importDrawio, importDsl, importMermaid, importJsonText, autoLayout, deleteSelection, undo, redo };
}
