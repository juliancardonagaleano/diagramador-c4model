import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Apoyo de las pruebas con jsdom que dibujan el lienzo de React Flow: jsdom no mide nada, así que se simula lo mínimo
 * para que dé por medidos los nodos (y dibuje las aristas), y los clics se hacen como los entiende d3-drag.
 */
class MeasuringObserver {
  constructor(private readonly callback: (entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void) {}
  observe(target: Element): void {
    queueMicrotask(() => this.callback([{ target, contentRect: { width: 800, height: 600 } }]));
  }
  unobserve(): void {}
  disconnect(): void {}
}

export function installFlowMocks(): void {
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; });
  vi.stubGlobal('ResizeObserver', MeasuringObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 120 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 60 });
}

const win = window as unknown as Window;

/** Clic de verdad sobre un nodo: React Flow selecciona al empezar el arrastre, no con el evento `click`. Con `additive` mantiene Ctrl pulsada. */
export async function pickNode(id: string, additive = false): Promise<void> {
  const el = screen.getByTestId(`node-${id}`).closest('.react-flow__node') as HTMLElement;
  await act(async () => {
    if (additive) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true }));
  });
  await act(async () => {
    const down = new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey: additive });
    Object.defineProperty(down, 'view', { value: win });
    el.dispatchEvent(down);
    const up = new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey: additive });
    Object.defineProperty(up, 'view', { value: win });
    win.dispatchEvent(up);
    fireEvent.click(el, { ctrlKey: additive });
  });
  await act(async () => {
    if (additive) document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', bubbles: true }));
  });
}

/** Pulsación completa (bajar y soltar) sobre la ventana, que es donde escuchan los atajos del lienzo. */
export function pressKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...init }));
  });
}
