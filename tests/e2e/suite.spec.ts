import { expect, test } from '@playwright/test';

test.describe('shell de la suite (federación por manifiesto)', () => {
  test('descubre los módulos del manifiesto, monta el que se elige y muestra sus capacidades', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/suite.html', { waitUntil: 'networkidle' });
    await expect(page.getByRole('status')).toContainText('6 módulos');
    const nav = page.getByRole('navigation', { name: 'Módulos' });
    await expect(nav.getByRole('button')).toHaveCount(6);
    await expect(nav.getByRole('button', { name: /Arquitectura de seguridad/ })).toBeVisible();

    // abre el primer módulo que no es C4 y el banco de trabajo se incrusta con el protocolo de módulos
    const frameFor = (fragment: string) => page.frames().find((f) => f.url().includes(fragment));
    await expect.poll(() => frameFor('module=integration')?.url()).toContain('embed=1');
    await expect(page.locator('#info')).toContainText('Arquitectura de integraciones');
    await expect(page.locator('#info')).toContainText('Informes'); // llega con el handshake capabilities
    await expect(page.locator('#log')).toContainText('init');

    await nav.getByRole('button', { name: /Arquitectura de seguridad/ }).click();
    await expect.poll(() => frameFor('module=security')?.url()).toBeTruthy();
    await expect(page.locator('#info')).toContainText('Conversiones');
    await expect(page.locator('#info')).toContainText('from-integration');
    expect(await page.locator('iframe').count()).toBe(1);

    // C4 habla su propio protocolo: se monta el editor, sin parámetro de módulo
    await nav.getByRole('button', { name: /Arquitectura de soluciones \(C4\)/ }).click();
    await expect.poll(() => page.frames().some((f) => f.url().includes('embed=1') && !f.url().includes('module='))).toBe(true);
    const c4 = page.frames().find((f) => f.url().includes('embed=1') && !f.url().includes('module='))!;
    await c4.waitForSelector('.react-flow', { timeout: 20000 });
    expect(errors).toEqual([]);
  });

  test('una instancia distinta: solo aparece lo que su manifiesto declara', async ({ page }) => {
    await page.route('**/otra/.well-known/iark.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schema: 'iark.manifest/1',
          name: 'Instancia de datos',
          version: '9.9.9',
          modules: [{ id: 'data', name: 'Solo datos', version: '1.0.0', documentVersion: '1.0', importFormats: ['mermaid'], exportFormats: ['svg'], endpoints: { embed: '../../modulos.html?module=data' } }],
        }),
      }),
    );
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/otra/.well-known/iark.json'), { waitUntil: 'networkidle' });
    await expect(page.getByRole('status')).toContainText('Instancia de datos v9.9.9 · 1 módulos');
    await expect(page.getByRole('navigation', { name: 'Módulos' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=data'))).toBe(true);
  });

  test('un manifiesto que no existe o no es válido se explica sin romper la página', async ({ page }) => {
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/no-existe.json'), { waitUntil: 'networkidle' });
    await expect(page.getByRole('alert')).toContainText('respondió 404');
    await page.route('**/roto.json', (route) => route.fulfill({ contentType: 'application/json', body: '{"schema":"otro"}' }));
    await page.getByLabel('Manifiesto de la instancia').fill('/roto.json');
    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('alert')).toContainText('no es un iark.manifest/1 válido');
    await expect(page.getByRole('status')).toContainText('sin conexión');
  });

  test('el sitio publica el manifiesto y los JSON Schema anunciados', async ({ request }) => {
    const manifest = await (await request.get('/.well-known/iark.json')).json();
    expect(manifest.schema).toBe('iark.manifest/1');
    for (const m of manifest.modules) {
      const schema = await request.get(`/${m.endpoints.schema.replace('../', '')}`);
      expect(schema.ok(), m.endpoints.schema).toBe(true);
      expect((await schema.json()).$id).toContain(`${m.id}-document.schema.json`);
    }
  });
});
