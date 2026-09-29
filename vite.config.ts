import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Ruta base pública. En GitHub Pages la app se sirve bajo `/<repositorio>/`, así que
 * `npm run deploy:pages` fija `BASE_PATH=/<repositorio>/` (p. ej. `/iark-diagrams/`); en local y en hostings
 * que sirven en la raíz (Cloudflare Pages, Netlify, Vercel) se deja `/`.
 */
const base = process.env.BASE_PATH ?? '/';

/**
 * Publica los JSON Schema de los módulos (`schema/`) junto al sitio: el manifiesto de federación
 * (`/.well-known/iark.json`) los anuncia como `endpoints.schema` y sirven de `$schema` para editores y agentes.
 */
function publishSchemas(): Plugin {
  let outDir = 'dist/app';
  return {
    name: 'iark-publish-schemas',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (existsSync('schema')) cpSync('schema', resolve(outDir, 'schema'), { recursive: true });
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), publishSchemas()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./packages/domain-c4/src', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@embed': fileURLToPath(new URL('./src/embed', import.meta.url)),
    },
  },
  build: {
    // OUT_DIR permite compilar a otra carpeta (p. ej. el despliegue a Pages) sin pisar el dist/app que usan preview y E2E.
    outDir: process.env.OUT_DIR ?? 'dist/app',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'embed-host': fileURLToPath(new URL('./examples/embed-host.html', import.meta.url)),
        modulos: fileURLToPath(new URL('./modulos.html', import.meta.url)),
        'modules-host': fileURLToPath(new URL('./examples/modules-host.html', import.meta.url)),
        'web-component-host': fileURLToPath(new URL('./examples/web-component-host.html', import.meta.url)),
        suite: fileURLToPath(new URL('./suite.html', import.meta.url)),
        trazabilidad: fileURLToPath(new URL('./trazabilidad.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
  },
});
