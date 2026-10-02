import { test, expect } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';

test('menú Ver, tema y exportación a .drawio', async ({ page }) => {
  await openEditor(page);

  // Conmutar a tarjetas estilo drawdb desde el menú Ver.
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Tarjetas (estilo drawdb)').click();
  await expect(page.locator('.c4-node')).not.toHaveCount(0);
  await expect(page.locator('.c4-shape-svg')).toHaveCount(0);
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Notación C4 clásica').click();
  await expect(page.locator('.c4-shape-svg')).not.toHaveCount(0);

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
  await expect(page.getByText('Exportar .drawio (tarjetas)')).toBeHidden(); // el menú Archivo, cerrado

  // Tema oscuro.
  await page.getByRole('button', { name: 'Tema oscuro' }).click();
  expect(await page.evaluate(() => document.body.getAttribute('theme-mode'))).toBe('dark');
});

test('Nuevo diagrama / Cargar ejemplo / Abrir JSON piden confirmación si hay cambios sin guardar', async ({ page }) => {
  await openEditor(page);

  // Genera cambios sin guardar.
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);

  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Nuevo diagrama').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await expect(dialog).toContainText(/sin guardar/i);

  // Semi UI pone aria-label="cancel"/"confirm" (fijo, en inglés) en los botones del modal de
  // confirmación, que pisa el nombre accesible sobre el texto visible; se localizan por texto.
  await dialog.locator('button', { hasText: 'Cancelar' }).click();
  // Esperar a que el diálogo y el menú estén cerrados: si no, el clic siguiente en "Archivo" alterna el menú que aún se cierra.
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Nuevo diagrama')).toBeHidden();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);

  // Confirmar sí lo descarta.
  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Nuevo diagrama').click();
  await page.getByRole('dialog').locator('button', { hasText: 'Continuar' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});

test('navegar a vistas sin colocar y exportar .drawio no cuentan como cambios sin guardar', async ({ page }) => {
  await openEditor(page);
  const header = page.locator('header');
  await expect(header).not.toContainText('Cambios sin guardar');

  // Bajar a C2/C3 dispara el autolayout inicial de cada vista: no es una edición del usuario.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page, 'contenedores');
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await c4Ready(page, 'componentes-api');
  await expect(header).not.toContainText('Cambios sin guardar');

  // Exportar coloca las vistas que faltan, pero tampoco marca el documento como modificado ni añade un paso de deshacer.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
  const xml = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
  expect(xml.startsWith('<mxfile')).toBe(true);
  await expect(header).not.toContainText('Cambios sin guardar');
  await expect(page.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
});
