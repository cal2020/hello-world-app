// Inlines the browser-only build (dist-static/) into one page fragment,
// artifact/index.html, suitable for single-file hosting.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'dist-static', 'assets')
const files = readdirSync(assets)
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
const jsFiles = files.filter((f) => f.endsWith('.js'))
if (jsFiles.length !== 1) throw new Error(`Expected one JS bundle, found ${jsFiles.length}`)
const js = readFileSync(join(assets, jsFiles[0]), 'utf8').replace(/<\/script/gi, '<\\/script')
const page = `<title>Procedure Evidence Workbench</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>
<div id="app"><div style="padding:24px 16px;font-family:system-ui,sans-serif">Loading the workbench. It runs entirely in your browser…</div></div>
<script type="module">${js}</script>
`
mkdirSync(join(root, 'artifact'), { recursive: true })
writeFileSync(join(root, 'artifact', 'index.html'), page)
console.log(`artifact/index.html: ${(page.length / 1024).toFixed(0)} KB`)
