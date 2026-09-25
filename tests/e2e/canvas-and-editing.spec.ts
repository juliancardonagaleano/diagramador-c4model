import { test, expect } from '@playwright/test';

test('C1 se dibuja, se puede crear/editar un elemento y deshacer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThanOrEqual(3);

  // Añadir una persona desde la toolbar flotante.
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.c4-card.is-selected')).toHaveCount(1);

  // Editar el nombre desde el panel lateral.
  const nameInput = page.locator('.c4-card.is-selected input').first();
  await nameInput.fill('Auditor');
  await page.waitForTimeout(200);
  await expect(page.locator('.react-flow__node', { hasText: 'Auditor' })).toHaveCount(1);

  // Sacar el foco del input: si no, Ctrl+Z lo interpreta el propio campo de texto en vez de
  // llegar al atajo global de deshacer de la app.
  await nameInput.blur();
  await page.waitForTimeout(100);

  // Deshacer (nombre y creación) => vuelve a 4 nodos.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  await expect(page.locator('.react-flow__node')).toHaveCount(4);

  // Notación C4 clásica por defecto: formas SVG (persona con cabeza, cilindro…).
  await expect(page.locator('.c4-shape.shape-person')).toHaveCount(1);
  await expect(page.locator('.c4-shape-svg')).toHaveCount(4);
  await expect(page.locator('.c4-breadcrumb [data-level], .c4-breadcrumb').first()).toHaveAttribute('data-level', 'C1');

  expect(errors, `sin errores de página (${errors.join(' | ').slice(0, 200)})`).toHaveLength(0);
});

test('vaciar el campo Nombre no rompe la app (antes crasheaba y dejaba la pantalla en blanco)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  await page.locator('.react-flow__node', { hasText: 'Cliente personal' }).click();
  await page.waitForTimeout(200);

  const nameInput = page.locator('.c4-card.is-selected input').first();
  await expect(nameInput).toHaveValue('Cliente personal');

  // El store borraba la clave `name` (obligatoria) al vaciarse el campo, y el siguiente render
  // lanzaba un TypeError sobre `element.name.trim()`.
  await nameInput.fill('');
  await page.waitForTimeout(200);
  await expect(page.locator('.c4-canvas')).toBeVisible();
  await nameInput.blur();
  await page.waitForTimeout(200);
  // El nombre vacío se ignora: el elemento conserva el último nombre válido, no queda sin nombre.
  await expect(page.locator('.react-flow__node', { hasText: 'Cliente personal' })).toHaveCount(1);

  expect(errors, `sin errores de página (${errors.join(' | ').slice(0, 200)})`).toHaveLength(0);
});
