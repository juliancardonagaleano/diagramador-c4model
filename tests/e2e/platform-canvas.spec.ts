import { expect, test, type Page } from '@playwright/test';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=platform', { waitUntil: 'networkidle' });
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

test.describe('lienzo de plataforma: infraestructura, metadatos y acciones', () => {
  test('cada recurso lleva su figura y las redes se trazan según su exposición, con insignias de coste y límites', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('canvas-view').selectOption('env:prod');
    await expect(page.locator('[data-testid="node-kafka-prod"][data-shape="pipe"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-lb-prod"][data-shape="diamond"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos-db-prod"][data-shape="cylinder"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-subred-publica"].cv-group')).toHaveCSS('border-top-style', 'solid');
    await expect(page.locator('[data-testid="node-subred-apps"].cv-group')).toHaveCSS('border-top-style', 'dashed');
    await expect(page.locator('[data-testid="node-subred-datos"].cv-group')).toHaveCSS('border-top-style', 'dotted');
    await expect(page.locator('[data-testid="node-pedidos-db-prod"]')).toContainText('1.240 USD/mes');
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('SLO 99,95 %');
    await page.screenshot({ path: 'test-results/platform-env-prod.png' });
    expect(errors).toEqual([]);
  });

  test('la vista de costes agrupa por entorno con su total', async ({ page }) => {
    await open(page);
    await page.getByTestId('canvas-view').selectOption('costs');
    await expect(page.locator('[data-testid="node-c:prod"].cv-group')).toContainText('4.420 USD/mes');
    await expect(page.locator('[data-testid="node-c:dev"].cv-group')).toContainText('660 USD/mes');
    await page.screenshot({ path: 'test-results/platform-costs.png' });
  });

  test('«Escalar réplicas» y «Promover a otro entorno» actúan sobre la selección', async ({ page }) => {
    await open(page);
    await page.getByTestId('canvas-view').selectOption('env:prod');
    await expect(page.getByTestId('action-scale-replicas')).toBeDisabled();
    await page.locator('[data-testid="node-i:pedidos-prod"]').click();
    await page.getByTestId('action-scale-replicas').click();
    await page.getByTestId('action-prompt').getByRole('textbox').fill('+2');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('5 réplicas');
    await page.getByTestId('canvas-view').selectOption('env:dev');
    await page.locator('[data-testid="node-i:reportes-dev"]').click();
    await page.getByTestId('action-promote-environment').click();
    await expect(page.getByTestId('action-prompt').getByRole('combobox')).toHaveValue('Producción');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    expect(await docText(page)).not.toContain('"version": "0.3.5"');
  });

  test('«Duplicar entorno» crea el entorno nuevo con sus recursos', async ({ page }) => {
    await open(page);
    await page.getByTestId('canvas-view').selectOption('env:dev');
    await page.locator('[data-testid="node-pedidos-db-dev"]').click();
    await page.getByTestId('action-duplicate-environment').click();
    await expect(page.getByTestId('action-prompt').getByRole('textbox')).toHaveValue('Desarrollo (copia)');
    await page.getByTestId('action-prompt').getByRole('textbox').fill('Pruebas de carga');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    const text = await docText(page);
    expect(text).toContain('"name": "Pruebas de carga"');
    expect(text).toContain('pedidos-db-dev-pruebas-de-carga');
    await expect(page.getByTestId('canvas-view').locator('option', { hasText: 'Pruebas de carga' })).toHaveCount(1);
  });

  test('la vista «Comparar» pone dos entornos lado a lado y marca lo que difiere', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('canvas-view').selectOption('compare:dev:prod');
    await expect(page.locator('[data-testid="node-c:dev"].cv-group')).toContainText('Desarrollo');
    await expect(page.locator('[data-testid="node-c:prod"].cv-group')).toContainText('Producción');
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('Versión + réplicas');
    await expect(page.locator('[data-testid="node-i:pedidos-dev"]')).toContainText('3.1.0');
    await expect(page.locator('[data-testid="node-lb-prod"]')).toContainText('Solo en Producción');
    await page.screenshot({ path: 'test-results/platform-compare.png' });
    expect(errors).toEqual([]);
  });
});
