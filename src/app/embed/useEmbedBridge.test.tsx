// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?embed=1" }
// `isEmbedMode` (documentStore.ts) se calcula una vez a partir de `window.location.search` al
// cargar el módulo, así que la URL de jsdom para este archivo debe traer `?embed=1` desde el
// principio (por eso el pragma de arriba, no un `Object.defineProperty` posterior).
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '../store/documentStore';
import { useEmbedBridge } from './useEmbedBridge';

function Harness() {
  useEmbedBridge();
  return null;
}

// jsdom no simula un iframe real: `window.parent === window` por defecto, así que `post()` del
// bridge (que exige `window.parent !== window`) no-opearía siempre. Se sustituye `window.parent`
// por un objeto distinto con su propio `postMessage`, y los mensajes "del anfitrión" se despachan
// con ese objeto como `source`, tal como haría un iframe real recibiendo de su padre.
function setupFakeParent() {
  const postMessage = vi.fn();
  const parentWindow = { postMessage } as unknown as Window;
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
  return { parentWindow, postMessage };
}

function postedEvents(postMessage: ReturnType<typeof vi.fn>): unknown[] {
  return postMessage.mock.calls.map(([data]) => (typeof data === 'string' ? JSON.parse(data) : data));
}

describe('useEmbedBridge (lado iframe)', () => {
  beforeEach(() => {
    useDocumentStore.getState().newDocument();
  });

  it('un mensaje del anfitrión con JSON roto (string que empieza por "{") emite un evento de error', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear(); // descarta init/configure del montaje

    window.dispatchEvent(new MessageEvent('message', { data: '{"action": "export", roto', source: parentWindow }));

    const events = postedEvents(postMessage);
    expect(events.some((e) => (e as { event?: string }).event === 'error')).toBe(true);
  });

  it('un mensaje ajeno al protocolo (no parece JSON) se ignora en silencio', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent('message', { data: 'ping', source: parentWindow }));
    window.dispatchEvent(new MessageEvent('message', { data: 42, source: parentWindow }));

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('pedir autoLayout antes de "load" responde con un error explícito, no en silencio', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();
    useDocumentStore.setState({ activeViewId: null });

    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ action: 'autoLayout' }), source: parentWindow }));

    const events = postedEvents(postMessage);
    const error = events.find((e) => (e as { event?: string }).event === 'error') as { message?: string } | undefined;
    expect(error?.message).toMatch(/no hay ninguna vista activa/i);
  });
});
