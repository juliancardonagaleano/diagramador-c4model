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

test.describe('lienzo empresarial', () => {
  test('el mapa de capacidades se abre anidado con su propia cuadrícula y el paisaje con figuras por capa', async ({ page }) => {
    const errors = await open(page, 'enterprise');
    await expect(page.locator('[data-testid="node-gestion-comercial"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-ventas-online"][data-kind="capability"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-enterprise-capabilities.png' });
    await page.getByTestId('canvas-view').selectOption('landscape');
    await expect(page.locator('[data-shape="bar"]').first()).toBeVisible();
    await expect(page.locator('[data-shape="chevron"]').first()).toBeVisible();
    await expect(page.locator('.react-flow__edge').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-enterprise-landscape.png' });
    expect(errors).toEqual([]);
  });

  test('una capacidad nueva entra en el mapa y su madurez se elige en las propiedades', async ({ page }) => {
    await open(page, 'enterprise');
    await page.getByTestId('add-capability').click();
    const inspector = page.getByTestId('inspector');
    await inspector.getByLabel('Madurez').selectOption('5');
    await expect(page.locator('.react-flow__node', { hasText: 'madurez 5/5' }).first()).toBeVisible();
    expect(await docText(page)).toContain('"maturity": 5');
  });
});

test.describe('lienzo de plataforma', () => {
  test('la vista del entorno anida redes y clústeres con las instancias dentro, y la topología usa figuras por clase de recurso', async ({ page }) => {
    const errors = await open(page, 'platform');
    await page.getByTestId('canvas-view').selectOption('env:prod');
    await expect(page.locator('[data-testid="node-vpc-prod"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-k8s-prod"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toBeVisible();
    await expect(page.locator('[data-shape="cylinder"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-platform-prod.png' });
    await page.getByTestId('canvas-view').selectOption('delivery');
    await expect(page.locator('[data-testid="node-p:infraestructura"].cv-group')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('un servicio añadido en un entorno aparece dentro del clúster y se edita como instancia', async ({ page }) => {
    await open(page, 'platform');
    await page.getByTestId('canvas-view').selectOption('env:prod');
    await page.locator('[data-testid="node-k8s-prod"] .cv-group-title').click();
    await page.getByTestId('add-worker').click();
    const instance = page.locator('.react-flow__node', { hasText: 'Worker nuevo' });
    await expect(instance).toBeVisible();
    await instance.click();
    await page.getByTestId('inspector').getByLabel('Réplicas').fill('3');
    await page.getByTestId('inspector').getByLabel('Réplicas').blur();
    expect(await docText(page)).toContain('"replicas": 3');
  });
});

test.describe('lienzo de seguridad', () => {
  test('el DFD dibuja procesos como círculos y almacenes como tubos dentro de zonas de confianza, y el modelo de amenazas usa hexágonos', async ({ page }) => {
    const errors = await open(page, 'security');
    await expect(page.locator('[data-testid="node-interna"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos"][data-shape="circle"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos-db"][data-shape="pipe"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-cliente"][data-shape="actor"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-security-dfd.png' });
    await page.getByTestId('canvas-view').selectOption('threats');
    await expect(page.locator('[data-testid="node-exfiltracion-db"][data-shape="hexagon"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-security-threats.png' });
    expect(errors).toEqual([]);
  });

  test('una amenaza añadida con un activo seleccionado recae sobre él y su categoría STRIDE se elige en las propiedades', async ({ page }) => {
    await open(page, 'security');
    await page.getByTestId('canvas-view').selectOption('threats');
    await page.locator('[data-testid="node-pedidos-db"]').click();
    await page.getByTestId('add-threat').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('Recae sobre')).toHaveValue('pedidos-db');
    await inspector.getByLabel('Categoría STRIDE').selectOption('information-disclosure');
    expect(await docText(page)).toContain('"category": "information-disclosure"');
  });
});
