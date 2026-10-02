import { test, expect } from '@playwright/test';
import { openEditor, reloadEditor } from './canvas-helpers';

test('el documento persiste en localStorage tras recargar', async ({ page }) => {
  await openEditor(page);

  await page.getByRole('tab', { name: /Elementos/ }).click();
  await page.getByRole('button', { name: 'Añadir sistema de software' }).click();
  // Se recarga cuando el almacén ya ha escrito el documento en localStorage (el ejemplo trae 13 elementos).
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('iark-diagrams') ?? '{}').state?.doc?.model?.elements?.length))
    .toBe(14);
  await reloadEditor(page);
  const tabText = (await page.getByRole('tab', { name: /Elementos/ }).textContent()) ?? '';
  expect(tabText, `el documento persiste en localStorage tras recargar (${tabText})`).toMatch(/Elementos \(14\)/);
});
