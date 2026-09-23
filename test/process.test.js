// Process-level tests: crash after commit, retry, and restart persistence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, call, tempDbPath, OBJECTIVE, opId } from './helpers.js'
import { loadScenario } from '../server/fixtures.js'

async function seed(url) {
  for (const s of loadScenario()) {
    const r = await call(url, 'POST', '/api/sources', { opId: opId('seed'), source: s }, 'demo-author-kim')
    assert.equal(r.status, 201)
  }
}

test('crash after commit: retrying the same opId returns the committed run without duplication', async () => {
  const dbPath = tempDbPath()
  const s1 = await startServer({ dbPath, env: { WORKBENCH_FAULT: 'crash_after_commit:start_run' } })
  await seed(s1.url)
  const id = opId('crash')
  await assert.rejects(() => call(s1.url, 'POST', '/api/runs', { opId: id, objective: OBJECTIVE, provider: 'fixture' }, 'demo-author-kim'))
  assert.equal(await s1.exited, 86)

  const s2 = await startServer({ dbPath })
  try {
    const retry = await call(s2.url, 'POST', '/api/runs', { opId: id, objective: OBJECTIVE, provider: 'fixture' }, 'demo-author-kim')
    assert.equal(retry.status, 201)
    assert.equal(retry.replayed, true)
    const runs = await call(s2.url, 'GET', '/api/runs')
    assert.equal(runs.body.length, 1)
    assert.equal(runs.body[0].runId, retry.body.runId)
    const v = await call(s2.url, 'GET', `/api/versions/${retry.body.versionId}`)
    assert.equal(v.status, 200)
  } finally {
    s2.child.kill()
  }
})

test('restart preserves sources, drafts, judgments and decisions; HTTP enforces identities', async () => {
  const dbPath = tempDbPath()
  const s1 = await startServer({ dbPath })
  let versionId
  try {
    await seed(s1.url)
    const anon = await call(s1.url, 'POST', '/api/runs', { opId: opId(), objective: OBJECTIVE }, null)
    assert.equal(anon.status, 401)
    const viewer = await call(s1.url, 'POST', '/api/runs', { opId: opId(), objective: OBJECTIVE }, 'demo-viewer')
    assert.equal(viewer.status, 403)
    const run = await call(s1.url, 'POST', '/api/runs', { opId: opId(), objective: OBJECTIVE, provider: 'fixture' }, 'demo-author-kim')
    versionId = run.body.versionId
    const v = (await call(s1.url, 'GET', `/api/versions/${versionId}`)).body
    const decision = await call(s1.url, 'POST', `/api/versions/${versionId}/decisions`, { opId: opId(), decision: 'REQUEST_CHANGES', rationale: 'Resolve the serial conflict.', expectedDigest: v.digest, expectedManifestHash: v.manifestHash })
    assert.equal(decision.status, 201)
  } finally {
    s1.child.kill()
    await s1.exited
  }
  const s2 = await startServer({ dbPath })
  try {
    const v = (await call(s2.url, 'GET', `/api/versions/${versionId}`)).body
    assert.equal(v.decisions.length, 1)
    assert.equal(v.decisions[0].decision, 'REQUEST_CHANGES')
    assert.equal(v.integrity.digestMatches, true)
    assert.equal((await call(s2.url, 'GET', '/api/sources')).body.length, loadScenario().length)
    assert.equal((await call(s2.url, 'GET', '/api/audit/verify')).body.ok, true)
  } finally {
    s2.child.kill()
  }
})
