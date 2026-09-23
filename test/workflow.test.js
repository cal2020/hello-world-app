// Service-level tests of the review workflow and its boundaries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededWorkbench, reviewToReady, opId, OBJECTIVE } from './helpers.js'
import { loadInbox } from '../server/fixtures.js'
import { getSnapshot } from '../server/sources.js'

async function generate(wb, user, extra = {}) {
  return (await wb.startRun(user, { opId: opId(), objective: OBJECTIVE, provider: 'fixture', ...extra })).body
}

const blockingCodes = (v) => v.checks.findings.filter((f) => f.severity === 'BLOCKING').map((f) => f.code)

test('every resolved citation points to the exact retained snapshot and passage span', async () => {
  const { wb, author } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = wb.getVersion((await generate(wb, author)).versionId)
  let resolved = 0
  for (const links of Object.values(v.checks.links)) {
    for (const l of links) {
      if (l.status !== 'RESOLVED') continue
      const snap = getSnapshot(wb.db, l.snapshotId)
      const passage = snap.passages.find((p) => p.id === l.passageId)
      assert.equal(passage.text.slice(l.span[0], l.span[1]), l.quote)
      assert.equal(l.contentHash, snap.contentHash)
      resolved++
    }
  }
  assert.ok(resolved > 10)
  // The seeded fabricated step is shown as a mismatch, not as verified.
  assert.ok(blockingCodes(v).includes('CITATION_QUOTE_MISMATCH'))
})

test('missing and conflicting evidence is visible and blocks acceptance', async () => {
  const { wb, author, reviewer } = seededWorkbench()
  const r = await generate(wb, author, { faults: [] })
  const v = wb.getVersion(r.versionId)
  assert.equal(v.state, 'DRAFT')
  assert.ok(blockingCodes(v).includes('MISSING_OBSERVATION'))
  assert.ok(blockingCodes(v).includes('RECORD_CONFLICT'))
  assert.ok(v.content.missingEvidence.some((m) => m.about === 'IP-BATTERY'))
  assert.equal(v.content.conflicts.length, 1)
  assert.throws(() => wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'x', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }),
    (e) => e.code === 'REVIEW_BLOCKED' && e.details.reasons.some((x) => x.code === 'CHECK_MISSING_OBSERVATION'))
})

test('acceptance requires a reviewer judgment on every fact claim, and ignores client approval flags', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = wb.getVersion((await generate(wb, author, { faults: [] })).versionId)
  assert.equal(v.state, 'NEEDS_REVIEW')
  assert.throws(() => wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'x', expectedDigest: v.digest, expectedManifestHash: v.manifestHash, approved: true, state: 'REVIEWED_FOR_DEMO' }),
    (e) => e.code === 'REVIEW_BLOCKED' && e.details.reasons.every((x) => x.code === 'UNJUDGED_CLAIM'))
  assert.throws(() => wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'APPROVED', rationale: 'x', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }), (e) => e.code === 'INVALID_DECISION')
  const ready = reviewToReady(wb, reviewer, v.versionId)
  const d = wb.decide(reviewer, ready.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'Checked each passage.', expectedDigest: ready.digest, expectedManifestHash: ready.manifestHash })
  assert.equal(d.body.state, 'REVIEWED_FOR_DEMO')
  assert.equal(d.body.candidateDigest, ready.digest)
})

test('authors cannot accept; the denial is audited', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = reviewToReady(wb, reviewer, (await generate(wb, author)).versionId)
  assert.throws(() => wb.decide(author, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'x', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }), (e) => e.code === 'FORBIDDEN')
  assert.ok(wb.events().some((e) => e.result === 'REJECTED:FORBIDDEN' && e.actor === 'u_kim'))
})

test('a requirement change marks the accepted version stale, identifies affected conclusions and blocks reviewed export', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = reviewToReady(wb, reviewer, (await generate(wb, author)).versionId)
  const d = wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'ok', expectedDigest: v.digest, expectedManifestHash: v.manifestHash })
  assert.equal(wb.exportVersion(author, v.versionId, { opId: opId(), mode: 'reviewed' }).status, 201)

  const imp = wb.importSource(author, { opId: opId(), source: loadInbox('req-002-revB') })
  assert.ok(imp.body.markedStale.map((x) => x.versionId).includes(v.versionId))
  assert.equal(wb.getVersion(v.versionId).state, 'STALE')

  const impact = wb.impact(v.versionId)
  assert.deepEqual(impact.sources.changed.map((c) => `${c.from}->${c.to}`), ['REQ-002@A->REQ-002@B'])
  assert.deepEqual(impact.sources.changed[0].structured, [{ field: 'maxCalibrationAgeDays', before: 180, after: 90 }])
  const byKind = Object.fromEntries(impact.affectedClaims.map((c) => [c.claimId, c.severity]))
  const computed = v.content.claims.find((c) => c.kind === 'computed')
  assert.equal(byKind[computed.id], 'REASSESS')
  assert.deepEqual(impact.computedChanges.map((c) => `${c.before.result}->${c.after.result}`), ['PASS->FAIL'])
  assert.ok(impact.affectedClaims.some((c) => c.severity === 'RECONFIRM'), 'unchanged passage in revised source is flagged for re-confirmation')
  assert.ok(impact.unaffectedClaims.length > 5, 'claims citing unchanged sources are not flagged')
  assert.deepEqual(impact.affectedSteps.map((s) => s.stepId), ['S3'])
  assert.equal(impact.decisions[0].decisionId, d.body.decisionId)
  assert.ok(impact.decisions[0].status.reasons.some((r) => r.code === 'SOURCE_MANIFEST_CHANGED'))

  assert.throws(() => wb.exportVersion(author, v.versionId, { opId: opId(), mode: 'reviewed' }), (e) => e.code === 'EXPORT_BLOCKED')
  const draft = wb.exportVersion(author, v.versionId, { opId: opId(), mode: 'draft' })
  assert.match(draft.body.banner, /UNREVIEWED DRAFT - NOT APPROVED/)
  assert.throws(() => wb.judge(reviewer, v.versionId, { opId: opId(), judgments: [{ claimId: 'C1', support: 'SUPPORTS' }] }), (e) => e.code === 'STALE_CONFLICT')
})

