import { test, expect } from '@playwright/test';

test('protocolo embebido: handshake, export, setView, autosave, guardar y salir, origen no autorizado', async ({ page }) => {
  const hostErrors: string[] = [];
  page.on('pageerror', (e) => hostErrors.push(e.message));
  // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
  await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });

  const frame = page.frames().find((f) => f.url().includes('embed=1'));
  expect(frame, 'el iframe se abrió con ?embed=1').toBeTruthy();
  await frame!.waitForSelector('.react-flow__node');
  await expect(frame!.locator('.react-flow__node')).toHaveCount(3);
  await expect(frame!.getByRole('button', { name: 'Guardar y salir' })).toHaveCount(1);

  const xmlLen = await page.evaluate(async () => (await (window as any).embed.export('drawio')).length);
  expect(xmlLen).toBeGreaterThan(500);

  // SVG y PNG de la vista activa: el SVG lleva las figuras C4 (persona como actor) y el PNG es una imagen con píxeles.
  const svg = await page.evaluate(async () => (await (window as any).embed.export('svg')) as string);
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('PERSONA');
  const png = await page.evaluate(async () => (await (window as any).embed.export('png')) as string);
  expect(png.startsWith('data:image/png;base64,')).toBe(true);
  expect(png.length).toBeGreaterThan(2000);

  // setView desde el anfitrión → evento viewChange.
  await page.evaluate(() => (window as any).embed.setView('cont'));
  await page.waitForTimeout(500);
  expect((await page.locator('#log').textContent()) ?? '').toMatch(/viewChange.*"level":"C2"/);

  await page.click('#btn-merge');
  await page.waitForTimeout(800);
  expect((await page.locator('#log').textContent()) ?? '').toMatch(/autosave/);

  await frame!.getByRole('button', { name: 'Guardar y salir' }).click();
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'salió');
  const logAfter = (await page.locator('#log').textContent()) ?? '';
  expect(logAfter).toMatch(/save.*"exit":true/);
  expect(logAfter).toMatch(/exit/);

  // Mensaje desde un origen no permitido: se ignora.
  const ignored = await page.evaluate(() => {
    return new Promise((resolve) => {
      const iframe = document.querySelector('iframe')!;
      let got = false;
      const l = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow) got = true;
      };
      window.addEventListener('message', l);
      const rogue = document.createElement('iframe');
      rogue.src = iframe.src.replace(/origin=[^&]+/, 'origin=' + encodeURIComponent('https://otro.example'));
      rogue.style.display = 'none';
      document.body.appendChild(rogue);
      setTimeout(() => {
        rogue.contentWindow!.postMessage(JSON.stringify({ action: 'setView', viewId: 'ctx' }), '*');
        setTimeout(() => {
          window.removeEventListener('message', l);
          resolve(!got);
        }, 800);
      }, 2500);
    });
  });
  expect(ignored, 'la app ignora acciones de un origen no autorizado (no responde con error ni eventos)').toBe(true);

  expect(hostErrors, `sin errores de página en el anfitrión (${hostErrors.join(' | ').slice(0, 200)})`).toHaveLength(0);
});

test('un mensaje del anfitrión con JSON roto produce un evento de error, no un silencio', async ({ page }) => {
  // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
  await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });

  await page.evaluate(() => {
    const iframe = document.querySelector('iframe')!;
    // JSON con la forma que espera el protocolo (empieza por "{") pero sintácticamente inválido:
    // antes del fix se descartaba en silencio porque el anfitrión envía JSON como string.
    iframe.contentWindow!.postMessage('{"action": "export", "format":', '*');
  });
  await page.waitForTimeout(500);
  expect((await page.locator('#log').textContent()) ?? '').toMatch(/error/);
});
