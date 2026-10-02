// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fitView } = vi.hoisted(() => ({ fitView: vi.fn<(options?: unknown) => Promise<boolean>>() }));
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ fitView }) }));

import { holdCamera, useCameraPending, useFitCamera } from './camera';

/** Un hook que expone a la vez el estado «hay encuadres pendientes» y las funciones de encuadre. */
function useCamera() {
  return { pending: useCameraPending(), ...useFitCamera() };
}

/** Promesa que se resuelve o rechaza desde fuera, para controlar cuándo termina el trabajo previo al encuadre. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  fitView.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('encuadres pendientes de la cámara', () => {
  it('holdCamera anota un encuadre y soltarlo varias veces solo descuenta uno', () => {
    const { result } = renderHook(() => useCamera());
    expect(result.current.pending).toBe(false);

    let releaseA!: () => void;
    let releaseB!: () => void;
    act(() => {
      releaseA = holdCamera();
      releaseB = holdCamera();
    });
    expect(result.current.pending).toBe(true);

    act(() => {
      releaseA();
      releaseA();
    });
    expect(result.current.pending).toBe(true); // el segundo sigue anotado: soltar dos veces el primero no lo descuenta
    act(() => releaseB());
    expect(result.current.pending).toBe(false);
  });

  it('fitAfter anota el encuadre al pedirlo, espera al trabajo y al retardo, y lo suelta cuando acaba la animación', async () => {
    const animation = deferred<boolean>();
    fitView.mockReturnValue(animation.promise);
    const work = deferred();
    const { result } = renderHook(() => useCamera());

    act(() => result.current.fitAfter(work.promise, { padding: 0.15, duration: 300 }, 50));
    expect(result.current.pending).toBe(true);
    expect(fitView).not.toHaveBeenCalled();

    await act(async () => {
      work.resolve();
      await vi.advanceTimersByTimeAsync(49);
    });
    expect(fitView).not.toHaveBeenCalled(); // aún no pasaron los 50 ms: el hueco entre el trabajo y el encuadre sigue anotado
    expect(result.current.pending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fitView).toHaveBeenCalledWith({ padding: 0.15, duration: 300 });
    expect(result.current.pending).toBe(true); // se está animando

    await act(async () => {
      animation.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.pending).toBe(false);
  });

  it('sin retardo, fit encuadra al instante (no se aplaza a otro turno) y sigue anotado mientras dura la animación', async () => {
    const animation = deferred<boolean>();
    fitView.mockReturnValue(animation.promise);
    const { result } = renderHook(() => useCamera());

    act(() => result.current.fit({ padding: 0.15, duration: 300 }));
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);

    await act(async () => {
      animation.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.pending).toBe(false);
  });

  it('si React Flow interrumpe la animación sin avisar, el encuadre se da por terminado pasada su duración más un margen', async () => {
    fitView.mockReturnValue(new Promise(() => {})); // nunca se resuelve
    const { result } = renderHook(() => useCamera());

    act(() => result.current.fit({ duration: 200 }, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.pending).toBe(false);
  });

  it('si el trabajo previo falla no se encuadra y el encuadre anotado se suelta', async () => {
    const work = deferred();
    const { result } = renderHook(() => useCamera());

    act(() => result.current.fitAfter(work.promise, { duration: 300 }, 30));
    expect(result.current.pending).toBe(true);

    await act(async () => {
      work.reject(new Error('ELK falló'));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fitView).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it('si fitView lanza al llamarlo, el encuadre también se suelta', async () => {
    fitView.mockImplementation(() => {
      throw new Error('sin instancia');
    });
    const { result } = renderHook(() => useCamera());

    act(() => result.current.fit({ duration: 300 }, 0));
    expect(result.current.pending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.pending).toBe(false);
  });
});
