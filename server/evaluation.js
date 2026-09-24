// Evaluation runner. Executes the fixed case suite against each configuration
// in isolated in-memory workbenches, through the same service code the UI uses.
//
// What it measures: whether the workflow controls behave as declared (gaps
// visible, stale or unauthorized decisions blocked, retries safe) and a few
// draft-quality indicators that differ between the simulated model and the
// template baseline. It does not measure real-model quality: the "fixture"
// configuration is deterministic code written by the same author as the cases.
// Case expectations are never passed to a generator.
import { createWorkbench, codeRevision, runConfig, DEFAULT_FIXTURE_FAULTS } from './workbench.js'
import { loadScenario, loadInbox, loadEvalCases, loadEvalCriteria, loadEvalSource } from './fixtures.js'
import { hashOf, newId, nowIso, WorkbenchError } from './util.js'

const CONFIGS = [
  { configId: 'fixture-sim-v1', provider: 'fixture', label: 'Simulated model (deterministic fixture, seeded faults)' },
  { configId: 'baseline-template-v1', provider: 'baseline', label: 'Template baseline (no synthesis)' }
]
const FIXTURE_REPEATS = 2
const SCRIPTED_REVIEWER = 'scripted-reviewer (automation, not a human judgment)'

export function loadSuite() {
  const cases = loadEvalCases()
  const criteria = loadEvalCriteria()
  return { cases, criteria, criteriaHash: hashOf(criteria), suiteHash: hashOf(cases) }
}

function evalSource(ref) {
  if (ref.startsWith('inbox:')) return loadInbox(ref.slice(6))
  if (ref.startsWith('eval:')) return loadEvalSource(ref.slice(5))
  throw new Error(`Unknown source ref ${ref}`)
}

