import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { Canvas } from './components/canvas/Canvas';
import { ControlPanel } from './components/header/ControlPanel';
import { FloatingToolbar } from './components/header/FloatingToolbar';
import { SidePanel } from './components/sidepanel/SidePanel';
import { useEmbedBridge } from './embed/useEmbedBridge';
import { useActions } from './hooks/useActions';
import { isEmbedMode, useDocumentStore } from './store/documentStore';

const params = new URLSearchParams(window.location.search);

export default function App() {
  const ui = useDocumentStore((s) => s.ui);
  const setUi = useDocumentStore((s) => s.setUi);
  const embed = useEmbedBridge();
  const actions = useActions();

  // Tema (mecanismo nativo de Semi UI) + parámetros de URL.
  useEffect(() => {
    document.body.setAttribute('theme-mode', ui.theme);
  }, [ui.theme]);
  useEffect(() => {
    const theme = params.get('theme');
    if (theme === 'dark' || theme === 'light') setUi({ theme });
    if (params.get('ui') === 'min') setUi({ showHeader: false, showSidebar: false, showMinimap: false });
    const view = params.get('view');
    if (view && useDocumentStore.getState().doc.views.some((v) => v.id === view)) useDocumentStore.getState().setActiveView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atajos de teclado globales.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) actions.redo();
        else actions.undo();
      } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        actions.redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isEmbedMode) void embed.save(false);
        else actions.saveJson();
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void actions.exportDrawio();
      } else if (mod && e.key.toLowerCase() === 'o' && !isEmbedMode) {
        e.preventDefault();
        void actions.openJson();
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void actions.autoLayout();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        e.preventDefault();
        actions.deleteSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, embed]);

  return (
    <ReactFlowProvider>
      <div className="h-full flex flex-col overflow-hidden theme">
        {ui.showHeader && <ControlPanel onEmbedSave={(exit) => void embed.save(exit)} onEmbedExit={embed.exit} />}
        <div className="flex h-full min-h-0 overflow-hidden">
          {ui.showSidebar && <SidePanel />}
          <div className="relative flex-1 min-w-0 h-full overflow-hidden">
            <Canvas />
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-24px)]">
              <FloatingToolbar onEmbedSave={(exit) => void embed.save(exit)} />
            </div>
          </div>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
