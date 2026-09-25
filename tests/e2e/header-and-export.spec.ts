import { test, expect } from '@playwright/test';

test('menú Ver, tema y exportación a .drawio', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  // Conmutar a tarjetas estilo drawdb desde el menú Ver.
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Tarjetas (estilo drawdb)').click();
  await page.waitForTimeout(300);
  expect(await page.locator('.c4-node').count()).toBeGreaterThan(0);
  await expect(page.locator('.c4-shape-svg')).toHaveCount(0);
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Notación C4 clásica').click();
  await page.waitForTimeout(300);
  expect(await page.locator('.c4-shape-svg').count()).toBeGreaterThan(0);

  // Exportar .drawio (descarga) en ambas notaciones.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
  const xml = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
  expect(xml.startsWith('<mxfile')).toBe(true);
  expect((xml.match(/<diagram /g) || []).length).toBe(3);
  expect(xml.includes('mxgraph.c4.person2')).toBe(true);
  expect(xml.includes('<Array as="points">')).toBe(true);

  await page.getByText('Archivo', { exact: true }).click();
  const [download2] = await Promise.all([page.waitForEvent('download'), page.getByText('Exportar .drawio (tarjetas)').click()]);
  const xml2 = await (await import('node:fs/promises')).readFile((await download2.path())!, 'utf8');
  expect(xml2.includes('fillColor=#F4F4F5') && !xml2.includes('mxgraph.c4.person2')).toBe(true);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // Tema oscuro.
  await page.getByRole('button', { name: 'Tema oscuro' }).click();
  expect(await page.evaluate(() => document.body.getAttribute('theme-mode'))).toBe('dark');
});

test('Nuevo diagrama / Cargar ejemplo / Abrir JSON piden confirmación si hay cambios sin guardar', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  // Genera cambios sin guardar.
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await page.waitForTimeout(300);

  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Nuevo diagrama').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await expect(dialog).toContainText(/sin guardar/i);

  // Semi UI pone aria-label="cancel"/"confirm" (fijo, en inglés) en los botones del modal de
  // confirmación, que pisa el nombre accesible sobre el texto visible; se localizan por texto.
  await dialog.locator('button', { hasText: 'Cancelar' }).click();
  await page.waitForTimeout(200);
  await expect(page.locator('.react-flow__node')).toHaveCount(5);

  // Confirmar sí lo descarta.
  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Nuevo diagrama').click();
  await page.getByRole('dialog').locator('button', { hasText: 'Continuar' }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});
