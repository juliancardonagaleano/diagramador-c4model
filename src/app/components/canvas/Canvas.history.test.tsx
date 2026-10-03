// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFlowMocks } from '../../../modules-app/testing-dom';
import { useActions } from '../../hooks/useActions';
import { useDocumentStore } from '../../store/documentStore';
import { Canvas } from './Canvas';

// El autolayout inicial de una vista (el de `Canvas`, que pasa por `layoutView` del store) se retiene hasta que la prueba lo
// suelta: así se controla qué termina antes, si ese autolayout o la exportación, que usa `autoLayoutDocument` (sin retención).
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock('@core/layout/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/layout/elkLayout')>();
  return {
    ...actual,
    layoutView: async (...args: Parameters<typeof actual.layoutView>) => {
      await gate.hold;
      return actual.layoutView(...args);
    },
  };
});
const downloads = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/files', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../utils/files')>()), downloadText: (name: string) => void downloads.push(name) }));

beforeAll(installFlowMocks);

beforeEach(() => {
  window.localStorage.clear();
  downloads.length = 0;
  useDocumentStore.getState().loadSample();
  useDocumentStore.setState({ layoutBusy: false, modified: false });
  useDocumentStore.temporal.getState().clear();
  useDocumentStore.temporal.getState().resume();
});
afterEach(() => {
  gate.hold = undefined;
});

const history = () => useDocumentStore.temporal.getState();
const canvas = (): HTMLElement => screen.getByTestId('c4-canvas');
const READY = { timeout: 20000 };

describe('historial de deshacer: autolayout inicial y exportación a .drawio', () => {
  // `Canvas` pausa el historial mientras coloca por primera vez una vista (no es una edición del usuario) y `exportDrawio` lo
  // pausa un instante para guardar las posiciones de las vistas sin abrir. Eran un pause/resume suelto, no anidado: si la
  // exportación terminaba mientras el autolayout seguía en curso, su `resume()` reanudaba el historial a mitad del autolayout
  // y la colocación llegaba después como un paso más: «Deshacer» quedaba habilitado y retrocedía a la vista sin colocar.
  it('exportar mientras sigue el autolayout inicial de la vista no deja un paso de deshacer', async () => {
    let release: () => void = () => undefined;
    gate.hold = new Promise<void>((resolve) => (release = resolve));
    render(
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>,
    );
    await waitFor(() => expect(useDocumentStore.getState().layoutBusy).toBe(true));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');

    const { result } = renderHook(() => useActions());
    await act(async () => {
      await result.current.exportDrawio();
    });
    expect(downloads).toHaveLength(1);

    release(); // el autolayout de la vista termina después de la exportación
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), READY);
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
    expect(history().pastStates).toHaveLength(0);
    expect(history().isTracking).toBe(true);
    expect(useDocumentStore.getState().modified).toBe(false);
  }, 60000);

  it('el orden contrario (el autolayout termina antes que la exportación) tampoco deja un paso', async () => {
    render(
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>,
    );
    const { result } = renderHook(() => useActions());
    const exporting = act(async () => {
      await result.current.exportDrawio();
    });
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), READY);
    await exporting;
    expect(downloads).toHaveLength(1);
    expect(history().pastStates).toHaveLength(0);
    expect(history().isTracking).toBe(true);
  }, 60000);

  it('una edición del usuario después de ambos sí es un paso de deshacer (el historial se reanuda)', async () => {
    render(
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>,
    );
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), READY);
    const { result } = renderHook(() => useActions());
    await act(async () => {
      await result.current.exportDrawio();
    });
    expect(history().pastStates).toHaveLength(0);
    act(() => useDocumentStore.getState().updateElement('cliente', { name: 'Cliente renombrado' }));
    expect(history().pastStates).toHaveLength(1);
  }, 60000);
});
