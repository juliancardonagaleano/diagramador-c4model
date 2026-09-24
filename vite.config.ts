import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
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
