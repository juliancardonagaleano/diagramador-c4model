import { test, expect } from '@playwright/test';
import { openEditor } from './canvas-helpers';

test('C1 se dibuja, se puede crear/editar un elemento y deshacer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openEditor(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThanOrEqual(3);

  // Añadir una persona desde la toolbar flotante.
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.c4-card.is-selected')).toHaveCount(1);

  // Editar el nombre desde el panel lateral.
  const nameInput = page.locator('.c4-card.is-selected input').first();
  await nameInput.fill('Auditor');
  await expect(page.locator('.react-flow__node', { hasText: 'Auditor' })).toHaveCount(1);

  // Sacar el foco del input: si no, Ctrl+Z lo interpreta el propio campo de texto en vez de
  // llegar al atajo global de deshacer de la app.
  await nameInput.blur();
  await expect(nameInput).not.toBeFocused();

  // Deshacer el nombre y después la creación => vuelve a 4 nodos.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__node', { hasText: 'Auditor' })).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  // Un Ctrl+Z de más no retrocede al estado «sin posicionar» del autolayout inicial: el historial ya está vacío.
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
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

  await openEditor(page);
  await page.locator('.react-flow__node', { hasText: 'Cliente personal' }).click();

  const nameInput = page.locator('.c4-card.is-selected input').first();
  await expect(nameInput).toHaveValue('Cliente personal');

  // El store borraba la clave `name` (obligatoria) al vaciarse el campo, y el siguiente render
  // lanzaba un TypeError sobre `element.name.trim()`.
  await nameInput.fill('');
  await expect(nameInput).toHaveValue(''); // el campo conserva el borrador vacío mientras el store guarda el último nombre válido
  await expect(page.locator('.c4-canvas')).toBeVisible();
  await nameInput.blur();
  await expect(nameInput).not.toBeFocused();
  // El nombre vacío se ignora: el elemento conserva el último nombre válido, no queda sin nombre.
  await expect(page.locator('.react-flow__node', { hasText: 'Cliente personal' })).toHaveCount(1);

  expect(errors, `sin errores de página (${errors.join(' | ').slice(0, 200)})`).toHaveLength(0);
});
