import { expect, test, type Page } from '@playwright/test';

const TIENDA_DSL = `
workspace "Mi tienda" "Tienda en línea de ejemplo." {
  model {
    cliente = person "Cliente" "Compra en la tienda."
    tienda = softwareSystem "Tienda en línea" "Vende productos." {
      web = container "Aplicación web" "Interfaz de compra." "React"
      api = container "API" "Lógica de negocio." "Node.js"
      db = container "Base de datos" "Pedidos." "PostgreSQL" "Database"
    }
    pasarela = softwareSystem "Pasarela de pagos" "Cobra los pedidos." "External"
    cliente -> web "Compra" "HTTPS"
    web -> api "Llama" "JSON/HTTPS"
    api -> db "Lee y escribe" "SQL"
    api -> pasarela "Cobra con" "HTTPS"
  }
  views {
    systemContext tienda "contexto" {
      include *
      autoLayout
    }
    container tienda "contenedores" {
      include *
      autoLayout lr
    }
    styles {
      element "Database" {
        shape cylinder
      }
    }
  }
}
`;

async function importDsl(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByText('Archivo', { exact: true }).click();
      await page.getByText('Importar Structurizr DSL…').click();
    })(),
  ]);
  await chooser.setFiles(file);
}

const dslFile = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

test('Archivo ▸ Importar Structurizr DSL carga el modelo y las vistas se colocan solas al abrirlas', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  await importDsl(page, dslFile('tienda.dsl', TIENDA_DSL));

  await expect(page.getByText('"tienda.dsl" importado: 6 elementos, 4 relaciones, 2 vistas')).toBeVisible();
  // El nombre del workspace manda sobre el del archivo, y lo importado aún no está guardado como JSON.
  await expect(page.locator('header')).toContainText('Mi tienda');
  await expect(page.locator('header')).toContainText('Cambios sin guardar');

  // Vista de contexto: el DSL no trae coordenadas y aun así todos los nodos se dibujan, cada uno en su sitio.
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3);
  for (const name of ['Cliente', 'Tienda en línea', 'Pasarela de pagos']) await expect(nodes.filter({ hasText: name })).toBeVisible();
  const boxes = await nodes.evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform));
  expect(new Set(boxes).size).toBe(3);

  // Bajar a los contenedores: se colocan con el autolayout y la base de datos conserva su forma de cilindro.
  await nodes.filter({ hasText: 'Tienda en línea' }).dblclick();
  await expect(nodes.filter({ hasText: 'Aplicación web' })).toBeVisible();
  await expect(nodes.filter({ hasText: 'Base de datos' })).toBeVisible();
  await expect(nodes.filter({ hasText: 'API' })).toBeVisible();
  await expect(page.locator('.c4-shape-svg').first()).toBeVisible();
});

test('el ejemplo examples/banca.dsl se importa completo y se navega C1 → C2 → C3', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  await importDsl(page, 'examples/banca.dsl');
  await expect(page.getByText(/"banca.dsl" importado: 13 elementos, 19 relaciones, 3 vistas/)).toBeVisible();
  await expect(page.locator('header')).toContainText('Cambios sin guardar'); // el ejemplo cargado por defecto no lo estaba
  await expect(page.locator('.react-flow__node')).toHaveCount(4);

  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await expect(page.locator('.react-flow__node', { hasText: 'Aplicación API' })).toBeVisible();
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await expect(page.locator('.react-flow__node', { hasText: 'Controlador de cuentas' })).toBeVisible();
});

test('lo que no se puede importar del DSL se lista en un aviso (y el resto se importa)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');

  const dsl = `workspace "Avisos" {
  model {
    s = softwareSystem "Sistema"
    live = deploymentEnvironment "Live" {
    }
  }
  views {
    systemContext s "c" {
      include *
    }
    dynamic s "d" {
    }
  }
}`;
  await importDsl(page, dslFile('avisos.dsl', dsl));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Importado con 2 aviso(s)');
  await expect(dialog).toContainText('despliegue (deploymentEnvironment');
  await expect(dialog).toContainText('vista dynamic');
  await dialog.locator('button', { hasText: 'Entendido' }).click();
  await expect(page.locator('.react-flow__node', { hasText: 'Sistema' })).toBeVisible();
});

test('un DSL inválido muestra el motivo con su línea y no toca el diagrama actual', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const before = await page.locator('.react-flow__node').count();

  await importDsl(page, dslFile('roto.dsl', 'workspace "x" {\n  model {\n    s = softwareSystem "sin cerrar\n  }\n}\n'));

  await expect(page.getByText(/No se pudo importar "roto.dsl": línea 3: cadena sin cerrar/)).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(before);
  await expect(page.locator('header')).not.toContainText('Cambios sin guardar');
});

test('con cambios sin guardar, importar un DSL pide confirmación antes de abrir el selector', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await page.waitForTimeout(300);

  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Importar Structurizr DSL…').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/sin guardar/i);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.locator('button', { hasText: 'Continuar' }).click()]);
  await chooser.setFiles(dslFile('tienda.dsl', TIENDA_DSL));
  await expect(page.getByText(/"tienda.dsl" importado/)).toBeVisible();
});
