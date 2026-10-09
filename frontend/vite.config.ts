/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The local API (cost-inspector serve). The dev server proxies /api to it, so the
// browser only ever talks to one origin.
const api = process.env.ACI_API_URL ?? 'http://127.0.0.1:8765'

// The browser build (`vite build --mode browser`) is a static site with no server to send
// security headers, so its Content Security Policy goes in a meta tag. WebAssembly runs in the
// worker, whose script is same-origin; the page itself needs no eval of any kind.
const BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function browserCsp(): Plugin {
  const charset = '<meta charset="UTF-8" />'
  return {
    name: 'browser-csp',
    transformIndexHtml(html) {
      if (!html.includes(charset)) throw new Error('index.html: charset meta not found')
      return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${BROWSER_CSP}" />`)
    },
  }
}

export default defineConfig(({ mode }) => ({
  // Relative URLs let the browser build live in any folder, such as a GitHub Pages subpath.
  base: mode === 'browser' ? './' : '/',
  plugins: [react(), tailwindcss(), ...(mode === 'browser' ? [browserCsp()] : [])],
  // A literal at every use, so the server build drops the in-browser engine entirely.
  define: { __BROWSER_BUILD__: JSON.stringify(mode === 'browser') },
  worker: { format: 'es' as const },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: api } },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: { '/api': { target: api } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Separate, long-cacheable chunks for React and other third-party code.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
}))