async function runCase(c, cfg, objective) {
  const wb = createWorkbench({ simulateLiveOutage: true })
  const author = wb.userForToken('demo-author-kim')
  const reviewer = wb.userForToken('demo-reviewer-alvarez')
  let n = 0
  const op = () => `eval-${c.id}-${cfg.configId}-${++n}`
  const outcomes = {}
  const safety = []
  const record = (a, outcome) => {
    if (a.label) outcomes[a.label] = outcome
    if (a.safety === 'must_block') safety.push({ label: a.label ?? a.do, outcome, unsafe: outcome === 'OK', unauthorized: Boolean(a.unauthorized) })
  }
  const attempt = async (fn) => {
    try { const r = await fn(); return r?.replayed ? 'REPLAYED' : 'OK' } catch (e) { if (e instanceof WorkbenchError) return e.code; throw e }
  }

  // Sources: base scenario with replacements, then additions.
  const replace = new Map((c.sources?.replace ?? []).map(evalSource).map((s) => [s.sourceId, s]))
  for (const s of loadScenario()) wb.importSource(author, { opId: op(), source: replace.get(s.sourceId) ?? s })
  for (const ref of c.sources?.add ?? []) wb.importSource(author, { opId: op(), source: evalSource(ref) })

  const provider = c.provider === 'anthropic_unavailable' ? 'anthropic' : cfg.provider
  const faults = cfg.provider === 'fixture' ? [...DEFAULT_FIXTURE_FAULTS, ...(c.faults ?? [])] : undefined
  const runOpId = op()
  const t0 = performance.now()
  let first = null
  let firstRunError = null
  try {
    first = (await wb.startRun(author, { opId: runOpId, objective, provider, faults })).body
  } catch (e) {
    if (!(e instanceof WorkbenchError)) throw e
    firstRunError = e
  }
  const latencyMs = Math.round(performance.now() - t0)
  const firstVersion = first ? wb.getVersion(first.versionId) : null
  let candidateId = first?.candidateId ?? null
  const latest = () => wb.getVersion(wb.getCandidate(candidateId).latestVersionId)

  const scriptedReview = () => {
    let v = latest()
    const bad = v.content.claims.filter((cl) => (v.checks.links[cl.id] || []).some((l) => l.status !== 'RESOLVED') || v.checks.findings.some((f) => f.target === cl.id && f.code === 'CLAIM_CITES_INSTRUCTION_TEXT'))
    if (bad.length && v.state !== 'STALE') {
      const judgeable = bad.filter((cl) => cl.kind === 'fact')
      if (judgeable.length) wb.judge(reviewer, v.versionId, { opId: op(), judgments: judgeable.map((cl) => ({ claimId: cl.id, support: 'DOES_NOT_SUPPORT', note: SCRIPTED_REVIEWER })) })
      const drop = new Set(bad.map((cl) => cl.id))
      const content = structuredClone(v.content)
      content.claims = content.claims.filter((cl) => !drop.has(cl.id))
      content.steps = content.steps.map((s) => ({ ...s, claimIds: s.claimIds.filter((id) => !drop.has(id)) })).filter((s) => s.claimIds.length)
      wb.editVersion(reviewer, v.versionId, { opId: op(), content, note: 'Scripted review: removed claims whose citations do not resolve.', expectedDigest: v.digest })
      v = latest()
    }
    const toJudge = v.content.claims.filter((cl) => cl.kind === 'fact' && !v.judgments[cl.id].current && v.checks.links[cl.id].every((l) => l.status === 'RESOLVED'))
    if (toJudge.length) wb.judge(reviewer, v.versionId, { opId: op(), judgments: toJudge.map((cl) => ({ claimId: cl.id, support: 'SUPPORTS', note: SCRIPTED_REVIEWER })) })
  }
  const accept = (user, v = latest(), opId = op()) => wb.decide(user, v.versionId, { opId, decision: 'ACCEPT_FOR_DEMO', rationale: SCRIPTED_REVIEWER, expectedDigest: v.digest, expectedManifestHash: v.manifestHash })
  let previousVersionId = null
  let lastDecisionId = null

  for (const a of first ? c.actions : c.actions.filter((x) => x.do === 'fixture_rerun')) {
    switch (a.do) {
      case 'scripted_review': scriptedReview(); break
      case 'accept': record(a, await attempt(() => { const r = accept(reviewer); lastDecisionId = r.body.decisionId; return r })); break
      case 'accept_without_review': record(a, await attempt(() => accept(reviewer))); break
      case 'accept_as_author': record(a, await attempt(() => accept(author))); break
      case 'export_reviewed': record(a, await attempt(() => wb.exportVersion(author, latest().versionId, { opId: op(), mode: 'reviewed' }))); break
      case 'export_reviewed_previous': record(a, await attempt(() => wb.exportVersion(author, previousVersionId, { opId: op(), mode: 'reviewed' }))); break
      case 'import': wb.importSource(author, { opId: op(), source: loadInbox(a.inbox) }); break
      case 'import_eval': record(a, await attempt(() => wb.importSource(author, { opId: op(), source: evalSource(a.source) }))); break
      case 'revoke': record(a, await attempt(() => wb.revoke(reviewer, lastDecisionId, { opId: op(), reason: SCRIPTED_REVIEWER }))); break
      case 'edit_minor': {
        const v = latest()
        previousVersionId = v.versionId
        const content = structuredClone(v.content)
        const target = content.claims.find((cl) => cl.kind === 'fact')
        target.text = target.text + ' (reviewer wording)'
        record(a, await attempt(() => wb.editVersion(reviewer, v.versionId, { opId: op(), content, note: 'Scripted wording edit.', expectedDigest: v.digest })))
        break
      }
      case 'judge_unresolved_supports': {
        const v = latest()
        const cl = v.content.claims.find((x) => v.checks.links[x.id].some((l) => l.status !== 'RESOLVED'))
        record(a, await attempt(() => wb.judge(reviewer, v.versionId, { opId: op(), judgments: [{ claimId: cl.id, support: 'SUPPORTS' }] })))
        break
      }
      case 'judge_text': {
        const v = latest()
        const cl = v.content.claims.find((x) => x.text.toLowerCase().includes(a.match))
        if (cl) wb.judge(reviewer, v.versionId, { opId: op(), judgments: [{ claimId: cl.id, support: a.support, note: SCRIPTED_REVIEWER }] })
        break
      }
      case 'concurrent_accept': {
        const seen = latest()
        wb.importSource(author, { opId: op(), source: loadInbox(a.inbox) })
        record(a, await attempt(() => accept(reviewer, seen)))
        break
      }
      case 'accept_twice_same_op': {
        const v = latest()
        const id = op()
        await attempt(() => accept(reviewer, v, id))
        record(a, await attempt(() => accept(reviewer, v, id)))
        break
      }
      case 'retry_generation': record(a, await attempt(() => wb.startRun(author, { opId: runOpId, objective, provider, faults }))); break
      case 'fixture_rerun': {
        const outcome = await attempt(async () => {
          const r = await wb.startRun(author, { opId: op(), objective, provider: 'fixture' })
          candidateId = r.body.candidateId
          return r
        })
        record(a, outcome)
        break
      }
      default: throw new Error(`Unknown action ${a.do}`)
    }
  }

  const finalVersion = candidateId ? latest() : null
  const runs = wb.listRuns()
  const acceptedDecisions = wb.db.prepare("SELECT COUNT(*) AS n FROM review_decisions WHERE decision = 'ACCEPT_FOR_DEMO'").get().n
  const events = wb.events()
  const impact = firstVersion ? wb.impact(finalVersion.versionId) : null
  const blocking = new Set((firstVersion?.checks.findings ?? []).filter((f) => f.severity === 'BLOCKING').map((f) => f.code))
  const allFindings = new Set((firstVersion?.checks.findings ?? []).map((f) => f.code))
  const firstRun = runs[runs.length - 1] ? wb.getRun(runs[runs.length - 1].runId) : null

  const expectations = c.expect.map((e) => {
    let observed
    let pass
    switch (e.type) {
      case 'blocking_includes': observed = [...blocking]; pass = blocking.has(e.code); break
      case 'blocking_excludes': observed = [...blocking]; pass = !blocking.has(e.code); break
      case 'finding_includes': observed = [...allFindings]; pass = allFindings.has(e.code); break
      case 'outcome': observed = outcomes[e.label] ?? 'NOT_RUN'; pass = observed === e.equals; break
      case 'final_state': observed = finalVersion?.state; pass = observed === e.equals; break
      case 'final_state_not': observed = finalVersion?.state; pass = observed !== e.equals; break
      case 'draft_declares_gap': observed = firstVersion?.content.missingEvidence.map((m) => m.about); pass = observed?.includes(e.about) ?? false; break
      case 'draft_declares_conflict': observed = firstVersion?.content.conflicts.length ?? 0; pass = observed > 0; break
      case 'impact_flags_source': observed = impact?.affectedClaims.map((x) => x.reasons.join('; ')); pass = impact?.affectedClaims.some((x) => x.reasons.join(' ').includes(e.sourceId)) ?? false; break
      case 'computed_change': observed = impact?.computedChanges.map((x) => `${x.before?.result}->${x.after?.result}`); pass = observed?.includes(`${e.from}->${e.to}`) ?? false; break
      case 'impact_check_change': observed = impact?.checkChanges.filter((x) => x.change === 'new').map((x) => x.code); pass = observed?.includes(e.code) ?? false; break
      case 'accepted_decisions': observed = acceptedDecisions; pass = observed === e.equals; break
      case 'run_count': observed = runs.length; pass = observed === e.equals; break
      case 'audit_includes': observed = events.filter((x) => x.result === e.result).length; pass = observed > 0; break
      case 'context_excludes': observed = JSON.stringify(firstRun?.context ?? {}).includes(e.text) ? 'present' : 'absent'; pass = observed === 'absent'; break
      case 'retrieval_excluded': observed = firstRun?.context?.retrieval?.excluded ?? []; pass = observed.some((x) => x.snapshotId.startsWith(e.sourceId + '@')); break
      case 'code_flags_claim': {
        const cl = firstVersion?.content.claims.find((x) => x.text.toLowerCase().includes(e.match))
        const flagged = cl ? firstVersion.checks.findings.some((f) => f.target === cl.id && f.severity === 'BLOCKING') : false
        observed = cl ? (flagged ? 'flagged by code' : 'not flagged by code (citation resolves mechanically)') : 'claim not present'
        pass = flagged
        break
      }
      case 'first_run_failed': observed = firstRunError ? `${firstRunError.code}: ${firstRunError.message}` : 'run succeeded'; pass = Boolean(firstRunError) && firstRunError.code === 'RUN_FAILED' && runs.some((r) => r.status === 'FAILED'); break
      case 'distinct_run_modes': observed = runs.map((r) => `${r.mode}:${r.status}`); pass = runs.some((r) => r.mode === 'LIVE_MODEL' && r.status === 'FAILED') && runs.some((r) => r.mode === 'SIMULATED' && r.status === 'SUCCEEDED'); break
      default: throw new Error(`Unknown expectation ${e.type}`)
    }
    return { ...e, observed, pass }
  })

  const m = firstVersion?.checks.metrics
  const metrics = firstVersion ? {
    requirementsCovered: m.requirementsCovered, requirementsTotal: m.requirementsTotal,
    citationsTotal: m.citationsTotal, citationsInvalid: m.citationsInvalid,
    recordGaps: m.recordGaps.length, recordGapsDeclaredInDraft: m.recordGaps.filter((g) => m.declaredGaps.includes(g)).length,
    recordConflicts: m.recordConflicts.length, recordConflictsDeclaredInDraft: Math.min(m.recordConflicts.length, m.declaredConflicts),
    blockingFindings: firstVersion.checks.summary.blocking, firstVersionDigest: firstVersion.digest,
    generationLatencyMs: latencyMs
  } : { generationLatencyMs: latencyMs }
  metrics.unsafeOutcomes = safety.filter((s) => s.unsafe).length
  metrics.unauthorizedActionsAllowed = safety.filter((s) => s.unsafe && s.unauthorized).length
  metrics.mustBlockAttempts = safety.length
  metrics.costUsd = null
  wb.close()
  const failures = expectations.filter((e) => !e.pass)
  // Control failures (a gate did not hold) are distinguished from draft-quality
  // misses and from limitations declared before the run.
  const outcome = failures.length === 0 ? 'PASS'
    : failures.some((e) => !e.quality && !e.knownLimitation) ? 'FAIL_CONTROL'
      : failures.some((e) => e.quality) ? 'FAIL_QUALITY' : 'FAIL_KNOWN_LIMITATION'
  return {
    outcome, expectations, metrics,
    unresolved: ['Semantic support of claims was labeled by a scripted reviewer, not a human.', ...(cfg.provider === 'fixture' ? ['Generator is a deterministic fixture; results do not describe a real model.'] : [])]
  }
}

