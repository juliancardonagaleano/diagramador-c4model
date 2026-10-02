import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=enterprise', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  return errors;
}

/** Sustituye el documento por el ejemplo ampliado con las relaciones nuevas y vuelve al lienzo. */
async function loadExtended(page: Page): Promise<void> {
  const doc = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as {
    processes: Array<Record<string, unknown>>;
    applications: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
  doc.processes.push({ id: 'preparacion-pedido', name: 'Preparación de pedido', ownerId: 'logistica' });
  doc.applications.push({ id: 'erp-facturacion', name: 'ERP · módulo de facturación', technology: 'SAP S/4HANA', ownerId: 'finanzas', criticality: 'high', annualCost: 210000, users: 40, strategy: 'keep' });
  for (const a of doc.applications) {
    if (a.id === 'wms-legacy') a.endOfLife = '2027-03';
    if (a.id === 'portal-proveedores') a.endOfLife = '2026-12';
  }
  doc.relations.push(
    { id: 'erp--composes--erp-facturacion', kind: 'composes', sourceId: 'erp', targetId: 'erp-facturacion' },
    { id: 'erp-facturacion--flows-to--facturacion-electronica', kind: 'flows-to', sourceId: 'erp-facturacion', targetId: 'facturacion-electronica', description: 'facturas a emitir' },
    { id: 'alta-pedido--triggers--preparacion-pedido', kind: 'triggers', sourceId: 'alta-pedido', targetId: 'preparacion-pedido' },
    { id: 'preparacion-pedido--realizes--gestion-inventario', kind: 'realizes', sourceId: 'preparacion-pedido', targetId: 'gestion-inventario' },
    { id: 'ventas--assigned-to--alta-pedido', kind: 'assigned-to', sourceId: 'ventas', targetId: 'alta-pedido' },
    { id: 'logistica--assigned-to--preparacion-pedido', kind: 'assigned-to', sourceId: 'logistica', targetId: 'preparacion-pedido' },
  );
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
}

const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: `test-results/empresarial-${name}.png` });

