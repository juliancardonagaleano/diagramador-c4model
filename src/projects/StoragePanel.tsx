import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { normalizeBaseUrl, type RemoteSession } from '@iark/kernel';
import { browserAreas, chooseLocalBackend, forgetBackend, loadBackend, saveBackend, type StorageAreas } from './backend';
import { currentPage, mixedContentWarning, testConnection, type ConnectionResult, type PageInfo } from './connection';
import type { ProjectSession } from './session';

export interface StoragePanelProps {
  session: ProjectSession;
  open: boolean;
  onToggle(open: boolean): void;
  /** Hay un proyecto elegido para copiar a un servidor: ofrece «Copiar … al servidor» además de conectar. */
  copyFor?: { name: string };
  /** Se guardó el servidor (sin activarlo) para copiar: el gestor hace la copia. */
  onCopy?(): void;
  /** La configuración cambió (el servidor conocido): el gestor recalcula a dónde se puede copiar. */
  onChange?(): void;
  notify?(message: string): void;
  /** Recarga la página tras cambiar de almacén (las pruebas lo sustituyen). */
  reload?(): void;
  fetch?: typeof fetch;
  areas?: StorageAreas;
  page?: PageInfo;
}

type Status = 'connecting' | 'connected' | 'offline' | 'rejected';
const STATUS_TEXT: Record<Status, string> = { connecting: 'Comprobando…', connected: 'Conectado', offline: 'Sin conexión', rejected: 'Token rechazado' };

/**
 * «Dónde se guardan»: este navegador o un servidor propio. Muestra el almacén activo y su estado y deja conectar a un
 * servidor (dirección y token, con «Probar conexión»), volver a este navegador o cambiar el token sin recargar.
 * Cambiar de almacén recarga la página: es lo más simple y seguro (nada de lo abierto queda apuntando al almacén anterior).
 */
