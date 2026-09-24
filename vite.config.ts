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
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@embed': fileURLToPath(new URL('./src/embed', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'embed-host': fileURLToPath(new URL('./examples/embed-host.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
  },
});
