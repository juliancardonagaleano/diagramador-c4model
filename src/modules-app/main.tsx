import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './workbench.css';
import { Workbench } from './Workbench';
import { createModuleBridge, type ModuleBridge } from './bridge';
import { WorkbenchController } from './controller';
import { localDrafts, MODULE_SOURCES } from './modules';
import { MODULE_PROTOCOL_VERSION } from '../embed/moduleProtocol';

/**
 * Banco de trabajo de los módulos de la suite (`modulos.html`). Con `?embed=1&proto=json&module=<id>&origin=<origen del
 * anfitrión>` habla el protocolo postMessage de `src/embed/moduleProtocol.ts`; sin él, es una página normal con borradores
 * en localStorage.
 */
const params = new URLSearchParams(window.location.search);
const embed = params.get('embed') === '1' && window.parent !== window;
const moduleParam = params.get('module') ?? undefined;

function referrerOrigin(): string | undefined {
  try {
    return document.referrer ? new URL(document.referrer).origin : undefined;
  } catch {
    return undefined;
  }
}

/** Origen del anfitrión: el que declara `origin`, o el de quien nos incrusta. Nunca `*`: el documento viaja en los eventos. */
const hostOrigin = params.get('origin') ?? referrerOrigin() ?? window.location.origin;

type Theme = 'light' | 'dark';
const preferredTheme = (): Theme => {
  const requested = params.get('theme');
  if (requested === 'light' || requested === 'dark') return requested;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
};

function Root() {
  const controller = useMemo(
    () => new WorkbenchController(MODULE_SOURCES, { storage: embed ? undefined : localDrafts, protocol: MODULE_PROTOCOL_VERSION }),
    [],
  );
  const [ui, setUi] = useState<'full' | 'min'>(params.get('ui') === 'min' ? 'min' : 'full');
  const [dialog, setDialog] = useState<{ title: string; message: string; button?: string } | undefined>();
  const bridge = useRef<ModuleBridge | undefined>(undefined);

  useEffect(() => {
    applyTheme(preferredTheme());
    if (!embed) {
      void controller.selectModule(moduleParam && controller.moduleIds.includes(moduleParam) ? moduleParam : controller.moduleIds[0]);
      return;
    }
    const post = (event: unknown): void => window.parent.postMessage(JSON.stringify(event), hostOrigin);
    const instance = createModuleBridge({
      controller,
      post,
      module: moduleParam,
      configure: params.get('configure') === '1',
      onConfigure: (config) => {
        if (config.theme) applyTheme(config.theme);
        if (config.ui) setUi(config.ui);
      },
      onDialog: setDialog,
    });
    bridge.current = instance;
    const listener = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      void instance.receive(event.data);
    };
    window.addEventListener('message', listener);
    void instance.start().catch((error) => post({ event: 'error', message: (error as Error).message }));
    return () => {
      window.removeEventListener('message', listener);
      instance.dispose();
    };
  }, [controller]);

  return (
    <Workbench
      controller={controller}
      embed={embed}
      ui={ui}
      dialog={dialog}
      onDismissDialog={() => setDialog(undefined)}
      onSave={(exit) => void bridge.current?.receive({ action: 'save', exit })}
      onExit={() => void bridge.current?.receive({ action: 'exit' })}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