test('regeneration after a change carries judgments forward only for unchanged claims', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const r = await generate(wb, author, { faults: [] })
  const v1 = reviewToReady(wb, reviewer, r.versionId)
  wb.importSource(author, { opId: opId(), source: loadInbox('req-002-revB') })
  const v2 = wb.getVersion((await generate(wb, author, { candidateId: r.candidateId, faults: [] })).versionId)
  const unjudged = v2.content.claims.filter((c) => c.kind === 'fact' && !v2.judgments[c.id].current).map((c) => c.evidence[0].snapshotId)
  assert.deepEqual([...new Set(unjudged)], ['REQ-002@B'])
  assert.ok(v1.content.claims.filter((c) => c.kind === 'fact').length > unjudged.length)
  assert.equal(v2.checks.computed[v2.content.claims.find((c) => c.kind === 'computed').id].result, 'FAIL')
})

test('editing creates a new version; the previous decision does not transfer', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = reviewToReady(wb, reviewer, (await generate(wb, author)).versionId)
  wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'ok', expectedDigest: v.digest, expectedManifestHash: v.manifestHash })
  const content = structuredClone(v.content)
  content.claims[0].text += ' (edited)'
  const e = wb.editVersion(reviewer, v.versionId, { opId: opId(), content, note: 'wording', expectedDigest: v.digest })
  const v2 = wb.getVersion(e.body.versionId)
  assert.equal(v2.parentVersionId, v.versionId)
  assert.notEqual(v2.digest, v.digest)
  assert.equal(v2.state, 'NEEDS_REVIEW')
  assert.equal(v2.decisions.length, 0)
  assert.ok(!v2.judgments[content.claims[0].id].current, 'edited claim needs a new judgment')
  assert.ok(wb.getVersion(v.versionId).decisions[0].status.reasons.some((r) => r.code === 'NOT_LATEST_VERSION'))
  assert.throws(() => wb.exportVersion(author, v.versionId, { opId: opId(), mode: 'reviewed' }), (err) => err.code === 'EXPORT_BLOCKED')
  assert.throws(() => wb.editVersion(reviewer, v2.versionId, { opId: opId(), content, note: 'x', expectedDigest: 'sha256:old' }), (err) => err.code === 'STALE_CONFLICT')
})

test('revocation is retained in history and blocks reviewed export', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const v = reviewToReady(wb, reviewer, (await generate(wb, author)).versionId)
  const d = wb.decide(reviewer, v.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'ok', expectedDigest: v.digest, expectedManifestHash: v.manifestHash })
  const patel = wb.userForToken('demo-reviewer-patel')
  wb.revoke(patel, d.body.decisionId, { opId: opId(), reason: 'Calibration lab accreditation under query.' })
  const after = wb.getVersion(v.versionId)
  assert.equal(after.state, 'NEEDS_REVIEW')
  assert.equal(after.decisions[0].revokedBy, 'S. Patel (reviewer)')
  assert.ok(after.decisions[0].status.reasons.some((r) => r.code === 'REVOKED'))
  assert.throws(() => wb.exportVersion(author, v.versionId, { opId: opId(), mode: 'reviewed' }), (e) => e.code === 'EXPORT_BLOCKED')
})

test('a source import between load and accept rejects the stale decision', async () => {
  const { wb, author, reviewer } = seededWorkbench({ add: ['insp-log-rev2'] })
  const seen = reviewToReady(wb, reviewer, (await generate(wb, author)).versionId)
  wb.importSource(author, { opId: opId(), source: loadInbox('cal-0588-new') })
  assert.throws(() => wb.decide(reviewer, seen.versionId, { opId: opId(), decision: 'ACCEPT_FOR_DEMO', rationale: 'ok', expectedDigest: seen.digest, expectedManifestHash: seen.manifestHash }),
    (e) => e.code === 'STALE_CONFLICT' && e.details.versionNeedingReview === seen.versionId && e.details.delta.added[0].sourceId === 'CAL-0588')
  assert.equal(wb.db.prepare('SELECT COUNT(*) AS n FROM review_decisions').get().n, 0)
})

