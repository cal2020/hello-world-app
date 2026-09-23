import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../server/db.js'
import { runEvaluation, latestEvaluation } from '../server/evaluation.js'

test('evaluation suite: no unsafe outcomes; declared limitation fails as declared', async () => {
  const db = openDb(':memory:')
  const report = await runEvaluation(db)
  assert.equal(report.summary.readinessGate.demoReady, true)
  const fx = report.summary.perConfig['fixture-sim-v1']
  assert.equal(fx.unsafeOutcomes, 0)
  assert.equal(fx.dev.failedControl + fx.heldout.failedControl, 0)
  const h08 = report.results.find((r) => r.caseId === 'H08' && r.configId === 'fixture-sim-v1')
  assert.equal(h08.outcome, 'FAIL_KNOWN_LIMITATION')
  const base = report.summary.perConfig['baseline-template-v1']
  assert.equal(base.dev.failedControl + base.heldout.failedControl, 0)
  assert.equal(latestEvaluation(db).evalRunId, report.evalRunId)
})
