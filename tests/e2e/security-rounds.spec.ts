import { expect, test, type Page } from '@playwright/test';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=security', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  return errors;
}

test.describe('lienzo de seguridad: fronteras, sugerencias y protección', () => {
  test('las zonas cruzadas se dibujan como frontera de confianza y los flujos que cruzan llevan marcador', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('[data-testid="node-internet"].cv-group')).toContainText('frontera de confianza');
    await expect(page.locator('[data-testid="node-internet"].cv-group')).toHaveCSS('border-top-color', 'rgb(201, 42, 42)');
    await expect(page.getByTestId('edge-mark-cliente-navega-0')).toHaveAttribute('title', /Cruza frontera de confianza/);
    await page.screenshot({ path: '/mnt/project-files/seguridad/ronda-fronteras-dfd.png' });
    expect(errors).toEqual([]);
  });

  test('sugerir amenazas propone STRIDE por cruce y se puede aceptar o descartar', async ({ page }) => {
    await open(page);
    await page.getByTestId('canvas-view').selectOption('threats');
    const before = await page.locator('.react-flow__node').count();
    await page.getByTestId('action-suggest-threats').click();
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(before);
    await page.screenshot({ path: '/mnt/project-files/seguridad/ronda-sugerir-amenazas.png' });
    await expect(page.getByTestId('action-accept-suggestion')).toBeDisabled();
  });

  test('proteger flujo se ofrece solo con un flujo seleccionado', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('action-protect-flow')).toBeDisabled();
    await expect(page.getByTestId('action-mitigate-threat')).toBeDisabled();
  });
});
