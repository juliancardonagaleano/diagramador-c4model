import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.describe('vista de trazabilidad entre módulos', () => {
  test('carga los ejemplos, dibuja el grafo y lista los enlaces por par de módulos', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/trazabilidad.html', { waitUntil: 'networkidle' });
    await expect(page.locator('#summary')).toContainText('sin documentos');
    await expect(page.getByText('Carga los documentos de al menos dos módulos')).toBeVisible();

    await page.getByRole('button', { name: 'Cargar los ejemplos' }).click();
    await expect(page.locator('#summary')).toContainText('5 documentos · 14 enlaces');
    const graph = page.getByRole('img', { name: /Grafo de trazabilidad: 14 enlaces entre 5 módulos/ });
    await expect(graph).toBeVisible();
    await expect.poll(() => graph.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(300);

    await page.getByRole('tab', { name: 'Enlaces (14)' }).click();
    await expect(page.getByRole('heading', { name: 'Seguridad → Plataforma (5)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plataforma → Integración (6)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Empresarial → Integración (3)' })).toBeVisible();

    await page.getByRole('tab', { name: 'Sin resolver (0)' }).click();
    await expect(page.getByText('Todas las referencias se resuelven.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('alcance de un elemento: el impacto atraviesa los módulos y se acota por saltos', async ({ page }) => {
    await page.goto('/trazabilidad.html?examples=1&tab=reach', { waitUntil: 'networkidle' });
    await expect(page.getByLabel('Elemento de partida')).toBeVisible();
    await page.getByLabel('Elemento de partida').selectOption('urn:iark:integration:pedidos');
    await page.getByLabel('Sentido').selectOption('referrers');
    const report = page.locator('.tr-report');
    await expect(report).toContainText('security:pedidos (Servicio de pedidos) · asset · a 2 saltos');
    await expect(report).toContainText('Módulos alcanzados: platform, security');

    await page.getByLabel('Saltos máximos').fill('1');
    await page.getByLabel('Saltos máximos').dispatchEvent('change');
    await expect(report).not.toContainText('security:pedidos');
    await expect(report).toContainText('platform:pedidos');
    await expect(page.getByRole('img', { name: /Alcance de Servicio de pedidos \(integration:pedidos\): 1 elementos/ })).toBeVisible();
  });

  test('documentos por archivo o pegados: un módulo sin su destino deja la referencia sin resolver y un JSON roto no borra nada', async ({ page }) => {
    await page.goto('/trazabilidad.html', { waitUntil: 'networkidle' });
    const security = page.locator('section[data-module="security"]');
    await security.locator('input[type="file"]').setInputFiles({ name: 'seguridad.json', mimeType: 'application/json', buffer: readFileSync('examples/seguridad-ejemplo.json') });
    await expect(security.locator('.wb-chip')).toContainText('elementos');
    await expect(page.locator('#summary')).toContainText('1 documentos · 0 enlaces · 5 sin resolver');

    await page.getByRole('tab', { name: /Sin resolver/ }).click();
    await expect(page.getByText('módulo sin documento').first()).toBeVisible();

    await security.getByText('Pegar JSON').click();
    await security.getByLabel('JSON de Seguridad').fill('{ roto');
    await security.getByRole('button', { name: 'Aplicar' }).click();
    await expect(security.getByRole('alert')).toContainText('No es JSON válido');
    await expect(security.locator('.wb-chip')).toContainText('elementos'); // el documento anterior sigue

    // añadir la plataforma resuelve los enlaces del nivel siguiente
    const platform = page.locator('section[data-module="platform"]');
    await platform.getByRole('button', { name: 'Ejemplo' }).click();
    await expect(page.locator('#summary')).toContainText('2 documentos · 5 enlaces');

    await page.getByRole('button', { name: 'Vaciar' }).click();
    await expect(page.locator('#summary')).toContainText('sin documentos');
  });

  test('desde el banco de trabajo y el shell se llega a la vista', async ({ page }) => {
    await page.goto('/modulos.html', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Trazabilidad' }).click();
    await expect(page).toHaveURL(/trazabilidad\.html$/);
    await page.goto('/suite.html', { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: 'Trazabilidad' })).toHaveAttribute('href', 'trazabilidad.html');
  });
});
