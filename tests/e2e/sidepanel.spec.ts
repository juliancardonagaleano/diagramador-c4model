import { test, expect } from '@playwright/test';

test('cambiar el tipo de un elemento a uno cuyo padre actual ya no es válido limpia el padre', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  // "Aplicación API" es un container con padre "Sistema de banca en línea" (softwareSystem); al
  // bajar a C2 y pasarlo a "Componente" (que exige un padre container), ese padre ya no es válido.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await page.waitForTimeout(500);
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).click();
  await page.waitForTimeout(200);

  const tipoField = page.locator('.c4-field', { has: page.locator('label', { hasText: 'Tipo' }) });
  await tipoField.getByRole('combobox').click();
  await page.getByRole('listbox').last().getByText('Componente', { exact: true }).click();
  await page.waitForTimeout(200);

  const parentField = page.locator('.c4-field', { has: page.locator('label', { hasText: 'Pertenece a' }) });
  await expect(parentField.locator('.semi-select-selection-text')).toHaveText('Elige contenedor');
});

test('no se pueden crear relaciones duplicadas ni auto-referenciadas desde el panel', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  await page.getByRole('tab', { name: /Relaciones/ }).click();
  const before = await page.locator('[data-relationship-id]').count();

  const addButton = page.getByRole('button', { name: 'Añadir relación' });
  // Semi UI no usa el atributo `placeholder` real (lo renderiza como texto dentro del propio
  // combobox), así que se localizan por posición: el primero es "Origen", el segundo "Destino".
  const origen = page.getByRole('combobox').nth(0);
  const destino = page.getByRole('combobox').nth(1);

  // Origen = destino: queda deshabilitado.
  await origen.click();
  await page.getByRole('listbox').last().getByText('Cliente personal', { exact: true }).click();
  await destino.click();
  await page.getByRole('listbox').last().getByText('Cliente personal', { exact: true }).click();
  await expect(addButton).toBeDisabled();
  await expect(page.getByText('Origen y destino no pueden ser el mismo elemento.')).toBeVisible();

  // Un par que ya tiene relación (Cliente personal → Sistema de banca en línea, r1 del ejemplo)
  // también queda deshabilitado.
  await destino.click();
  await page.getByRole('listbox').last().getByText('Sistema de banca en línea', { exact: true }).click();
  await expect(addButton).toBeDisabled();
  await expect(page.getByText('Ya existe una relación entre estos dos elementos.')).toBeVisible();
  expect(await page.locator('[data-relationship-id]').count()).toBe(before);

  // Un par nuevo sí se puede crear.
  await destino.click();
  await page.getByRole('listbox').last().getByText('Sistema de correo', { exact: true }).click();
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await page.waitForTimeout(200);
  expect(await page.locator('[data-relationship-id]').count()).toBe(before + 1);
});
