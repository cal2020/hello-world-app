import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CASES, REQUIREMENTS, EVIDENCE, REVIEWER, JUDGE_FIXTURES } from '../src/cases.js'
import { runChecks, allowedDecisions, toMilliseconds, containsInstructionText } from '../src/checks.js'
import { buildRequest, createFixtureJudge, PINNED_MODEL } from '../src/judge.js'
import { createRecord, recordStatus } from '../src/audit.js'
import { highlight } from '../src/html.js'

function evaluate(caseId, requirementRevision = 'C') {
  const c = CASES.find((x) => x.id === caseId)
  const requirement = REQUIREMENTS[c.requirementId]
  const evidence = EVIDENCE[c.evidenceId]
  const checks = runChecks({ requirement, requirementRevision, evidence, reviewer: REVIEWER })
  return { c, requirement, evidence, checks, allowed: allowedDecisions(checks) }
}

const statusOf = (checks, id) => checks.find((c) => c.id === id)?.status

test('unit conversion handles ms, s and unknown units', () => {
  assert.equal(toMilliseconds({ value: 2600, unit: 'ms' }), 2600)
  assert.equal(toMilliseconds({ value: 1.4, unit: 's' }), 1400)
  assert.equal(toMilliseconds({ value: 1, unit: 'fortnight' }), null)
  assert.equal(toMilliseconds({ value: '2', unit: 's' }), null)
})

test('obvious match: every check passes and verifies is allowed', () => {
  const { checks, allowed } = evaluate('obvious')
  assert.ok(checks.every((c) => c.status === 'pass'), JSON.stringify(checks))
  assert.equal(allowed.verifies, true)
})

test('ambiguous match: checks pass (900 ms), so the decision is the engineer’s', () => {
  const { checks, allowed } = evaluate('ambiguous')
  assert.equal(statusOf(checks, 'measurement'), 'pass')
  assert.equal(allowed.verifies, true)
  assert.equal(allowed.related, true)
})

test('obsolete revision: revision and measurement both block verifies', () => {
  const { checks, allowed } = evaluate('obsolete')
  assert.equal(statusOf(checks, 'revision'), 'fail')
  assert.equal(statusOf(checks, 'measurement'), 'fail')
  assert.equal(allowed.verifies, false)
})

test('arithmetic: 2600 ms fails a 2 s limit despite PASS wording', () => {
  const { checks, allowed } = evaluate('arithmetic')
  assert.equal(statusOf(checks, 'measurement'), 'fail')
  assert.equal(allowed.verifies, false)
})

test('injection: instruction text is flagged and missing measurement blocks', () => {
  const { checks, allowed } = evaluate('injection')
  assert.equal(statusOf(checks, 'instructions'), 'fail')
  assert.equal(statusOf(checks, 'measurement'), 'missing')
  assert.equal(allowed.verifies, false)
  assert.equal(containsInstructionText(EVIDENCE['TR-2291'].narrative), false)
})

test('restricted: access fails, only routing is allowed, and no other checks run', () => {
  const { checks, allowed } = evaluate('restricted')
  assert.deepEqual(checks.map((c) => c.id), ['access'])
  assert.deepEqual(allowed, { verifies: false, related: false, reject: false, route: true })
})

test('requirement revision change makes the obvious match fail the revision check', () => {
  const { checks } = evaluate('obvious', 'D')
  assert.equal(statusOf(checks, 'revision'), 'fail')
})

test('fixture judge pins the model and reports unavailable for unknown keys', () => {
  const judge = createFixtureJudge(JUDGE_FIXTURES)
  const req = buildRequest('r', 'e')
  assert.equal(req.model, PINNED_MODEL)
  assert.equal(judge.judge('obvious@C', req).choice, 'supports')
  assert.equal(judge.judge('ambiguous@C', req).choice, 'ambiguous')
  assert.equal(judge.judge('obvious@D', req).status, 'unavailable')
})

test('approvals go stale when a source revision changes', () => {
  const { requirement, evidence, checks } = evaluate('obvious')
  const record = createRecord({
    caseId: 'obvious', decision: 'verifies', requirement, requirementRevision: 'C', evidence,
    judgment: null, checks, rationale: 'meets rev C', reviewer: REVIEWER, reviewMs: 1000, at: '2026-09-23T00:00:00Z',
  })
  assert.match(record.fingerprint, /^[0-9a-f]{8}$/)
  const evidenceRevs = { 'TR-2291': '2' }
  assert.equal(recordStatus(record, { requirements: { 'REQ-TS-014': 'C' }, evidence: evidenceRevs }), 'current')
  assert.equal(recordStatus(record, { requirements: { 'REQ-TS-014': 'D' }, evidence: evidenceRevs }), 'stale')
  assert.equal(recordStatus(record, { requirements: { 'REQ-TS-014': 'C' }, evidence: { 'TR-2291': '3' } }), 'stale')
})

test('every fixture citation occurs verbatim in its source text', () => {
  for (const [key, fixture] of Object.entries(JUDGE_FIXTURES)) {
    const [caseId, rev] = key.split('@')
    const c = CASES.find((x) => x.id === caseId)
    const reqText = REQUIREMENTS[c.requirementId].revisions[rev].text
    const evText = EVIDENCE[c.evidenceId].narrative
    for (const p of fixture.cites.requirement) assert.ok(reqText.includes(p), `${key}: "${p}" not in requirement`)
    for (const p of fixture.cites.evidence) assert.ok(evText.includes(p), `${key}: "${p}" not in evidence`)
  }
})

test('highlight escapes HTML', () => {
  assert.equal(highlight('<b> a & b', ['a']), '&lt;b&gt; <mark>a</mark> &amp; b')
})
