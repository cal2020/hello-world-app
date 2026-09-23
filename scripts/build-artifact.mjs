// Bundles the app into one self-contained HTML page (inline CSS + JS) for
// hosting as a single file. Output: dist-artifact/evidence-link-bench.html
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  outdir: 'dist-artifact',
  target: 'es2020',
})

const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text
const css = result.outputFiles.find((f) => f.path.endsWith('.css')).text

const html = `<title>Evidence Link Bench</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>
<div id="app"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
`

await mkdir('dist-artifact', { recursive: true })
await writeFile('dist-artifact/evidence-link-bench.html', html)
console.log(`dist-artifact/evidence-link-bench.html (${(html.length / 1024).toFixed(1)} KiB)`)
