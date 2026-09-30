import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, module: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?module=${module}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  return errors;
}

test.describe('enlaces entre diagramas (URN) y pestaña C4', () => {
  test('doble clic en un elemento enlazado abre el módulo destino con el elemento seleccionado, y Alt+↑ vuelve', async ({ page }) => {
    const errors = await open(page, 'data');
    await expect(page.getByTestId('link-erp')).toBeVisible();
    await page.locator('[data-testid="node-erp"] .cv-group-title').dblclick();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.locator('[data-testid="node-pedidos"][data-selected]')).toBeVisible();
    await expect(page.getByTestId('trail')).toContainText('Datos · erp');
    await expect(page.getByTestId('backlinks')).toContainText('Datos: ERP de pedidos');
    await expect(page.getByTestId('backlinks')).toContainText('Plataforma: Servicio de pedidos');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.getByTestId('trail')).toHaveCount(0);
    await expect(page.locator('[data-testid="node-erp"][data-selected]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('el enlace se elige por módulo y elemento desde las propiedades y «Referenciado por» lleva de vuelta', async ({ page }) => {
    await open(page, 'integration');
    await page.locator('[data-testid="node-tienda-web"]').click();
    const picker = page.getByTestId('ref-picker');
    await expect(picker).toContainText('Sin enlace');
    await picker.getByLabel('Módulo enlazado').selectOption('c4');
    await picker.getByLabel('Elemento enlazado').selectOption({ index: 1 });
    await expect(picker.locator('small')).toContainText('urn:iark:c4:');
    await expect(page.getByTestId('link-tienda-web')).toBeVisible();
    await picker.getByTestId('follow-ref').click();
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.locator('iframe[data-testid="c4-embed"]')).toBeVisible();
    await expect(page.getByTestId('trail')).toContainText('Integración · tienda-web');
    await page.getByTestId('trail-back').click();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  });

  test('C4 se edita en el banco con el editor principal embebido y su documento se sincroniza con la pestaña JSON', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/modulos.html?module=c4', { waitUntil: 'networkidle' });
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true');
    const iframe = page.locator('iframe[data-testid="c4-embed"]');
    await expect(iframe).toBeVisible({ timeout: 20000 });
    const inside = page.frameLocator('iframe[data-testid="c4-embed"]');
    await expect(inside.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
    // el banco de trabajo no pinta el editor C4 fuera del iframe
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    // C4 ya exporta SVG con las figuras del lienzo, así que la pestaña se llama «Vista SVG» y dibuja la vista activa.
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    await expect(page.getByTestId('diagram-stage').locator('img')).toBeVisible({ timeout: 20000 });
    const editor = page.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    doc.workspace.name = 'Banca renombrada';
    await editor.fill(JSON.stringify(doc, null, 2));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    // al volver se crea otro iframe: el editor recibe el documento renombrado
    await expect(iframe).toBeVisible();
    await expect(page.frameLocator('iframe[data-testid="c4-embed"]').locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
    expect(errors).toEqual([]);
  });
});
