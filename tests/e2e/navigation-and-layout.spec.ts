import { test, expect } from '@playwright/test';

test('autolayout, direcciones y navegación C1 → C2 → C3', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  // Autolayout en C1: 0 cruces, 0 solapes, dirección ↓ centrada por defecto.
  await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
  await page.waitForTimeout(1200);
  const positions = await page.$$eval('.react-flow__node', (els) => els.map((e) => (e as HTMLElement).style.transform));
  expect(new Set(positions).size, 'autolayout deja posiciones distintas para todos los nodos').toBe(positions.length);
  const qualityText = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(qualityText).toMatch(/0 cruces/);
  expect(qualityText).toMatch(/0 solapes/);
  expect(qualityText).toMatch(/↓/);
  expect(qualityText).toMatch(/centrado/);
  const overlaps = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.c4-edge-label')].map((l) => l.getBoundingClientRect());
    const shapes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect());
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2;
    return labels.filter((l) => shapes.some((s) => hit(l, s))).length;
  });
  expect(overlaps, 'ninguna etiqueta de relación pisa un nodo').toBe(0);

  // Navegación C1 → C2 con doble clic en el sistema.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await page.waitForTimeout(700);
  await expect(page.locator('.c4-boundary')).toHaveCount(1);

  // C2 por defecto: izquierda→derecha (el boundary es más ancho que alto).
  await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
  await page.waitForTimeout(1200);
  const boundaryBox = await page.locator('.c4-boundary').boundingBox();
  expect(boundaryBox).not.toBeNull();
  expect(boundaryBox!.width, `C2 se distribuye izquierda→derecha (${Math.round(boundaryBox!.width)}×${Math.round(boundaryBox!.height)})`).toBeGreaterThan(boundaryBox!.height);
  const q2 = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(q2).toMatch(/→/);
  expect(q2).toMatch(/0 cruces/);

  // Forzar derecha→izquierda desde el desplegable.
  await page.getByRole('button', { name: 'Dirección y distribución del autolayout' }).click();
  await page.getByText('Derecha → izquierda').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  const q3 = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(q3).toMatch(/←/);
  const clienteBox = await page.locator('.react-flow__node', { hasText: 'Cliente personal' }).boundingBox();
  const dbBox = await page.locator('.react-flow__node', { hasText: 'Base de datos' }).boundingBox();
  expect(clienteBox).not.toBeNull();
  expect(dbBox).not.toBeNull();
  expect(clienteBox!.x, 'en derecha→izquierda la persona queda a la derecha del flujo').toBeGreaterThan(dbBox!.x);

  // Volver a la dirección automática.
  await page.getByRole('button', { name: 'Dirección y distribución del autolayout' }).click();
  await page.getByText('Automática (C1 ↓, C2/C3 →)').click();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(1200);
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C2');
  await expect(page.locator('.c4-shape.shape-database')).toHaveCount(1);
  await expect(page.locator('.c4-shape.shape-browser')).toHaveCount(1);

  // Las aristas que salen de un nodo nacen en puntos distintos (rutas del autolayout / puertos virtuales).
  const starts = await page.$$eval('.react-flow__edge path.react-flow__edge-path', (paths) =>
    paths.map((p) => (p.getAttribute('d') ?? '').split('L')[0].trim()),
  );
  expect(new Set(starts).size, `todas las aristas nacen en puntos distintos (${starts.length})`).toBe(starts.length);

  // C2 → C3 con doble clic en la API y vuelta con "Subir nivel".
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await page.waitForTimeout(700);
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C3');
  await page.getByRole('button', { name: 'Subir nivel' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C2');
});
