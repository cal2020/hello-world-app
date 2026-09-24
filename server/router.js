// Route table shared by the Node HTTP server and the browser-only demo build.
// Every mutating route requires an opId in the body and a demo identity token.
import { WorkbenchError } from './util.js'
import { requirePermission } from './ops.js'
import { listInbox, loadInbox } from './fixtures.js'
import { runEvaluation, latestEvaluation } from './evaluation.js'

export function createRouter(wb) {
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


  // Returns { status, body, headers } for one request; never throws.
  return async function handle({ method, pathname, searchParams, token, body }) {
    const r = routes.find((x) => x.method === method && x.re.test(pathname))
    if (!r) return { status: 404, body: { error: 'NOT_FOUND', message: `${method} ${pathname}` } }
    try {
      const m = pathname.match(r.re)
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      const user = wb.userForToken(token)
      if (method !== 'GET' && !user) throw new WorkbenchError(401, 'UNAUTHENTICATED', 'Select a demo identity.')
      const out = await r.handler({ user, body: body ?? {}, params, query: searchParams })
      return { status: out.status ?? 200, body: out.body, headers: out.replayed ? { 'x-replayed': 'true' } : {} }
    } catch (err) {
      if (err instanceof WorkbenchError) return { status: err.status, body: err.toJSON() }
      console.error(err)
      return { status: 500, body: { error: 'INTERNAL', message: 'Unexpected server error.' } }
    }
  }
}
