import { expect, test, type Page } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';

const MMD = `flowchart LR
  subgraph Tienda["Tienda en línea"]
    web["Aplicación web"]
    db[("Base de datos")]
  end
  cli["Cliente"] -->|HTTPS| Tienda
  web -->|SQL| db
`;

async function importMermaid(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByText('Archivo', { exact: true }).click();
      await page.getByText('Importar Mermaid…').click();
    })(),
  ]);
  await chooser.setFiles(file);
}

test('Archivo ▸ Importar Mermaid carga el diagrama y se dibuja', async ({ page }) => {
  await openEditor(page);

  await importMermaid(page, { name: 'tienda.mmd', mimeType: 'text/plain', buffer: Buffer.from(MMD) });

  await expect(page.getByText('"tienda.mmd" importado: 4 elementos, 2 relaciones')).toBeVisible();
  await expect(page.locator('header')).toContainText('tienda');
  await expect(page.locator('header')).toContainText('Cambios sin guardar');
  await c4Ready(page); // lo importado no trae coordenadas: se dibuja cuando ELK lo ha colocado
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Cliente' })).toBeVisible();
});

test('un Mermaid no soportado muestra el motivo sin tocar el diagrama', async ({ page }) => {
  await openEditor(page);
  const before = await page.locator('.react-flow__node').count();

  await importMermaid(page, { name: 'tarta.mmd', mimeType: 'text/plain', buffer: Buffer.from('pie title x\n "a": 1') });

  await expect(page.getByText(/No se pudo importar "tarta.mmd": No se reconoce el tipo de diagrama/)).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBe(before);
});

test('Archivo ▸ Exportar Mermaid descarga un .mmd con la vista activa', async ({ page }) => {
  await openEditor(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByText('Archivo', { exact: true }).click();
      await page.getByText('Exportar Mermaid (.mmd)', { exact: true }).click();
    })(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mmd$/);
  const text = await (await import('node:fs')).promises.readFile((await download.path())!, 'utf8');
  expect(text).toMatch(/^C4(Context|Container|Component)/);
  expect(text).toContain('Rel(');
});
