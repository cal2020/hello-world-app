import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * BASE_PATH lets the atlas be deployed below a sub-path (for example
 * GitHub Pages project sites: BASE_PATH=/my-repo/). It must start and end
 * with "/". The prerender script reads the same variable.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // The 3D viewer chunk (three.js, React Three Fiber, post-processing) is ~1.1 MB
    // (~0.3 MB gzipped) and loads only after the page is interactive.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
