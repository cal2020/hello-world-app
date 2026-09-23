import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' }
  },
  build: {
    rollupOptions: {
      input: {
        workbench: resolve(import.meta.dirname, 'index.html'),
        greetingCard: resolve(import.meta.dirname, 'greeting-card.html')
      }
    }
  }
})
