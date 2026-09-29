import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, module = 'integration'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?module=${module}`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  return errors;
}

const docText = async (page: Page): Promise<string> => {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const text = await page.getByLabel('Documento JSON').inputValue();
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  return text;
};

test.describe('lienzo interactivo de módulos', () => {
  test('integración se abre en el lienzo con figuras propias por tipo', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-shape="cylinder"]').first()).toBeVisible();
    await expect(page.locator('[data-shape="pill"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-integration.png' });
    expect(errors).toEqual([]);
  });

  test('añadir un nodo desde la barra lo escribe en el documento y se deshace con Ctrl+Z / Ctrl+Y', async ({ page }) => {
    await open(page);
    const before = await page.locator('.react-flow__node').count();
    await page.getByTestId('add-store').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
    expect(await docText(page)).toContain('Almacén nuevo');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node')).toHaveCount(before);
    await page.keyboard.press('Control+y');
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  });

  test('seleccionar un nodo abre sus propiedades, editarlas cambia el documento y Supr lo borra', async ({ page }) => {
    await open(page);
    await page.getByTestId('add-system').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toBeVisible();
    const name = inspector.getByLabel('Nombre');
    await name.fill('Nómina Z');
    await name.blur();
    await expect(page.locator('.react-flow__node', { hasText: 'Nómina Z' })).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    await page.locator('.react-flow__node', { hasText: 'Nómina Z' }).click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node', { hasText: 'Nómina Z' })).toHaveCount(0);
    expect(await docText(page)).not.toContain('Nómina Z');
  });

  test('los atajos se listan y Ctrl+L recoloca la vista', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Atajos de teclado' }).click();
    await expect(page.getByTestId('shortcuts')).toContainText('Ctrl/⌘ + L');
    await page.keyboard.press('Control+l');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  });

  test('un documento roto avisa en el lienzo y las demás pestañas siguen ahí', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill('{ "version": ');
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'no es válido' })).toBeVisible();
  });

  test('cambiar a la vista de un flujo numera sus pasos sobre las relaciones', async ({ page }) => {
    await open(page);
    await expect(page.locator('.react-flow__edge-text', { hasText: /^1\./ })).toHaveCount(0);
    const select = page.getByTestId('canvas-view');
    const options = await select.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(1);
    await select.selectOption({ index: 1 });
    await expect(page.locator('.react-flow__edge-text', { hasText: /^1\./ }).first()).toBeVisible();
  });
});
