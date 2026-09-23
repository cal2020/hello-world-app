// HTTP routing (node:http, no framework). Every mutating route requires an
// opId in the body and a demo identity in the Authorization header.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { WorkbenchError } from './util.js'
import { requirePermission } from './ops.js'
import { listInbox, loadInbox } from './fixtures.js'
import { runEvaluation, latestEvaluation } from './evaluation.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }

export function createHttpServer(wb, { staticDir = null } = {}) {
  const routes = []
  const route = (method, pattern, handler) => {
    const keys = []
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '$')
    routes.push({ method, re, keys, handler })
  }

  route('GET', '/api/health', () => ({ body: { ok: true } }))
  route('GET', '/api/overview', () => ({ body: wb.overview() }))
  route('GET', '/api/users', () => ({ body: wb.users() }))
  route('GET', '/api/me', ({ user }) => ({ body: user }))
  route('GET', '/api/sources', () => ({ body: wb.listSources() }))
  route('GET', '/api/sources/:snapshotId', ({ params }) => ({ body: wb.getSource(params.snapshotId) }))
  route('POST', '/api/sources', ({ user, body }) => wb.importSource(user, body))
  route('GET', '/api/inbox', () => ({ body: listInbox().map(({ source, ...i }) => ({ ...i, sourceId: source.sourceId, revision: source.revision, accessLabel: source.accessLabel, imported: Boolean(wb.db.prepare('SELECT 1 FROM source_snapshots WHERE snapshot_id = ?').get(i.snapshotId)) })) }))
  route('POST', '/api/inbox/:name/import', ({ user, body, params }) => {
    let source
    try { source = loadInbox(params.name) } catch { throw new WorkbenchError(404, 'NOT_FOUND', `No inbox item ${params.name}.`) }
    return wb.importSource(user, { opId: body.opId, source })
  })
  route('POST', '/api/runs', ({ user, body }) => wb.startRun(user, body))
  route('GET', '/api/runs', () => ({ body: wb.listRuns() }))
  route('GET', '/api/runs/:runId', ({ params }) => ({ body: wb.getRun(params.runId) }))
  route('GET', '/api/candidates/:candidateId', ({ params }) => ({ body: wb.getCandidate(params.candidateId) }))
  route('GET', '/api/versions/:versionId', ({ params }) => ({ body: wb.getVersion(params.versionId) }))
  route('GET', '/api/versions/:versionId/impact', ({ params }) => ({ body: wb.impact(params.versionId) }))
  route('GET', '/api/versions/:a/diff/:b', ({ params }) => ({ body: wb.diff(params.a, params.b) }))
  route('POST', '/api/versions/:versionId/edit', ({ user, body, params }) => wb.editVersion(user, params.versionId, body))
  route('POST', '/api/versions/:versionId/judgments', ({ user, body, params }) => wb.judge(user, params.versionId, body))
  route('POST', '/api/versions/:versionId/decisions', ({ user, body, params }) => wb.decide(user, params.versionId, body))
  route('POST', '/api/versions/:versionId/export', ({ user, body, params }) => wb.exportVersion(user, params.versionId, body))
  route('POST', '/api/decisions/:decisionId/revoke', ({ user, body, params }) => wb.revoke(user, params.decisionId, body))
  route('GET', '/api/events', ({ query }) => ({ body: wb.events({ subject: query.get('subject') || null }) }))
  route('GET', '/api/audit/verify', () => ({ body: wb.verifyAudit() }))
  route('GET', '/api/evaluations/latest', () => ({ body: latestEvaluation(wb.db) }))
  route('POST', '/api/evaluations', async ({ user }) => {
    requirePermission(user, 'evaluate')
    return { status: 201, body: await runEvaluation(wb.db) }
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(JSON.stringify(body))
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(staticDir, url.pathname, res)
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname))
    if (!r) return send(404, { error: 'NOT_FOUND', message: `${req.method} ${url.pathname}` })
    try {
      const m = url.pathname.match(r.re)
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const user = wb.userForToken(token)
      if (req.method !== 'GET' && !user) throw new WorkbenchError(401, 'UNAUTHENTICATED', 'Select a demo identity.')
      const body = req.method === 'GET' ? {} : await readJson(req)
      const out = await r.handler({ user, body, params, query: url.searchParams })
      send(out.status ?? 200, out.body, out.replayed ? { 'x-replayed': 'true' } : {})
    } catch (err) {
      if (err instanceof WorkbenchError) return send(err.status, err.toJSON())
      console.error(err)
      send(500, { error: 'INTERNAL', message: 'Unexpected server error.' })
    }
  })
  return server
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
