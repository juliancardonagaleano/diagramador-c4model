import { defineConfig } from '@playwright/test';

/**
 * Pruebas de extremo a extremo. Usa el Chromium preinstalado del entorno (o
 * `CHROMIUM_PATH` si se indica) en vez de descargar uno propio.
 * Requiere `npm run build:app` previo; sirve `dist/app` con `vite preview`.
 */
const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
