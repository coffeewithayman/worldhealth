import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dev server proxies to the Hono API so the browser sees one origin.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
