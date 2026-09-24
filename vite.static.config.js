// Browser-only demo build: the workbench server code runs in the page.
// `npm run build:static` -> dist-static/, then scripts/build-artifact.js
// inlines it into a single page (artifact/index.html).
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const here = import.meta.dirname
const shim = (f) => resolve(here, 'src/static', f)
let rev = 'unknown'
try { rev = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* not a git checkout */ }

export default defineConfig({
  base: './',
  define: { 'process.env': '{}', __BUILD_REV__: JSON.stringify(rev + ' (browser build)') },
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: shim('sqlite-shim.js') },
      { find: /^node:crypto$/, replacement: shim('crypto-shim.js') },
      { find: /^(node:)?(fs|path|url|child_process)$/, replacement: shim('node-shims.js') },
      { find: /^@anthropic-ai\/sdk$/, replacement: shim('anthropic-stub.js') }
    ]
  },
  plugins: [{
    name: 'browser-fixtures',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/(^|\/)fixtures\.js$/.test(source) && importer && /\/(server|scripts)\//.test(importer)) return shim('fixtures-browser.js')
      return null
    }
  }],
  build: {
    outDir: 'dist-static',
    target: 'es2022',
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(here, 'static.html'), output: { inlineDynamicImports: true } }
  }
})
