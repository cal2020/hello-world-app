// HTTP server (node:http, no framework) around the shared route table.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { WorkbenchError } from './util.js'
import { createRouter } from './router.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }

export function createHttpServer(wb, { staticDir = null } = {}) {
  const handle = createRouter(wb)
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(JSON.stringify(body))
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(staticDir, url.pathname, res)
    let body = {}
    if (req.method !== 'GET') {
      try { body = await readJson(req) } catch (err) { return send(err.status ?? 400, err.toJSON ? err.toJSON() : { error: 'BAD_REQUEST' }) }
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const out = await handle({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, token, body })
    send(out.status, out.body, out.headers)
  })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1_000_000) { reject(new WorkbenchError(413, 'TOO_LARGE', 'Request body too large.')); req.destroy() }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new WorkbenchError(400, 'BAD_JSON', 'Body is not valid JSON.')) }
    })
    req.on('error', reject)
  })
}

function serveStatic(dir, pathname, res) {
  if (!dir || !existsSync(dir)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('UI not built. Run `npm run build` (or use `npm run dev` for the Vite dev server).')
  }
  let file = normalize(join(dir, pathname === '/' ? 'index.html' : pathname))
  if (!file.startsWith(normalize(dir))) { res.writeHead(403); return res.end() }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
}
