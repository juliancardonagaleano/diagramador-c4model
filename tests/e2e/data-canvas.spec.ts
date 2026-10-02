import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { canvasReady, selectView } from './canvas-helpers';

/** Si existe, las capturas de la notación se dejan también en la carpeta de salidas del proyecto. */
const SHOTS = process.env.DATA_SHOTS_DIR;
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `test-results/${name}.png` });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
};

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=data', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

const docText = async (page: Page): Promise<string> => {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const text = await page.getByLabel('Documento JSON').inputValue();
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  return text;
};

test.describe('datos: lienzo con gobierno, ERD y contratos', () => {
  test('las figuras llevan insignias de datos personales, clasificación y aviso de falta de responsable', async ({ page }) => {
    const errors = await open(page);
    const clientes = page.getByTestId('node-bronze-clientes');
    await expect(clientes).toContainText('🔒 PII');
    await expect(clientes).toContainText('confidencial');
    await expect(page.getByTestId('node-erp-pedidos')).toContainText('interna');
    await shot(page, 'lienzo-gobierno');
    expect(errors).toEqual([]);
  });

  test('el ERD dibuja la pata de gallo en los extremos de la relación y resalta las claves', async ({ page }) => {
    await open(page);
    await selectView(page, 'erd');
    await expect(page.getByTestId('node-erp-pedidos')).toBeVisible();
    await expect(page.getByTestId('edge-end-pedido-lineas-source')).toHaveAttribute('data-end', 'one');
    await expect(page.getByTestId('edge-end-pedido-lineas-target')).toHaveAttribute('data-end', 'many');
    await expect(page.locator('[data-testid="node-erp-lineas"] li[data-emphasis="key"]').first()).toContainText('PK,FK pedido_id');
    await expect(page.locator('[data-testid="node-erp-pedidos"] li[data-emphasis="ref"]')).toContainText('FK cliente_id');
    await shot(page, 'erd-pata-de-gallo');
  });

  test('el mapa de calor colorea el linaje por clasificación', async ({ page }) => {
    await open(page);
    await selectView(page, 'calor:clasificacion');
    await expect(page.getByTestId('node-bronze-clientes')).toBeVisible();
    await shot(page, 'mapa-de-calor-clasificacion');
  });

  test('«Enmascarar» inserta el pipeline que anonimiza y «Propagar clasificación» se deshabilita sin nada que propagar', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('action-mask')).toBeDisabled();
    await page.getByTestId('node-crm-clientes').click();
    await expect(page.getByTestId('action-mask')).toBeEnabled();
    await expect(page.getByTestId('action-propagate-classification')).toBeDisabled();
    await page.getByTestId('action-mask').click();
    await expect(page.getByTestId('node-pipeline:enmascarar-crm-clientes')).toBeVisible();
    await expect(page.getByTestId('node-crm-clientes-anonimizado')).toBeVisible();
    const text = await docText(page);
    expect(text).toContain('"anonymizes": true');
    expect(text).toContain('crm-clientes-anonimizado');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('node-pipeline:enmascarar-crm-clientes')).toHaveCount(0);
    await shot(page, 'enmascarar-deshecho');
  });

  test('«Agrupar en dominio» reasigna los activos seleccionados', async ({ page }) => {
    await open(page);
    await page.getByTestId('node-bronze-pedidos').click();
    await page.getByTestId('node-bronze-clientes').click({ modifiers: ['Control'] });
    await page.getByTestId('action-group-domain').click();
    await page.getByTestId('action-prompt').getByRole('combobox').fill('Datos crudos');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    const text = await docText(page);
    expect(text).toContain('"name": "Datos crudos"');
  });

  test('desde un activo se crea su contrato de datos YAML, el editor lo valida y avisa de un tipo desconocido', async ({ page }) => {
    await open(page);
    await page.getByTestId('node-dwh-dim-cliente').click();
    await page.getByTestId('attachment-new').click();
    await expect(page.getByRole('tab', { name: 'Contratos' })).toHaveAttribute('aria-selected', 'true');
    const text = page.getByTestId('attachment-text');
    await expect(text).toHaveValue(/kind: DataContract/);
    await expect(text).toHaveValue(/primaryKey: true/);
    await expect(page.getByTestId('attachment-summary')).toContainText('dim_cliente: 3 propiedades');
    await text.fill((await text.inputValue()).replace('logicalType: integer', 'logicalType: entero'));
    await text.blur();
    await expect(page.getByTestId('attachment-diagnostics')).toContainText('Tipo lógico desconocido');
    await shot(page, 'contrato-de-datos');
  });

  test('el linaje de columnas se edita en el pipeline y la vista de impacto de columna llega hasta el informe', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('node-pipeline:publica-panel').click();
    const mappings = page.getByTestId('inspector').getByLabel('Linaje de columnas (una por línea)');
    await expect(mappings).toHaveValue(/dwh-fact-ventas\.importe -> panel-ventas\.Ventas totales : suma por mes/);
    await mappings.fill('dwh-fact-ventas.importe -> panel-ventas.Ventas totales : suma por mes\ndwh-fact-ventas.fecha -> panel-ventas.Mes\ndwh-fact-ventas.venta_key -> panel-ventas.Pedidos : cuenta');
    await mappings.blur();
    expect(await docText(page)).toContain('"column": "Pedidos"');
    await page.getByTestId('node-pipeline:publica-panel').click();
    await mappings.fill('esto no es un mapeo');
    await mappings.blur();
    await expect(page.locator('.wb-toast')).toContainText('Línea de linaje no válida');
    await expect(page.locator('.wb-toast')).toHaveCount(0, { timeout: 8000 });
    await page.keyboard.press('Escape');

    await selectView(page, 'column:erp-pedidos.total');
    await expect(page.getByTestId('node-erp-pedidos')).toContainText('● total: numeric');
    await expect(page.getByTestId('node-silver-ventas')).toContainText('▸ importe: numeric');
    await expect(page.getByTestId('node-panel-ventas')).toContainText('▸ Ventas totales');
    await expect(page.getByTestId('node-modelo-fuga')).toContainText('▸ gasto_total');
    await expect(page.getByTestId('node-crm-clientes')).toHaveCount(0);
    await shot(page, 'linaje-columna');
    expect(errors).toEqual([]);
  });
});