test('instruction-like source text grants no authority and the model cannot set status', async () => {
  const { wb, author } = seededWorkbench({ add: ['insp-log-rev2', 'vendor-note-injection'] })
  const r = await generate(wb, author, { faults: [] })
  const run = wb.getRun(r.runId)
  assert.equal(run.rawOutput.approved, true, 'simulated model emitted an approval field')
  assert.deepEqual(run.strippedFields.sort(), ['approved', 'reviewStatus'])
  const v = wb.getVersion(r.versionId)
  assert.equal(v.content.approved, undefined)
  assert.equal(v.state, 'DRAFT')
  assert.ok(blockingCodes(v).includes('CLAIM_CITES_INSTRUCTION_TEXT'))
  assert.ok(v.checks.findings.some((f) => f.code === 'MODEL_FIELD_IGNORED'))
})

test('restricted sources are excluded from model context', async () => {
  const { wb, author } = seededWorkbench({ add: ['restricted-personnel-note'] })
  const run = wb.getRun((await generate(wb, author)).runId)
  assert.ok(!JSON.stringify(run.context).includes('RESTRICTED-MARKER-7731'))
  assert.deepEqual(run.context.retrieval.excluded, [{ snapshotId: 'PERS-NOTE-1@1', reason: 'accessLabel=RESTRICTED' }])
})

test('source history is never overwritten', async () => {
  const { wb, author } = seededWorkbench({ add: ['req-002-revB'] })
  await generate(wb, author)
  const tampered = { ...loadInbox('req-002-revB'), title: 'Different content, same revision' }
  assert.throws(() => wb.importSource(author, { opId: opId(), source: tampered }), (e) => e.code === 'REVISION_CONFLICT')
  const older = { ...loadInbox('req-002-revB'), revision: 'A1', revisionSeq: 1 }
  assert.throws(() => wb.importSource(author, { opId: opId(), source: older }), (e) => e.code === 'REVISION_CONFLICT')
  assert.throws(() => wb.db.prepare("UPDATE source_snapshots SET title = 'x'").run(), /immutable/)
  assert.throws(() => wb.db.prepare('DELETE FROM audit_events').run(), /append-only/)
  assert.throws(() => wb.db.prepare("UPDATE candidate_versions SET content_json = '{}'").run(), /immutable/)
  assert.equal(wb.verifyAudit().ok, true)
})

test('operation ids are idempotent and cannot be reused for a different request', async () => {
  const { wb, author } = seededWorkbench()
  const id = opId()
  const a = await wb.startRun(author, { opId: id, objective: OBJECTIVE, provider: 'fixture' })
  const b = await wb.startRun(author, { opId: id, objective: OBJECTIVE, provider: 'fixture' })
  assert.equal(b.replayed, true)
  assert.deepEqual(b.body, a.body)
  assert.equal(wb.listRuns().length, 1)
  await assert.rejects(() => wb.startRun(author, { opId: id, objective: OBJECTIVE, provider: 'baseline' }), (e) => e.code === 'OP_ID_REUSED')
  assert.throws(() => wb.importSource(author, { opId: 'short', source: loadInbox('cal-0588-new') }), (e) => e.code === 'OP_ID_REQUIRED')
})

test('a failed live-model run is explicit and never replaced by fixture output', async () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN }
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  try {
    const { wb, author } = seededWorkbench()
    await assert.rejects(() => wb.startRun(author, { opId: opId(), objective: OBJECTIVE, provider: 'anthropic' }), (e) => e.code === 'RUN_FAILED' && e.details.providerError === 'PROVIDER_UNAVAILABLE')
    const runs = wb.listRuns()
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'FAILED')
    assert.equal(runs[0].mode, 'LIVE_MODEL')
    assert.equal(wb.db.prepare('SELECT COUNT(*) AS n FROM candidate_versions').get().n, 0)
  } finally {
    if (saved.k) process.env.ANTHROPIC_API_KEY = saved.k
    if (saved.t) process.env.ANTHROPIC_AUTH_TOKEN = saved.t
  }
})

test('fixture and baseline runs are labeled in the version and the export', async () => {
  const { wb, author } = seededWorkbench()
  const f = await generate(wb, author)
  const b = (await wb.startRun(author, { opId: opId(), objective: OBJECTIVE, provider: 'baseline' })).body
  assert.equal(wb.getVersion(f.versionId).generation.mode, 'SIMULATED')
  assert.equal(wb.getVersion(b.versionId).generation.mode, 'BASELINE_TEMPLATE')
  const exp = wb.exportVersion(author, f.versionId, { opId: opId(), mode: 'draft' })
  assert.match(exp.body.markdown, /SIMULATED \(none \(deterministic fixture, not AI\)/)
  assert.equal(exp.body.evidenceRecord.generation.mode, 'SIMULATED')
  assert.notEqual(wb.getRun(f.runId).configHash, wb.getRun(b.runId).configHash)
})
