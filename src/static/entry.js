// Browser-only demo entry. Runs the unchanged workbench services and route
// table inside the page (SQLite via sql.js, in memory), and answers the UI's
// /api requests without a network server. State resets on reload.
//
// Optional start stages via the URL fragment: #draft or #reviewed.
import { ready } from './sqlite-shim.js'
import { start } from '../workbench/main.js'
import { createWorkbench } from '../../server/workbench.js'
import { createRouter } from '../../server/router.js'
import { seedSources, generate, importInbox, removeUnresolved, judgeAll, accept } from '../../scripts/demo-steps.js'

await ready
const wb = createWorkbench({ dbPath: ':memory:' })
const author = wb.userForToken('demo-author-kim')
const reviewer = wb.userForToken('demo-reviewer-alvarez')
seedSources(wb, author)
const stage = location.hash.replace('#', '')
if (stage === 'draft' || stage === 'reviewed') {
  const r = await generate(wb, author)
  if (stage === 'reviewed') {
    importInbox(wb, author, 'insp-log-rev2')
    const r2 = await generate(wb, author, r.candidateId)
    accept(wb, reviewer, judgeAll(wb, reviewer, removeUnresolved(wb, reviewer, r2.versionId).versionId))
  }
}

const handle = createRouter(wb)
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url
  if (!raw.startsWith('/api/')) return realFetch(input, init)
  const url = new URL(raw, 'http://workbench.local')
  const headers = new Headers(init.headers || {})
  const token = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  let body = {}
  if (init.body) {
    try { body = JSON.parse(init.body) } catch { return new Response(JSON.stringify({ error: 'BAD_JSON', message: 'Body is not valid JSON.' }), { status: 400 }) }
  }
  // Yield so the UI can paint "busy" state before synchronous work runs.
  await new Promise((r) => setTimeout(r, 0))
  const out = await handle({ method: init.method || 'GET', pathname: url.pathname, searchParams: url.searchParams, token, body })
  return new Response(JSON.stringify(out.body ?? null), { status: out.status, headers: { 'content-type': 'application/json', ...(out.headers || {}) } })
}

window.__WB_STATIC__ = true
start()
