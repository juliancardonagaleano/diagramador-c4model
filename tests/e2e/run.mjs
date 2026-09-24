/**
 * Pruebas de extremo a extremo con Playwright (Chromium preinstalado o el de playwright-core).
 * Requiere `npm run build` previo; sirve dist/app con `vite preview`.
 *   node tests/e2e/run.mjs [--screenshots dir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const shotsDir = process.argv.includes('--screenshots') ? process.argv[process.argv.indexOf('--screenshots') + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const waitFor = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Servidor no disponible en ${url}`);
};

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

try {
  await waitFor(`${BASE}/`);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ── App principal ──
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const nodesBefore = await page.locator('.react-flow__node').count();
  check(nodesBefore === 4, `la vista de contexto del ejemplo dibuja 4 nodos (${nodesBefore})`);
  check((await page.locator('.react-flow__edge').count()) >= 3, 'se dibujan las relaciones');
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/01-contexto.png` });

  // Añadir una persona desde la toolbar flotante.
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await page.waitForTimeout(300);
  check((await page.locator('.react-flow__node').count()) === 5, 'añadir persona crea un nodo nuevo');
  check((await page.locator('.c4-card.is-selected').count()) === 1, 'el nuevo elemento queda seleccionado en el panel');

  // Editar el nombre desde el panel lateral.
  const nameInput = page.locator('.c4-card.is-selected input').first();
  await nameInput.fill('Auditor');
  await page.waitForTimeout(200);
  check((await page.locator('.react-flow__node', { hasText: 'Auditor' }).count()) === 1, 'editar el nombre se refleja en el lienzo');

  // Autolayout.
  await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
  await page.waitForTimeout(800);
  const positions = await page.$$eval('.react-flow__node', (els) => els.map((e) => e.style.transform));
  check(new Set(positions).size === positions.length, 'autolayout deja posiciones distintas para todos los nodos');
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/02-autolayout.png` });

  // Deshacer dos veces (nombre y creación) => vuelve a 4 nodos.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check((await page.locator('.react-flow__node').count()) === 4, 'deshacer revierte la creación del elemento');

  // Notación C4 clásica por defecto: formas SVG (persona con cabeza, cilindro…).
  check((await page.locator('.c4-shape.shape-person').count()) === 1, 'la persona se dibuja con la forma C4 (cabeza + cuerpo)');
  check((await page.locator('.c4-shape-svg').count()) === 4, 'todos los nodos usan la notación C4 clásica');
  check((await page.locator('.c4-breadcrumb [data-level], .c4-breadcrumb').first().getAttribute('data-level')) === 'C1', 'el breadcrumb muestra el nivel C1');

  // Navegación C1 → C2 con doble clic en el sistema.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await page.waitForTimeout(700);
  check((await page.locator('.c4-boundary').count()) === 1, 'doble clic en el sistema abre la vista de contenedores (boundary visible)');
  check((await page.locator('.c4-breadcrumb').getAttribute('data-level')) === 'C2', 'el breadcrumb muestra C2 tras bajar de nivel');
  check((await page.locator('.c4-shape.shape-database').count()) === 1, 'la base de datos se dibuja como cilindro');
  check((await page.locator('.c4-shape.shape-browser').count()) === 1, 'la app web se dibuja como navegador');
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/03-contenedores.png` });

  // C2 → C3 con doble clic en la API y vuelta con "Subir nivel".
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await page.waitForTimeout(700);
  check((await page.locator('.c4-breadcrumb').getAttribute('data-level')) === 'C3', 'doble clic en el contenedor abre la vista de componentes (C3)');
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/03b-componentes.png` });
  await page.getByRole('button', { name: 'Subir nivel' }).click();
  await page.waitForTimeout(500);
  check((await page.locator('.c4-breadcrumb').getAttribute('data-level')) === 'C2', '"Subir nivel" vuelve a C2');

  // Conmutar a tarjetas estilo drawdb desde el menú Ver.
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Tarjetas (estilo drawdb)').click();
  await page.waitForTimeout(300);
  check((await page.locator('.c4-node').count()) > 0 && (await page.locator('.c4-shape-svg').count()) === 0, 'el menú Ver cambia a la notación de tarjetas');
  await page.getByText('Ver', { exact: true }).click();
  await page.getByText('Notación C4 clásica').click();
  await page.waitForTimeout(300);
  check((await page.locator('.c4-shape-svg').count()) > 0, 'y vuelve a la notación C4 clásica');

  // Exportar .drawio (descarga).
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
  const xml = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  check(xml.startsWith('<mxfile'), 'la exportación produce un mxfile');
  check((xml.match(/<diagram /g) || []).length === 3, 'una página por vista');
  check(xml.includes('mxgraph.c4.person2'), 'usa las formas C4 de draw.io');

  // Persistencia tras recargar.
  await page.getByRole('tab', { name: /Elementos/ }).click();
  await page.getByRole('button', { name: 'Añadir sistema de software' }).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.react-flow__node');
  const tabText = await page.getByRole('tab', { name: /Elementos/ }).textContent();
  check(/Elementos \(14\)/.test(tabText ?? ''), `el documento persiste en localStorage tras recargar (${tabText})`);

  // Tema oscuro.
  await page.getByRole('button', { name: 'Tema oscuro' }).click();
  check((await page.evaluate(() => document.body.getAttribute('theme-mode'))) === 'dark', 'el tema oscuro se aplica');
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/04-oscuro.png` });

  // ── Modo embebido ──
  const host = await context.newPage();
  const hostErrors = [];
  host.on('pageerror', (e) => hostErrors.push(e.message));
  await host.goto(`${BASE}/examples/embed-host.html`, { waitUntil: 'networkidle' });
  await host.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });
  check(true, 'handshake init → load → evento load completado');
  const frame = host.frames().find((f) => f.url().includes('embed=1'));
  check(!!frame, 'el iframe se abrió con ?embed=1');
  await frame.waitForSelector('.react-flow__node');
  check((await frame.locator('.react-flow__node').count()) === 3, 'el documento del anfitrión (sin coordenadas) se dibujó con autolayout');
  check((await frame.getByRole('button', { name: 'Guardar y salir' }).count()) === 1, 'la cabecera embebida muestra "Guardar y salir"');

  const xmlLen = await host.evaluate(async () => (await window.embed.export('drawio')).length);
  check(xmlLen > 500, 'action export devuelve el .drawio al anfitrión');

  // setView desde el anfitrión → evento viewChange.
  await host.evaluate(() => window.embed.setView('cont'));
  await host.waitForTimeout(500);
  check(/viewChange.*"level":"C2"/.test((await host.locator('#log').textContent()) ?? ''), 'setView emite viewChange con el nivel C2');

  await host.click('#btn-merge');
  await host.waitForTimeout(800);
  const logText = await host.locator('#log').textContent();
  check(/autosave/.test(logText ?? ''), 'los cambios emiten autosave al anfitrión');

  await frame.getByRole('button', { name: 'Guardar y salir' }).click();
  await host.waitForFunction(() => document.getElementById('state')?.textContent === 'salió');
  const logAfter = await host.locator('#log').textContent();
  check(/save.*"exit":true/.test(logAfter ?? '') && /exit/.test(logAfter ?? ''), 'Guardar y salir emite save + exit');
  if (shotsDir) await host.screenshot({ path: `${shotsDir}/05-embebido.png` });

  // Mensaje desde un origen no permitido: se ignora.
  const ignored = await host.evaluate(() => {
    return new Promise((resolve) => {
      const iframe = document.querySelector('iframe');
      let got = false;
      const l = (e) => { if (e.source === iframe.contentWindow) got = true; };
      window.addEventListener('message', l);
      // Simulamos un mensaje "ajeno" abriendo la app con origin=https://otro.example
      const rogue = document.createElement('iframe');
      rogue.src = iframe.src.replace(/origin=[^&]+/, 'origin=' + encodeURIComponent('https://otro.example'));
      rogue.style.display = 'none';
      document.body.appendChild(rogue);
      setTimeout(() => {
        rogue.contentWindow.postMessage(JSON.stringify({ action: 'setView', viewId: 'ctx' }), '*');
        setTimeout(() => { window.removeEventListener('message', l); resolve(!got); }, 800);
      }, 2500);
    });
  });
  check(ignored, 'la app ignora acciones de un origen no autorizado (no responde con error ni eventos)');

  check(errors.length === 0, `sin errores de página en la app (${errors.join(' | ').slice(0, 200)})`);
  check(hostErrors.length === 0, `sin errores de página en el anfitrión (${hostErrors.join(' | ').slice(0, 200)})`);
  await browser.close();
} catch (error) {
  console.error('✗ error en e2e:', error);
  failures++;
} finally {
  server.kill();
}
console.log(failures === 0 ? '\nE2E OK' : `\nE2E con ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