export function StoragePanel({ session, open, onToggle, copyFor, onCopy, onChange, notify, reload, fetch: fetchImpl, areas: areasProp, page: pageProp }: StoragePanelProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const areas = useMemo(() => areasProp ?? browserAreas(), [areasProp]);
  const page = useMemo(() => pageProp ?? currentPage(), [pageProp]);
  const [version, setVersion] = useState(0);
  const config = useMemo(() => loadBackend(areas), [areas, version]); // eslint-disable-line react-hooks/exhaustive-deps -- `version` fuerza releer lo guardado
  const known = config.kind === 'remote' ? config : config.server;
  const remote = session.backend.kind === 'remote';
  const active = session.backend.kind === 'remote' ? session.backend : undefined;

  const [url, setUrl] = useState(known?.url ?? '');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(known?.label ?? '');
  const [remember, setRemember] = useState(known?.remembered ?? false);
  const [test, setTest] = useState<ConnectionResult | undefined>();
  const [working, setWorking] = useState<'test' | 'connect' | 'copy' | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [loss, setLoss] = useState<'connect' | 'local' | undefined>();
  const [who, setWho] = useState<RemoteSession | undefined>();
  const urlInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const typedUrl = useMemo(() => {
    try {
      return normalizeBaseUrl(url);
    } catch {
      return undefined;
    }
  }, [url]);
  const inputToken = token.trim() || undefined;
  /** El token que se usa para probar: el escrito o, si es el mismo servidor, el que ya había guardado. */
  const tokenToUse = inputToken ?? (known && typedUrl === known.url ? known.token : undefined);

  // Quién es el token ante el servidor activo (se vuelve a preguntar cuando el servidor vuelve a estar disponible).
  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    session
      .whoami()
      .then((found) => !cancelled && setWho(found))
      .catch(() => !cancelled && setWho(undefined));
    return () => {
      cancelled = true;
    };
  }, [session, remote, state.available]);

  const rejected = state.errorCode === 'unauthorized' || state.syncErrorCode === 'unauthorized' || state.saveErrorCode === 'unauthorized';
  const forbidden = !rejected && state.saveErrorCode === 'forbidden';
  const status: Status = !state.ready ? 'connecting' : rejected ? 'rejected' : !state.available || state.syncError || state.saveErrorCode === 'unavailable' ? 'offline' : 'connected';

  // Al abrir el formulario el foco va a la dirección o, si el servidor rechazó el token, directamente al token.
  useEffect(() => {
    if (!open) return;
    (rejected && remote ? tokenInput : urlInput).current?.focus();
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // En una pantalla pequeña el panel se desplaza por dentro: el resultado de probar la conexión no debe quedar fuera de la vista.
  useEffect(() => {
    if (test || problem || message || loss) results.current?.scrollIntoView?.({ block: 'nearest' });
  }, [test, problem, message, loss]);

  const changed = (): void => {
    setVersion((v) => v + 1);
    onChange?.();
  };

  const check = async (): Promise<ConnectionResult> => {
    const result = await testConnection({ url, token: tokenToUse }, { fetch: fetchImpl, page });
    setTest(result);
    return result;
  };

  const busy = working !== undefined;
  const run = async (kind: NonNullable<typeof working>, work: () => Promise<void>): Promise<void> => {
    setWorking(kind);
    setProblem(undefined);
    setMessage(undefined);
    setLoss(undefined);
    try {
      await work();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setWorking(undefined);
    }
  };

  const doReload = (): void => (reload ?? (() => window.location.reload()))();

  /** Guarda lo pendiente antes de cambiar de almacén; si no pudo guardarse, pide confirmar porque la recarga lo perdería. */
  const settle = async (action: 'connect' | 'local', confirmed: boolean): Promise<boolean> => {
    await session.flush();
    if (session.dirty && !confirmed) {
      setLoss(action);
      return false;
    }
    return true;
  };

  const connect = (confirmed = false): Promise<void> =>
    run('connect', async () => {
      const result = await check();
      if (!result.ok) return;
      if (remote && active && result.url === active.url) {
        // Mismo servidor: solo cambia el token (o el nombre). Sin recargar, para no perder lo que está pendiente de guardar.
        const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: true }, areas);
        await session.useToken(tokenToUse);
        setWho(await session.whoami().catch(() => undefined)); // otro token, otra persona (u otro rol)
        setToken('');
        changed();
        const text = saved.saved ? 'Token actualizado: se retoma el guardado.' : `Token actualizado solo hasta que recargues la página. ${saved.problem ?? ''}`;
        setMessage(text);
        notify?.(text);
        return;
      }
      if (!(await settle('connect', confirmed))) return;
      const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: true }, areas);
      if (!saved.saved) {
        setProblem(saved.problem);
        return;
      }
      doReload();
    });

  const back = (confirmed = false): Promise<void> =>
    run('connect', async () => {
      if (!(await settle('local', confirmed))) return;
      if (!chooseLocalBackend(areas)) {
        setProblem('El navegador no deja guardar la configuración (¿datos del sitio bloqueados?): al recargar seguiría el servidor.');
        return;
      }
      doReload();
    });

  const copy = (): Promise<void> =>
    run('copy', async () => {
      const result = await check();
      if (!result.ok) return;
      // Se recuerda el servidor sin activarlo: la copia se hace con su propio cliente y este navegador sigue siendo el almacén activo.
      const saved = saveBackend({ url: result.url, token: inputToken, label }, { remember, active: false }, areas);
      if (!saved.saved) {
        setProblem(saved.problem);
        return;
      }
      changed();
      onCopy?.();
    });

  const forget = (): void => {
    forgetBackend(areas);
    setUrl('');
    setToken('');
    setLabel('');
    setRemember(false);
    setTest(undefined);
    changed();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void connect();
  };

  const host = active?.host;
  const identity = who?.name ? ` (${who.name}${who.role ? `, ${who.role}` : ''})` : who && !who.auth ? ' (sin autenticación)' : '';
  const summary = remote ? `Servidor: ${host}${active?.label ? ` «${active.label}»` : ''}${identity}` : 'Este navegador';
  const warning = mixedContentWarning(typedUrl ?? url, page);
  const sameActive = remote && active !== undefined && typedUrl === active.url;
  const needsUrl = !url.trim();

  return (
    <section className="pj-storage" aria-label="Dónde se guardan" data-testid="storage-panel" data-backend={remote ? 'remote' : 'local'}>
      <div className="pj-storage-head">
        <span className="pj-storage-where">
          <strong>Dónde se guardan:</strong> <span data-testid="storage-summary">{summary}</span>
          {remote && (
            <span className="pj-status" data-status={status} data-testid="storage-status" role="status">
              {STATUS_TEXT[status]}
            </span>
          )}
        </span>
        <button type="button" onClick={() => onToggle(!open)} aria-expanded={open} aria-controls="pj-storage-body">
          {open ? 'Ocultar' : remote ? 'Cambiar…' : 'Conectar a un servidor…'}
        </button>
      </div>

      {open && (
        <div className="pj-storage-body" id="pj-storage-body">
          {remote && rejected && (
            <p className="pj-error" role="alert" data-testid="storage-rejected">
              El servidor no aceptó el token. Escribe el correcto y pulsa «Usar este token»: lo pendiente de guardar no se pierde.
            </p>
          )}
          {remote && forbidden && (
            <p className="pj-error" role="alert" data-testid="storage-forbidden">
              El servidor reconoce el token, pero su rol no permite guardar aquí{who?.role ? ` (es «${who.role}»)` : ''}. Escribe un token con rol editor y pulsa «Usar este token»: lo pendiente de guardar no se pierde.
            </p>
          )}
          <form className="pj-connect" onSubmit={submit} aria-label="Conectar a un servidor">
            {copyFor && !remote && (
              <p className="pj-hint">
                Para copiar «{copyFor.name}» hace falta un servidor. Estos proyectos siguen en este navegador: la copia no cambia dónde se guardan.
              </p>
            )}
            <div className="pj-row">
              <label className="pj-grow">
                Dirección del servidor
                <input
                  ref={urlInput}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://iark.ejemplo.org"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setTest(undefined);
                  }}
                />
              </label>
              <label className="pj-grow">
                Token de acceso
                <input
                  ref={tokenInput}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  placeholder={known?.token && (typedUrl === known.url || !url.trim()) ? 'Ya hay uno guardado; en blanco lo conserva' : 'Opcional si el servidor es abierto'}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setTest(undefined);
                  }}
                />
              </label>
              <label className="pj-grow">
                Nombre (opcional)
                <input type="text" autoComplete="off" maxLength={60} placeholder="Oficina" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
            </div>
            <label className="pj-check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-describedby="pj-remember-note" />
              Recordar en este equipo
            </label>
            <small id="pj-remember-note" className="pj-hint">
              Sin marcar, el token solo vive en esta pestaña y se olvida al cerrarla. Marcada, se guarda en este navegador hasta que lo borres: cualquier script que se ejecute en este sitio podría leerlo; márcala solo en un equipo tuyo.
            </small>
            <small className="pj-hint">
              El servidor tiene que aceptar a esta página: <code>--cors {page.origin}</code> (no hace falta si lo abriste desde ese mismo servidor).
            </small>
            {warning && (
              <p className="pj-warn" role="note" data-testid="storage-mixed">
                {warning}
              </p>
            )}

            <div className="pj-actions pj-connect-actions">
              <button type="button" onClick={() => void run('test', async () => void (await check()))} disabled={busy || needsUrl}>
                {working === 'test' ? 'Probando…' : 'Probar conexión'}
              </button>
              {copyFor && !remote && (
                <button type="button" className="pj-primary" onClick={() => void copy()} disabled={busy || needsUrl}>
                  Copiar «{copyFor.name}» al servidor
                </button>
              )}
              <button type="submit" className={copyFor && !remote ? undefined : 'pj-primary'} disabled={busy || needsUrl}>
                {sameActive ? 'Usar este token' : copyFor && !remote ? 'Conectar y usar este servidor' : 'Conectar'}
              </button>
              {remote && (
                <button type="button" onClick={() => void back()} disabled={busy}>
                  Volver a este navegador
                </button>
              )}
              {!remote && known && (
                <button type="button" onClick={forget} disabled={busy}>
                  Olvidar este servidor
                </button>
              )}
            </div>
          </form>

          <div className="pj-results" ref={results}>
            {test?.ok && (
              <p className="pj-ok" role="status" data-testid="storage-test">
                Conexión correcta con {test.url}.{' '}
                {test.auth ? `Eres «${test.name ?? 'sin nombre'}»${test.role ? ` (rol ${test.role})` : ''}.` : 'El servidor no pide autenticación.'} Tiene {test.projects === 1 ? '1 proyecto' : `${test.projects} proyectos`}.
              </p>
            )}
            {test && !test.ok && (
              <p className="pj-error" role="alert" data-testid="storage-test" data-problem={test.problem}>
                {test.message}
                {test.detail && test.detail !== test.message && <small> Respuesta: {test.detail}</small>}
              </p>
            )}
            {message && (
              <p className="pj-ok" role="status" data-testid="storage-message">
                {message}
              </p>
            )}
            {problem && (
              <p className="pj-error" role="alert" data-testid="storage-problem">
                {problem}
              </p>
            )}
            {loss && (
              <p className="pj-warn" role="alert" data-testid="storage-loss">
                Hay cambios sin guardar que no pudieron enviarse al almacén actual; si sigues, se perderán.{' '}
                <button type="button" className="pj-danger" onClick={() => void (loss === 'connect' ? connect(true) : back(true))} disabled={busy}>
                  Seguir y descartarlos
                </button>
                <button type="button" onClick={() => setLoss(undefined)}>
                  Cancelar
                </button>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
