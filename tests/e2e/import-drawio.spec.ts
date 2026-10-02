import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';

/** Un .drawio mínimo con formas sueltas (sin metadatos C4): dos cajas y una flecha, más una nota de texto. */
const SIMPLE_DRAWIO =
  '<mxfile><diagram id="p" name="Mi página"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="A" value="Tienda web" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="200" height="100" as="geometry"/></mxCell>' +
  '<mxCell id="B" value="Pasarela de pagos" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="400" y="40" width="200" height="100" as="geometry"/></mxCell>' +
  '<mxCell id="E" value="Cobra con" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="A" target="B"><mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="N" value="Una nota" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="300" width="100" height="30" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

async function openMenuItem(page: Page, item: string | RegExp) {
  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText(item).click();
}

async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), openMenuItem(page, 'Importar .drawio…')]);
  await chooser.setFiles(file);
}

test('Archivo ▸ Importar .drawio carga las formas, avisa de lo omitido y deja el documento sin guardar', async ({ page }) => {
  await openEditor(page);

  await importFile(page, { name: 'mi-tienda.drawio', mimeType: 'application/xml', buffer: Buffer.from(SIMPLE_DRAWIO) });

  await expect(page.getByText('"mi-tienda.drawio" importado: 2 elementos, 1 relaciones, 1 vistas')).toBeVisible();
  // El nombre del diagrama sale del archivo, y lo importado aún no está guardado como JSON.
  await expect(page.locator('header')).toContainText('mi-tienda');
  await expect(page.locator('header')).toContainText('Cambios sin guardar');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__node', { hasText: 'Tienda web' })).toBeVisible();
  await expect(page.locator('.react-flow__node', { hasText: 'Pasarela de pagos' })).toBeVisible();

  // La nota de texto suelto no se importa y se avisa (aviso en un modal, listando cada cosa omitida).
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Importado con 1 aviso(s)');
  await expect(dialog).toContainText('1 nota(s) de texto suelto');
  await dialog.locator('button', { hasText: 'Entendido' }).click();
  await expect(dialog).toBeHidden();
});

test('un archivo que no es de draw.io muestra el motivo y no toca el diagrama actual', async ({ page }) => {
  await openEditor(page);
  const before = await page.locator('.react-flow__node').count();

  await importFile(page, { name: 'no-es-drawio.xml', mimeType: 'application/xml', buffer: Buffer.from('<html><body>hola</body></html>') });

  await expect(page.getByText(/No se pudo importar "no-es-drawio.xml": No parece un archivo de draw\.io/)).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(before);
  await expect(page.locator('header')).not.toContainText('Cambios sin guardar');
});

test('con cambios sin guardar, importar pide confirmación antes de abrir el selector', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);

  await openMenuItem(page, 'Importar .drawio…');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/sin guardar/i);
  await dialog.locator('button', { hasText: 'Cancelar' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5); // sigue el diagrama con la persona añadida

  // Esperar a que el diálogo y el menú anterior estén cerrados: si no, el clic en "Archivo" alterna el menú que aún se cierra.
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Importar .drawio…')).toBeHidden();

  // Al continuar sí se abre el selector de archivos.
  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Importar .drawio…').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('dialog').locator('button', { hasText: 'Continuar' }).click()]);
  await chooser.setFiles({ name: 'mi-tienda.drawio', mimeType: 'application/xml', buffer: Buffer.from(SIMPLE_DRAWIO) });
  await expect(page.locator('.react-flow__node', { hasText: 'Tienda web' })).toBeVisible();
});

test('ida y vuelta: lo exportado con «Exportar .drawio» se importa con todas sus vistas y se navega entre niveles', async ({ page }) => {
  await openEditor(page);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
  const exported = await download.path();
  expect(await readFile(exported!, 'utf8')).toContain('<mxfile');

  await importFile(page, exported!);
  await expect(page.getByText(/importado: 13 elementos, 19 relaciones, 3 vistas/)).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(4); // contexto: cliente, banca, mainframe y correo
  await c4Ready(page);

  // Bajar a los niveles inferiores demuestra que las vistas, sus alcances y los padres se importaron.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page);
  await expect(page.locator('.react-flow__node', { hasText: 'Aplicación API' })).toBeVisible();
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await c4Ready(page);
  await expect(page.locator('.react-flow__node', { hasText: 'Controlador de cuentas' })).toBeVisible();
});
