import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.SWITCHYARD_PORT ?? '4780'}`;

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  // No data: URIs: the server's CSP allows fonts and images from 'self' only.
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