export async function runEvaluation(db, { configs = CONFIGS, repeats = FIXTURE_REPEATS } = {}) {
  const { cases, criteria, criteriaHash, suiteHash } = loadSuite()
  const evalRunId = newId('eval')
  const startedAt = nowIso()
  db.prepare('INSERT INTO eval_runs (eval_run_id, suite_version, criteria_hash, code_revision, started_at) VALUES (?, ?, ?, ?, ?)').run(evalRunId, cases.suiteVersion, criteriaHash, codeRevision(), startedAt)
  const results = []
  for (const cfg of configs) {
    const configHash = hashOf(runConfig(cfg.provider))
    for (const c of cases.cases) {
      if (c.configs && !c.configs.includes(cfg.provider)) continue
      const n = cfg.provider === 'fixture' ? repeats : 1
      for (let r = 0; r < n; r++) {
        const res = await runCase(c, cfg, cases.objective)
        const row = { caseId: c.id, title: c.title, split: c.split, configId: cfg.configId, configHash, repeat: r, ...res }
        results.push(row)
        db.prepare('INSERT INTO eval_results (eval_run_id, case_id, config_id, config_hash, split, repeat_idx, outcome, expectations_json, metrics_json, grader, unresolved_json, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(evalRunId, c.id, cfg.configId, configHash, c.split, r, res.outcome, JSON.stringify(res.expectations), JSON.stringify(res.metrics), 'deterministic expectation checks (code)', JSON.stringify(res.unresolved), nowIso())
      }
    }
  }
  const summary = summarize(results, configs, criteria)
  const report = { evalRunId, suiteVersion: cases.suiteVersion, suiteHash, criteriaHash, criteria, codeRevision: codeRevision(), startedAt, finishedAt: nowIso(), summary, results }
  db.prepare('UPDATE eval_runs SET finished_at = ?, summary_json = ? WHERE eval_run_id = ?').run(report.finishedAt, JSON.stringify({ summary, suiteHash, criteria }), evalRunId)
  return report
}

function summarize(results, configs, criteria) {
  const per = {}
  for (const cfg of configs) {
    const rows = results.filter((r) => r.configId === cfg.configId)
    const first = rows.filter((r) => r.repeat === 0)
    const sum = (k) => first.reduce((a, r) => a + (r.metrics[k] ?? 0), 0)
    const bySplit = (split) => {
      const s = first.filter((r) => r.split === split)
      const count = (o) => s.filter((r) => r.outcome === o).length
      return { cases: s.length, passed: count('PASS'), failedControl: count('FAIL_CONTROL'), failedQuality: count('FAIL_QUALITY'), failedKnownLimitation: count('FAIL_KNOWN_LIMITATION') }
    }
    const qualityExp = first.flatMap((r) => r.expectations.filter((e) => e.quality))
    const controlExp = first.flatMap((r) => r.expectations.filter((e) => !e.quality))
    const repeatsConsistent = first.every((r) => rows.filter((x) => x.caseId === r.caseId).every((x) => x.metrics.firstVersionDigest === r.metrics.firstVersionDigest && x.outcome === r.outcome))
    const latencies = first.map((r) => r.metrics.generationLatencyMs).sort((a, b) => a - b)
    per[cfg.configId] = {
      label: cfg.label,
      dev: bySplit('dev'), heldout: bySplit('heldout'),
      expectationsPassed: first.reduce((a, r) => a + r.expectations.filter((e) => e.pass).length, 0),
      expectationsTotal: first.reduce((a, r) => a + r.expectations.length, 0),
      controlExpectations: { passed: controlExp.filter((e) => e.pass).length, total: controlExp.length },
      draftQualityExpectations: { passed: qualityExp.filter((e) => e.pass).length, total: qualityExp.length },
      requirementCoverage: { covered: sum('requirementsCovered'), total: sum('requirementsTotal') },
      invalidCitations: { invalid: sum('citationsInvalid'), total: sum('citationsTotal') },
      recordGapsDisclosedInDraft: { disclosed: sum('recordGapsDeclaredInDraft'), total: sum('recordGaps') },
      recordConflictsDisclosedInDraft: { disclosed: sum('recordConflictsDeclaredInDraft'), total: sum('recordConflicts') },
      mustBlockAttempts: sum('mustBlockAttempts'),
      unsafeOutcomes: sum('unsafeOutcomes'),
      unauthorizedActionsAllowed: sum('unauthorizedActionsAllowed'),
      generationLatencyMs: { median: latencies[Math.floor(latencies.length / 2)] ?? null, max: latencies[latencies.length - 1] ?? null, note: 'local, in-process, no model call' },
      costUsd: 'not applicable (no live model call)',
      repeats: { perCase: cfg.provider === 'fixture' ? rows.length / Math.max(first.length, 1) : 1, identicalAcrossRepeats: repeatsConsistent, note: 'Deterministic generator: repeats confirm determinism only and are not independent evidence.' },
      reviewerAdjudicatedUnsupportedClaims: 'UNMEASURED (no human reviewer)'
    }
  }
  const unsafe = Object.values(per).reduce((a, p) => a + p.unsafeOutcomes, 0)
  const unauthorized = Object.values(per).reduce((a, p) => a + p.unauthorizedActionsAllowed, 0)
  const gate = criteria.readinessGate
  const demoReady = unsafe <= gate.maxUnsafeAcceptances && unsafe <= gate.maxStaleDecisionBypasses && unauthorized <= gate.maxUnauthorizedActions
  return {
    perConfig: per,
    readinessGate: { demoReady, unsafeOutcomes: unsafe, unauthorizedActionsAllowed: unauthorized, label: 'Prototype demo readiness only; not operational, statistical or authorization evidence.' }
  }
}

export function latestEvaluation(db) {
  const run = db.prepare('SELECT * FROM eval_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1').get()
  if (!run) return null
  const rows = db.prepare('SELECT * FROM eval_results WHERE eval_run_id = ? ORDER BY config_id, case_id, repeat_idx').all(run.eval_run_id)
  const s = JSON.parse(run.summary_json)
  const titles = Object.fromEntries(loadSuite().cases.cases.map((c) => [c.id, c.title]))
  return {
    evalRunId: run.eval_run_id, suiteVersion: run.suite_version, criteriaHash: run.criteria_hash, codeRevision: run.code_revision, startedAt: run.started_at, finishedAt: run.finished_at,
    summary: s.summary, criteria: s.criteria, suiteHash: s.suiteHash,
    results: rows.map((r) => ({ caseId: r.case_id, title: titles[r.case_id] ?? '', configId: r.config_id, configHash: r.config_hash, split: r.split, repeat: r.repeat_idx, outcome: r.outcome, expectations: JSON.parse(r.expectations_json), metrics: JSON.parse(r.metrics_json), grader: r.grader, unresolved: JSON.parse(r.unresolved_json) }))
  }
}
