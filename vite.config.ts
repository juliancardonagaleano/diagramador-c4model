import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Ruta base pública. En GitHub Pages la app se sirve bajo `/<repositorio>/`, así que el
 * workflow de despliegue fija `BASE_PATH=/diagramador-c4model/`; en local y en hostings
 * que sirven en la raíz (Cloudflare Pages, Netlify, Vercel) se deja `/`.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
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
      },
    },
  },
  server: {
    port: 5173,
  },
});