test.describe('lienzo empresarial: capas, mapa por criterio y relaciones nuevas', () => {
  test('los nodos llevan el color de su capa y el icono de su tipo', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('canvas-view').selectOption('landscape');
    const app = page.getByTestId('node-tienda-web');
    await expect(app).toBeVisible();
    await expect(app.getByTestId('icon-tienda-web')).toBeVisible();
    await expect(page.getByTestId('node-kubernetes').getByTestId('icon-kubernetes')).toBeVisible();
    await expect(app.locator('path').first()).toHaveAttribute('fill', '#74c0fc');
    await expect(page.getByTestId('node-kubernetes').locator('path').first()).toHaveAttribute('fill', '#8ce99a');
    await shot(page, 'paisaje-capas');
    expect(errors).toEqual([]);
  });

  test('el mapa de capacidades se colora por madurez, importancia, criticidad o ciclo de vida, con leyenda', async ({ page }) => {
    const errors = await open(page);
    const legend = page.getByTestId('canvas-legend');
    await expect(legend).toContainText('Color: madurez');
    await shot(page, 'mapa-madurez');
    for (const [value, title, name] of [
      ['capabilities:importance', 'Color: importancia', 'mapa-importancia'],
      ['capabilities:criticality', 'Color: criticidad de las aplicaciones', 'mapa-criticidad'],
      ['capabilities:lifecycle', 'Color: ciclo de vida de las aplicaciones', 'mapa-ciclo-de-vida'],
    ] as const) {
      await page.getByTestId('canvas-variant').selectOption(value);
      await expect(legend).toContainText(title);
      await expect(page.getByTestId('node-gestion-inventario')).toBeVisible();
      await shot(page, name);
    }
    // «Vista» sigue siendo el mapa: la variante no aparece como una vista más.
    await expect(page.getByTestId('canvas-view')).toHaveValue('capabilities');
    expect(errors).toEqual([]);
  });

  test('composición, flujo, asignación y disparo se dibujan con su notación', async ({ page }) => {
    const errors = await open(page);
    await loadExtended(page);
    await page.getByTestId('canvas-view').selectOption('landscape');
    await expect(page.getByTestId('node-ventas')).toHaveAttribute('data-kind', 'unit');
    await expect(page.locator('.react-flow__edge[data-id="erp--composes--erp-facturacion"] [data-tail="diamond"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge[data-id="ventas--assigned-to--alta-pedido"] [data-tail="dot"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge[data-id="alta-pedido--triggers--preparacion-pedido"]')).toBeVisible();
    await page.getByTestId('node-erp-facturacion').click();
    await expect(page.getByTestId('inspector').getByLabel('Estrategia de modernización')).toHaveValue('keep');
    await expect(page.getByTestId('inspector').getByLabel('Coste anual')).toHaveValue('210000');
    await shot(page, 'paisaje-relaciones');
    expect(errors).toEqual([]);
  });

  test('la relación se elige en la barra y el mismo selector ofrece los cuatro tipos nuevos', async ({ page }) => {
    await open(page);
    const kinds = await page.getByTestId('edge-kind').locator('option').allTextContents();
    expect(kinds).toEqual(expect.arrayContaining(['se compone de', 'fluye hacia', 'ejecuta', 'dispara a']));
  });

  test('los metadatos de una aplicación se editan en sus propiedades y llegan al documento', async ({ page }) => {
    await open(page);
    await page.getByTestId('canvas-view').selectOption('landscape');
    await page.getByTestId('node-crm').click();
    const inspector = page.getByTestId('inspector');
    await inspector.getByLabel('Coste anual').fill('300000');
    await inspector.getByLabel('Usuarios').fill('150');
    await inspector.getByLabel('Estrategia de modernización').selectOption('migrate');
    await expect(page.getByTestId('node-crm')).toContainText('estrategia migrar');
    await expect(page.getByTestId('node-crm')).toContainText('300 k/año');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const text = await page.getByLabel('Documento JSON').inputValue();
    expect(text).toContain('"annualCost": 300000');
    expect(text).toContain('"strategy": "migrate"');
  });

  test('la hoja de ruta del ciclo de vida agrupa en columnas y «Agrupar por unidad» y «Reemplazar aplicación» actúan sobre la selección', async ({ page }) => {
    const errors = await open(page);
    await loadExtended(page);
    await page.getByTestId('canvas-view').selectOption('roadmap');
    await expect(page.getByTestId('node-roadmap:2027')).toBeVisible();
    await expect(page.getByTestId('node-roadmap:2026')).toBeVisible();
    await expect(page.getByTestId('node-wms-legacy')).toContainText('estrategia reemplazar');
    await expect(page.getByTestId('node-hana')).toContainText('soporte hasta 2034-12');
    await shot(page, 'hoja-de-ruta');

    await page.getByTestId('canvas-view').selectOption('landscape');
    await page.getByTestId('node-crm').click();
    await page.getByTestId('action-replace-application').click();
    await page.getByTestId('action-prompt').locator('input').fill('CRM nuevo');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('node-crm-nuevo')).toBeVisible();
    await expect(page.getByTestId('node-crm')).toContainText('en retirada');

    await page.getByTestId('node-tms').click();
    await page.getByTestId('node-wms-nuevo').click({ modifiers: ['Control'] });
    await page.getByTestId('action-group-by-unit').click();
    await page.getByTestId('action-prompt').locator('input').fill('Equipo de datos');
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const text = await page.getByLabel('Documento JSON').inputValue();
    expect(text).toContain('"id": "equipo-de-datos"');
    expect(JSON.parse(text).applications.find((a: { id: string }) => a.id === 'tms').ownerId).toBe('equipo-de-datos');
    expect(errors).toEqual([]);
  });
});
