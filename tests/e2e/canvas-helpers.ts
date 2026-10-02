import { expect, type Page } from '@playwright/test';

/**
 * Espera a que el lienzo de módulos esté asentado: ELK ha colocado la estructura actual y la cámara ha terminado de
 * encuadrarla (`data-layout="ready"` en `module-canvas`). Antes de eso los nodos ya están en el DOM, pero en posiciones
 * provisionales que se desplazan cuando llega el autolayout y se anima el encuadre, de modo que un clic o una medida
 * hechos en ese intervalo caen donde ya no está el elemento. Con `view` espera además a que sea esa la vista activa
 * (al cambiar de vista el atributo pasa a «pending» en el mismo render que cambia `data-view`).
 */
export async function canvasReady(page: Page, view?: string): Promise<void> {
  const canvas = page.getByTestId('module-canvas');
  if (view !== undefined) await expect(canvas).toHaveAttribute('data-view', view);
  await expect(canvas).toHaveAttribute('data-layout', 'ready', { timeout: 20000 });
}

/** Cambia de vista (o de variante) con el selector del lienzo y espera a que la nueva vista esté colocada y encuadrada. */
export async function selectView(page: Page, view: string, selector: 'canvas-view' | 'canvas-variant' = 'canvas-view'): Promise<void> {
  await page.getByTestId(selector).selectOption(view);
  await canvasReady(page, view);
}
