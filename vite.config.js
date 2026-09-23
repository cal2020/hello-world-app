import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the build works from any subpath (e.g. GitHub Pages).
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173
  }
})
