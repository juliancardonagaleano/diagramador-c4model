import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchController } from './controller';
import { countBySeverity, locateId } from './engine';
import { readFile } from './files';
import { DiagramPanel, ExportPanel, FilePicker, ImportPanel, IssuesPanel, ReportsPanel } from './panels';

type PanelId = 'diagram' | 'issues' | 'reports' | 'export' | 'import';

export interface WorkbenchProps {
  controller: WorkbenchController;
  /** Modo embebido: se ofrecen «Guardar» y «Salir» y el anfitrión decide qué se hace con el documento. */
  embed?: boolean;
  ui?: 'full' | 'min';
  dialog?: { title: string; message: string; button?: string };
  onDismissDialog?(): void;
  onSave?(exit: boolean): void;
  onExit?(): void;
}

const LINE_HEIGHT = 18;

export function Workbench({ controller, embed = false, ui = 'full', dialog, onDismissDialog, onSave, onExit }: WorkbenchProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [panel, setPanel] = useState<PanelId>('diagram');
  const [toast, setToast] = useState<string | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 4000);
  }, []);

  const reveal = useCallback(
    (id: string) => {
      const el = editor.current;
      const found = locateId(controller.getState().text, id);
      if (!el || !found) return;
      el.focus();
      el.setSelectionRange(found.index, found.index + found.length);
      const line = el.value.slice(0, found.index).split('\n').length;
      el.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT);
    },
    [controller],
  );

  const openFile = async (file: File) => {
    try {
      const text = await readFile(file);
      if (/\.json$/i.test(file.name)) controller.useDocumentText(text);
      else {
        const result = await controller.importFrom(text, undefined, { file: file.name });
        notify(`Importado desde ${result.importer}${result.warnings.length ? ` con ${result.warnings.length} avisos (ver Importar)` : ''}`);
      }
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const { module, analysis } = state;
  const counts = analysis.status === 'ok' ? countBySeverity(analysis.issues) : { error: 0, warning: 0, info: 0 };
  const problemCount = analysis.status === 'ok' ? analysis.issues.length : analysis.status === 'schema' ? analysis.issues.length : analysis.status === 'syntax' ? 1 : 0;
  const panelProps = { controller, state, reveal, notify };

  const tabs: Array<[PanelId, string]> = [
    ['diagram', 'Diagrama'],
    ['issues', `Problemas${problemCount ? ` (${problemCount})` : ''}`],
    ['reports', 'Informes'],
    ['export', 'Exportar'],
    ['import', 'Importar'],
  ];

  return (
    <div className="wb" data-ui={ui}>
      {ui === 'full' && (
        <header className="wb-header">
          <a className="wb-brand" href="./" title="Abrir el editor C4">
            IArk - DIAgrams <small>Módulos</small>
          </a>
          <div className="wb-modules" role="tablist" aria-label="Módulos">
            {controller.sources.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={s.id === state.moduleId} onClick={() => void controller.selectModule(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="wb-actions">
            <button type="button" disabled={!state.moduleId} onClick={() => void controller.loadExample()}>
              Cargar ejemplo
            </button>
            <FilePicker label="Abrir archivo…" accept=".json,.mmd,.mermaid,.md,text/plain,application/json" disabled={!state.moduleId} onFile={(file) => void openFile(file)} />
            {embed && (
              <>
                <button type="button" onClick={() => onSave?.(false)}>
                  Guardar
                </button>
                <button type="button" className="primary" onClick={() => onSave?.(true)}>
                  Guardar y salir
                </button>
                <button type="button" onClick={() => onExit?.()}>
                  Salir
                </button>
              </>
            )}
          </div>
        </header>
      )}

      <main className="wb-main">
        <section className="wb-editor" aria-label="Documento">
          <div className="wb-bar">
            <strong>{module ? `${module.name} · v${module.version}` : state.loading ? 'Cargando módulo…' : 'Elige un módulo'}</strong>
            <span>{state.readOnly ? 'Solo lectura' : state.modified ? 'Sin guardar' : ''}</span>
          </div>
          <textarea
            ref={editor}
            aria-label="Documento JSON"
            spellCheck={false}
            value={state.text}
            readOnly={state.readOnly || !module}
            placeholder={module ? 'Pega o escribe el documento JSON del módulo, o pulsa «Cargar ejemplo».' : ''}
            onChange={(e) => controller.setText(e.target.value)}
          />
          <div className="wb-foot" role="status" data-testid="editor-status">
            {state.error ? (
              <span className="wb-chip error">{state.error}</span>
            ) : analysis.status === 'empty' ? (
              <span>Documento vacío</span>
            ) : analysis.status === 'syntax' ? (
              <span className="wb-chip error">JSON inválido: {analysis.error}</span>
            ) : analysis.status === 'schema' ? (
              <span className="wb-chip error">{analysis.issues.length} errores de esquema</span>
            ) : (
              <span>
                <span className="wb-chip ok">Válido</span> {counts.error} errores · {counts.warning} avisos · {counts.info} notas
              </span>
            )}
            {state.status && <span> · {state.status}</span>}
          </div>
        </section>

        <section className="wb-side">
          <div className="wb-tabs" role="tablist" aria-label="Paneles">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={panel === id} onClick={() => setPanel(id)}>
                {label}
              </button>
            ))}
          </div>
          {panel === 'diagram' && <DiagramPanel {...panelProps} />}
          {panel === 'issues' && <IssuesPanel {...panelProps} />}
          {panel === 'reports' && <ReportsPanel {...panelProps} />}
          {panel === 'export' && <ExportPanel {...panelProps} />}
          {panel === 'import' && <ImportPanel {...panelProps} />}
        </section>
      </main>

      {toast && (
        <div className="wb-toast" role="status">
          {toast}
        </div>
      )}
      {dialog && (
        <div className="wb-toast" role="alertdialog" aria-label={dialog.title}>
          <strong>{dialog.title}</strong>
          {dialog.message}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="primary" onClick={() => onDismissDialog?.()}>
              {dialog.button ?? 'Aceptar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
