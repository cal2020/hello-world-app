import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkbench } from '../server/workbench.js'
import { loadScenario, loadInbox } from '../server/fixtures.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OBJECTIVE = 'Draft a candidate inspection procedure for PSK-7 portable sensor kit device DEV-0193.'

let counter = 0
export const opId = (p = 'test') => `${p}-${process.pid}-${Date.now()}-${++counter}`

export function seededWorkbench({ add = [] } = {}) {
  const wb = createWorkbench()
  const author = wb.userForToken('demo-author-kim')
  const reviewer = wb.userForToken('demo-reviewer-alvarez')
  for (const s of loadScenario()) wb.importSource(author, { opId: opId(), source: s })
  for (const name of add) wb.importSource(author, { opId: opId(), source: loadInbox(name) })
  return { wb, author, reviewer }
}

// Removes claims whose citations do not resolve, then judges the rest SUPPORTS.
export function reviewToReady(wb, reviewer, versionId) {
  let v = wb.getVersion(versionId)
  const bad = new Set(v.content.claims.filter((c) => v.checks.links[c.id].some((l) => l.status !== 'RESOLVED')).map((c) => c.id))
  if (bad.size) {
    const content = structuredClone(v.content)
    content.claims = content.claims.filter((c) => !bad.has(c.id))
    content.steps = content.steps.map((s) => ({ ...s, claimIds: s.claimIds.filter((id) => !bad.has(id)) })).filter((s) => s.claimIds.length)
    const e = wb.editVersion(reviewer, v.versionId, { opId: opId(), content, note: 'remove unresolved', expectedDigest: v.digest })
    v = wb.getVersion(e.body.versionId)
  }
  const facts = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current)
  if (facts.length) wb.judge(reviewer, v.versionId, { opId: opId(), judgments: facts.map((c) => ({ claimId: c.id, support: 'SUPPORTS' })) })
  return wb.getVersion(v.versionId)
}

export function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'ttp-wb-')), 'wb.db')
}

export function startServer({ dbPath, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: '0', WORKBENCH_DB: dbPath, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const onData = (d) => {
      out += d.toString()
      const m = out.match(/listening on (http:\/\/localhost:\d+)/)
      if (m) resolve({ child, url: m[1], exited: new Promise((r) => child.on('exit', (code) => r(code))) })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)))
  })
}

export async function call(url, method, path, body, token = 'demo-reviewer-alvarez') {
  const res = await fetch(url + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, replayed: res.headers.get('x-replayed') === 'true', body: await res.json() }
}
