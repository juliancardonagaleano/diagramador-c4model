import { test, expect } from '@playwright/test';

test('el documento persiste en localStorage tras recargar', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  await page.getByRole('tab', { name: /Elementos/ }).click();
  await page.getByRole('button', { name: 'Añadir sistema de software' }).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const tabText = (await page.getByRole('tab', { name: /Elementos/ }).textContent()) ?? '';
  expect(tabText, `el documento persiste en localStorage tras recargar (${tabText})`).toMatch(/Elementos \(14\)/);
});
