// Workbench service: the pipeline and the review state machine.
//
//   source import -> manifest -> retrieval -> generation (fixture | baseline | live)
//   -> normalization -> deterministic checks -> candidate version
//   -> reviewer judgments + decision (bound to digest + manifest) -> export
//
// Responsibility boundaries:
//   code      ids, hashes, manifests, checks, state transitions, permissions
//   generator suggests steps, claims, questions and citations (untrusted)
//   reviewer  judges whether evidence supports claims; decides on a version
import { execSync } from 'node:child_process'
import { openDb, tx, getMeta, setMeta } from './db.js'
import { appendEvent, listEvents, verifyChain } from './audit.js'
import { runOp, reserveOp, completeOp, recordRejection, requirePermission, seedUsers, userForToken, maybeCrash, DEMO_USERS } from './ops.js'
import { importSnapshot, currentManifest, snapshotsForManifest, retrieve, listSnapshots, getSnapshot, activeSnapshots, RETRIEVAL_CONFIG } from './sources.js'
import { normalizeContent, runChecks, CHECKS_VERSION } from './checks.js'
import { generateFixture, FIXTURE_PROMPT_VERSION } from './providers/fixture.js'
import { generateBaseline, BASELINE_PROMPT_VERSION } from './providers/baseline.js'
import { generateAnthropic, anthropicAvailable, ANTHROPIC_PROMPT_VERSION, DEFAULT_MODEL } from './providers/anthropic.js'
import { hashOf, newId, nowIso, fail, WorkbenchError, shortHash } from './util.js'

export const STATES = ['DRAFT', 'NEEDS_REVIEW', 'REVIEWED_FOR_DEMO', 'REJECTED', 'STALE']
export const SUPPORT_VALUES = ['SUPPORTS', 'DOES_NOT_SUPPORT', 'CONTRADICTS', 'INSUFFICIENT']
export const DECISIONS = ['ACCEPT_FOR_DEMO', 'REQUEST_CHANGES', 'REJECT']
export const CORPUS_VERSION = 'psk7-scenario-v1'
export const DEFAULT_FIXTURE_FAULTS = ['fabricated_step']

let CODE_REVISION = null
export function codeRevision() {
  if (CODE_REVISION) return CODE_REVISION
  try {
    const rev = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '+dirty' : ''
    CODE_REVISION = rev + dirty
  } catch {
    CODE_REVISION = 'unknown'
  }
  return CODE_REVISION
}

export function runConfig(provider, { faults, model } = {}) {
  const base = { retrieval: RETRIEVAL_CONFIG, tools: [], checksVersion: CHECKS_VERSION, corpusVersion: CORPUS_VERSION }
  if (provider === 'fixture') {
    return { ...base, provider, mode: 'SIMULATED', model: 'none (deterministic fixture, not AI)', promptVersion: FIXTURE_PROMPT_VERSION, sampling: 'n/a (deterministic)', faults: [...(faults ?? DEFAULT_FIXTURE_FAULTS)].sort() }
  }
  if (provider === 'baseline') {
    return { ...base, provider, mode: 'BASELINE_TEMPLATE', model: 'none (template)', promptVersion: BASELINE_PROMPT_VERSION, sampling: 'n/a (deterministic)' }
  }
  if (provider === 'anthropic') {
    return { ...base, provider, mode: 'LIVE_MODEL', model: model || DEFAULT_MODEL, promptVersion: ANTHROPIC_PROMPT_VERSION, sampling: { effort: 'medium', thinking: 'model default', maxTokens: 16000, serverSideFallback: 'default' } }
  }
  fail(422, 'UNKNOWN_PROVIDER', `Provider '${provider}' is not one of fixture, baseline, anthropic.`)
}

// The claim digest keys reviewer judgments. A judgment carries forward to a
// new version only if the claim text, kind and exact cited snapshots are the
// same; any source revision produces a different digest and needs re-judgment.
export function claimDigest(c) {
  return hashOf({ kind: c.kind, text: c.text, check: c.check ?? null, evidence: c.evidence.map((e) => ({ snapshotId: e.snapshotId, passageId: e.passageId, quote: e.quote })) })
}

// simulateLiveOutage is a constructor-only option used by the evaluation suite
// to exercise the provider-failure path; it is not reachable over HTTP.
export function createWorkbench({ dbPath = ':memory:', asOf = '2026-09-23', simulateLiveOutage = false } = {}) {
  const db = openDb(dbPath)
  seedUsers(db)
  if (!getMeta(db, 'asOf')) setMeta(db, 'asOf', asOf)
  const inFlight = new Set()

  // Reconcile after a crash: runs left RUNNING and operations left PENDING by a
  // previous process are marked interrupted. Retrying the same opId returns the
  // interrupted outcome; a fresh opId starts a new run.
  tx(db, () => {
    for (const r of db.prepare("SELECT run_id FROM runs WHERE status = 'RUNNING'").all()) {
      db.prepare("UPDATE runs SET status = 'INTERRUPTED', error = ?, finished_at = ? WHERE run_id = ?").run('Process stopped before the run completed.', nowIso(), r.run_id)
      appendEvent(db, { actor: 'system', operation: 'reconcile', subject: r.run_id, result: 'RUN_INTERRUPTED' })
    }
    for (const o of db.prepare("SELECT op_id, kind FROM operations WHERE status = 'PENDING'").all()) {
      const body = { error: 'INTERRUPTED', message: 'The operation was interrupted before completion. Retry with a new opId.' }
      db.prepare("UPDATE operations SET status = 'REJECTED', http_status = 409, response_json = ?, completed_at = ? WHERE op_id = ?").run(JSON.stringify(body), nowIso(), o.op_id)
      appendEvent(db, { actor: 'system', operation: 'reconcile', opId: o.op_id, subject: o.kind, result: 'OP_INTERRUPTED' })
    }
  })

  const asOfDate = () => getMeta(db, 'asOf')

  // ---------- reading helpers
  function versionRow(versionId) {
    const r = db.prepare('SELECT * FROM candidate_versions WHERE version_id = ?').get(versionId)
    if (!r) fail(404, 'NOT_FOUND', `Version ${versionId} not found.`)
    return r
  }
  function candidateRow(candidateId) {
    const r = db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(candidateId)
    if (!r) fail(404, 'NOT_FOUND', `Candidate ${candidateId} not found.`)
    return r
  }
  const parseVersion = (r) => ({
    versionId: r.version_id, candidateId: r.candidate_id, versionNo: r.version_no, parentVersionId: r.parent_version_id, runId: r.run_id,
    createdBy: r.created_by, createdAt: r.created_at, content: JSON.parse(r.content_json), digest: r.digest,
    manifestHash: r.manifest_hash, sourceManifest: JSON.parse(r.source_manifest_json), checks: JSON.parse(r.checks_json), state: r.state, editNote: r.edit_note
  })
  const userName = (id) => db.prepare('SELECT name FROM users WHERE user_id = ?').get(id)?.name ?? id

  function effectiveJudgments(content) {
    const out = {}
    for (const c of content.claims) {
      const d = claimDigest(c)
      const rows = db.prepare('SELECT * FROM support_judgments WHERE claim_digest = ? ORDER BY created_at DESC, rowid DESC').all(d)
      out[c.id] = {
        claimDigest: d,
        current: rows[0] ? { support: rows[0].support, reviewer: userName(rows[0].reviewer_id), reviewerId: rows[0].reviewer_id, note: rows[0].note, at: rows[0].created_at, onVersion: rows[0].version_id } : null,
        history: rows.map((x) => ({ support: x.support, reviewer: userName(x.reviewer_id), note: x.note, at: x.created_at, onVersion: x.version_id }))
      }
    }
    return out
  }

  function manifestDelta(fromEntries, toEntries) {
    const from = new Map(fromEntries.map((e) => [e.sourceId, e]))
    const to = new Map(toEntries.map((e) => [e.sourceId, e]))
    const changed = []
    const added = []
    const removed = []
    for (const [sid, e] of to) {
      const old = from.get(sid)
      if (!old) added.push({ sourceId: sid, to: e.snapshotId })
      else if (old.contentHash !== e.contentHash) changed.push({ sourceId: sid, from: old.snapshotId, to: e.snapshotId })
    }
    for (const [sid, e] of from) if (!to.has(sid)) removed.push({ sourceId: sid, from: e.snapshotId })
    return { changed, added, removed }
  }

  // Why a decision is or is not currently usable. Evaluated at read time and
  // again inside the export transaction.
  function decisionStatus(d, v, current) {
    const reasons = []
    if (d.decision !== 'ACCEPT_FOR_DEMO') reasons.push({ code: 'NOT_AN_ACCEPTANCE', message: `Decision is ${d.decision}.` })
    if (d.revoked_at) reasons.push({ code: 'REVOKED', message: `Revoked by ${userName(d.revoked_by)} at ${d.revoked_at}: ${d.revoke_reason}` })
    if (d.candidate_digest !== v.digest || hashOf(v.content) !== d.candidate_digest) reasons.push({ code: 'DIGEST_MISMATCH', message: 'Candidate content does not match the digest the decision was made on.' })
    if (d.manifest_hash !== current.hash) {
      const delta = manifestDelta(v.sourceManifest, current.entries)
      const parts = [...delta.changed.map((c) => `${c.from} -> ${c.to}`), ...delta.added.map((a) => `added ${a.to}`), ...delta.removed.map((r) => `removed ${r.from}`)]
      reasons.push({ code: 'SOURCE_MANIFEST_CHANGED', message: `Source manifest changed since the decision: ${parts.join('; ') || 'different manifest'}.`, delta })
    }
    const latest = candidateRow(v.candidateId).latest_version_id
    if (latest !== v.versionId) reasons.push({ code: 'NOT_LATEST_VERSION', message: `A newer version (${latest}) exists; the decision applies only to ${v.versionId}.` })
    return { valid: reasons.length === 0, reasons }
  }

  function decisionsFor(v, current) {
    return db.prepare('SELECT * FROM review_decisions WHERE version_id = ? ORDER BY created_at').all(v.versionId).map((d) => ({
      decisionId: d.decision_id, decision: d.decision, reviewer: userName(d.reviewer_id), reviewerId: d.reviewer_id, rationale: d.rationale,
      createdAt: d.created_at, candidateDigest: d.candidate_digest, manifestHash: d.manifest_hash,
      revokedAt: d.revoked_at, revokedBy: d.revoked_by ? userName(d.revoked_by) : null, revokeReason: d.revoke_reason,
      status: decisionStatus(d, v, current)
    }))
  }

  // Everything that would stop ACCEPT_FOR_DEMO right now, re-derived from
  // stored state (never from a client-supplied flag).
  function acceptReadiness(v, current) {
    const reasons = []
    const latest = candidateRow(v.candidateId).latest_version_id
    if (latest !== v.versionId) reasons.push({ code: 'NOT_LATEST_VERSION', message: `Only the latest version (${latest}) can be decided.` })
    if (hashOf(v.content) !== v.digest) reasons.push({ code: 'DIGEST_MISMATCH', message: 'Stored content does not match its digest.' })
    if (v.manifestHash !== current.hash) reasons.push({ code: 'STALE_SOURCES', message: 'Sources changed since this version was generated; regenerate against the current manifest.' })
    if (v.state === 'STALE' || v.state === 'REJECTED') reasons.push({ code: `STATE_${v.state}`, message: `Version is ${v.state}.` })
    const checksNow = v.manifestHash === current.hash ? runChecks(v.content, { snapshots: snapshotsForManifest(db, current.entries), asOf: asOfDate() }) : v.checks
    for (const f of checksNow.findings.filter((x) => x.severity === 'BLOCKING')) reasons.push({ code: `CHECK_${f.code}`, message: `${f.target}: ${f.message}` })
    const judgments = effectiveJudgments(v.content)
    for (const c of v.content.claims.filter((x) => x.kind === 'fact')) {
      const j = judgments[c.id].current
      if (!j) reasons.push({ code: 'UNJUDGED_CLAIM', message: `${c.id} has no reviewer support judgment.` })
      else if (j.support !== 'SUPPORTS') reasons.push({ code: 'CLAIM_NOT_SUPPORTED', message: `${c.id} judged ${j.support} by ${j.reviewer}.` })
    }
    return { ready: reasons.length === 0, reasons }
  }

  function createVersion({ candidateId, parentVersionId = null, runId = null, actorId, content, stripped = [], manifestEntries, manifestHash, note = null, opId = null }) {
    const snapshots = snapshotsForManifest(db, manifestEntries)
    const checks = runChecks(content, { snapshots, asOf: asOfDate(), strippedFields: stripped })
    const digest = hashOf(content)
    const current = currentManifest(db)
    const state = manifestHash !== current.hash ? 'STALE' : checks.summary.blocking > 0 ? 'DRAFT' : 'NEEDS_REVIEW'
    const versionNo = (db.prepare('SELECT MAX(version_no) AS n FROM candidate_versions WHERE candidate_id = ?').get(candidateId).n ?? 0) + 1
    const versionId = newId('ver')
    db.prepare(
      `INSERT INTO candidate_versions (version_id, candidate_id, version_no, parent_version_id, run_id, created_by, created_at, content_json, digest, manifest_hash, source_manifest_json, checks_json, state, edit_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(versionId, candidateId, versionNo, parentVersionId, runId, actorId, nowIso(), JSON.stringify(content), digest, manifestHash, JSON.stringify(manifestEntries), JSON.stringify(checks), state, note)
    db.prepare('UPDATE candidates SET latest_version_id = ? WHERE candidate_id = ?').run(versionId, candidateId)
    appendEvent(db, {
      actor: actorId, operation: parentVersionId && !runId ? 'edit_version' : 'create_version', opId, subject: candidateId, priorRef: parentVersionId, newRef: versionId,
      result: state, details: { versionNo, digest, manifestHash, blocking: checks.summary.blocking, warnings: checks.summary.warning, stripped }
    })
    return { versionId, versionNo, state, digest, checks }
  }

  function markStale(actorId, opId, reason) {
    const current = currentManifest(db)
    const rows = db.prepare("SELECT version_id, candidate_id, state, manifest_hash FROM candidate_versions WHERE state NOT IN ('STALE', 'REJECTED') AND manifest_hash != ?").all(current.hash)
    for (const r of rows) {
      db.prepare("UPDATE candidate_versions SET state = 'STALE' WHERE version_id = ?").run(r.version_id)
      appendEvent(db, { actor: actorId, operation: 'mark_stale', opId, subject: r.candidate_id, priorRef: r.version_id, newRef: r.version_id, result: 'STALE', details: { previousState: r.state, versionManifestHash: r.manifest_hash, currentManifestHash: current.hash, reason } })
    }
    return rows.map((r) => ({ versionId: r.version_id, previousState: r.state }))
  }

  // ---------- public API
  const api = {
    db,
    close: () => db.close(),
    userForToken: (t) => userForToken(db, t),
    users: () => DEMO_USERS.map(({ token, ...u }) => ({ ...u, demoToken: token })),
    asOf: asOfDate,

    overview() {
      const current = currentManifest(db)
      const candidates = db.prepare('SELECT * FROM candidates ORDER BY created_at').all().map((c) => {
        const v = c.latest_version_id ? parseVersion(versionRow(c.latest_version_id)) : null
        return { candidateId: c.candidate_id, title: c.title, objective: c.objective, latestVersionId: c.latest_version_id, latestState: v?.state, latestVersionNo: v?.versionNo }
      })
      return {
        asOf: asOfDate(), manifest: current, candidates, codeRevision: codeRevision(),
        providers: { fixture: true, baseline: true, anthropic: anthropicAvailable() },
        audit: verifyChain(db)
      }
    },

    listSources: () => listSnapshots(db),
    getSource: (snapshotId) => getSnapshot(db, snapshotId) ?? fail(404, 'NOT_FOUND', `Snapshot ${snapshotId} not found.`),
    activeSources: () => activeSnapshots(db),

    importSource(actor, { opId, source }) {
      return runOp(db, { opId, kind: 'import_source', actor, request: { source }, permission: 'import_source', subject: source?.sourceId }, () => {
        const { snapshot, created, supersedes } = importSnapshot(db, source, actor.userId)
        let stale = []
        if (created) {
          appendEvent(db, { actor: actor.userId, operation: 'import_source', opId, subject: snapshot.sourceId, priorRef: supersedes, newRef: snapshot.snapshotId, result: 'IMPORTED', details: { contentHash: snapshot.contentHash, accessLabel: snapshot.accessLabel } })
          stale = markStale(actor.userId, opId, supersedes ? `${supersedes} superseded by ${snapshot.snapshotId}` : `new source ${snapshot.snapshotId} added`)
        }
        return { status: created ? 201 : 200, body: { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, created, supersedes, manifestHash: currentManifest(db).hash, markedStale: stale } }
      })
    },

    // Generation is two-phase: reserve + record the run (transaction), call the
    // generator (outside any transaction, may be slow), then persist the
    // version and complete the operation (transaction).
    async startRun(actor, { opId, candidateId = null, objective, provider = 'fixture', faults, model, expectedManifestHash } = {}) {
      const request = { candidateId, objective, provider, faults: faults ?? null, model: model ?? null, expectedManifestHash: expectedManifestHash ?? null }
      const kind = 'start_run'
      const requestHash = hashOf({ kind, request })
      let phase1
      try {
        phase1 = tx(db, () => {
          const res = reserveOp(db, { opId, kind, actor, request })
          if (res.done) return { done: res.done }
          if (res.pending) return { pending: true }
          requirePermission(actor, 'generate')
          const config = runConfig(provider, { faults, model })
          const current = currentManifest(db)
          if (expectedManifestHash && expectedManifestHash !== current.hash) {
            fail(409, 'STALE_CONFLICT', 'Sources changed since you loaded them; reload and start the run against the current manifest.', { expectedManifestHash, currentManifestHash: current.hash })
          }
          if (current.entries.length === 0) fail(422, 'NO_SOURCES', 'Import sources before starting a run.')
          let cid = candidateId
          if (cid) candidateRow(cid)
          else {
            if (!objective || !objective.trim()) fail(422, 'OBJECTIVE_REQUIRED', 'An objective is required for a new candidate.')
            cid = newId('cand')
            db.prepare('INSERT INTO candidates (candidate_id, title, objective, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(cid, 'PSK-7 inspection procedure', objective.trim(), actor.userId, nowIso())
          }
          const obj = objective?.trim() || candidateRow(cid).objective
          const retrieval = retrieve(db, current.entries)
          const ctx = { objective: obj, asOf: asOfDate(), passages: retrieval.passages, sources: retrieval.sources }
          const runId = newId('run')
          const configHash = hashOf(config)
          db.prepare(
            `INSERT INTO runs (run_id, candidate_id, status, mode, provider, config_json, config_hash, source_manifest_json, manifest_hash, context_json, started_by, started_at)
             VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(runId, cid, config.mode, provider, JSON.stringify({ ...config, codeRevision: codeRevision() }), configHash, JSON.stringify(current.entries), current.hash,
            JSON.stringify({ ...ctx, retrieval: { ...RETRIEVAL_CONFIG, included: retrieval.included, excluded: retrieval.excluded } }), actor.userId, nowIso())
          appendEvent(db, { actor: actor.userId, operation: 'start_run', opId, subject: cid, newRef: runId, result: 'RUNNING', details: { mode: config.mode, configHash, manifestHash: current.hash, excluded: retrieval.excluded } })
          return { runId, cid, ctx, config, manifest: current }
        })
      } catch (err) {
        if (err instanceof WorkbenchError && err.code !== 'OP_ID_REUSED') recordRejection(db, { opId, kind, actor, requestHash, err })
        throw err
      }
      if (phase1.done) return phase1.done
      if (phase1.pending) return { status: 202, body: { status: 'RUNNING', message: 'This operation is still in progress.' }, replayed: true }

      const { runId, cid, ctx, config, manifest } = phase1
      inFlight.add(runId)
      const t0 = performance.now()
      let output = null
      let usage = null
      let error = null
      try {
        if (provider === 'fixture') output = generateFixture(ctx, { faults: config.faults })
        else if (provider === 'baseline') output = generateBaseline(ctx)
        else if (simulateLiveOutage) {
          throw Object.assign(new Error('Simulated provider outage (evaluation fault injection).'), { code: 'PROVIDER_UNAVAILABLE' })
        } else {
          const r = await generateAnthropic(ctx, { model: config.model })
          output = r.output
          usage = r.usage
        }
      } catch (e) {
        error = { code: e.code || 'PROVIDER_ERROR', message: e.message }
      }
      const latencyMs = Math.round(performance.now() - t0)
      inFlight.delete(runId)

      const result = tx(db, () => {
        if (error) {
          db.prepare("UPDATE runs SET status = 'FAILED', error = ?, latency_ms = ?, finished_at = ? WHERE run_id = ?").run(JSON.stringify(error), latencyMs, nowIso(), runId)
          appendEvent(db, { actor: actor.userId, operation: 'finish_run', opId, subject: cid, newRef: runId, result: 'FAILED', details: error })
          const body = { error: 'RUN_FAILED', message: error.message, details: { runId, providerError: error.code, mode: config.mode, note: 'No fixture substitution was made.' } }
          completeOp(db, opId, 'REJECTED', 502, body)
          return { status: 502, body }
        }
        const { content, stripped } = normalizeContent(output)
        db.prepare("UPDATE runs SET status = 'SUCCEEDED', output_json = ?, stripped_json = ?, usage_json = ?, latency_ms = ?, finished_at = ? WHERE run_id = ?")
          .run(JSON.stringify(output), JSON.stringify(stripped), JSON.stringify(usage), latencyMs, nowIso(), runId)
        appendEvent(db, { actor: actor.userId, operation: 'finish_run', opId, subject: cid, newRef: runId, result: 'SUCCEEDED', details: { latencyMs, stripped } })
        const parent = candidateRow(cid).latest_version_id
        const v = createVersion({ candidateId: cid, parentVersionId: parent, runId, actorId: actor.userId, content, stripped, manifestEntries: manifest.entries, manifestHash: manifest.hash, opId })
        const body = { runId, candidateId: cid, versionId: v.versionId, versionNo: v.versionNo, state: v.state, mode: config.mode, blocking: v.checks.summary.blocking, latencyMs }
        completeOp(db, opId, 'COMMITTED', 201, body)
        return { status: 201, body }
      })
      maybeCrash(kind)
      if (result.status >= 400) throw new WorkbenchError(result.status, result.body.error, result.body.message, result.body.details)
      return { ...result, replayed: false }
    },

    listRuns() {
      return db.prepare('SELECT run_id, candidate_id, status, mode, provider, config_hash, manifest_hash, error, latency_ms, started_by, started_at, finished_at, usage_json FROM runs ORDER BY started_at DESC').all()
        .map((r) => ({ runId: r.run_id, candidateId: r.candidate_id, status: r.status, mode: r.mode, provider: r.provider, configHash: r.config_hash, manifestHash: r.manifest_hash, error: r.error ? JSON.parse(r.error) : null, latencyMs: r.latency_ms, startedBy: userName(r.started_by), startedAt: r.started_at, finishedAt: r.finished_at, usage: r.usage_json ? JSON.parse(r.usage_json) : null }))
    },

    getRun(runId) {
      const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) ?? fail(404, 'NOT_FOUND', `Run ${runId} not found.`)
      return {
        runId: r.run_id, candidateId: r.candidate_id, status: r.status, mode: r.mode, provider: r.provider, config: JSON.parse(r.config_json), configHash: r.config_hash,
        sourceManifest: JSON.parse(r.source_manifest_json), manifestHash: r.manifest_hash, context: r.context_json ? JSON.parse(r.context_json) : null,
        rawOutput: r.output_json ? JSON.parse(r.output_json) : null, strippedFields: r.stripped_json ? JSON.parse(r.stripped_json) : [], error: r.error ? JSON.parse(r.error) : null,
        usage: r.usage_json ? JSON.parse(r.usage_json) : null, latencyMs: r.latency_ms, startedBy: userName(r.started_by), startedAt: r.started_at, finishedAt: r.finished_at
      }
    },

    getCandidate(candidateId) {
      const c = candidateRow(candidateId)
      const versions = db.prepare('SELECT version_id, version_no, state, digest, manifest_hash, run_id, parent_version_id, created_by, created_at, edit_note FROM candidate_versions WHERE candidate_id = ? ORDER BY version_no').all(candidateId)
      return {
        candidateId, title: c.title, objective: c.objective, latestVersionId: c.latest_version_id,
        versions: versions.map((v) => ({ versionId: v.version_id, versionNo: v.version_no, state: v.state, digest: v.digest, manifestHash: v.manifest_hash, runId: v.run_id, parentVersionId: v.parent_version_id, createdBy: userName(v.created_by), createdAt: v.created_at, editNote: v.edit_note, isLatest: v.version_id === c.latest_version_id }))
      }
    },

    getVersion(versionId) {
      const v = parseVersion(versionRow(versionId))
      const current = currentManifest(db)
      const run = v.runId ? db.prepare('SELECT mode, provider, config_hash FROM runs WHERE run_id = ?').get(v.runId) : null
      const origin = v.runId ? run : db.prepare('SELECT r.mode, r.provider, r.config_hash FROM candidate_versions cv JOIN runs r ON r.run_id = cv.run_id WHERE cv.candidate_id = ? AND cv.version_no < ? AND cv.run_id IS NOT NULL ORDER BY cv.version_no DESC LIMIT 1').get(v.candidateId, v.versionNo)
      return {
        ...v,
        createdByName: userName(v.createdBy),
        isLatest: candidateRow(v.candidateId).latest_version_id === v.versionId,
        integrity: { digestMatches: hashOf(v.content) === v.digest },
        generation: origin ? { mode: origin.mode, provider: origin.provider, configHash: origin.config_hash, via: v.runId ? 'run' : 'reviewer edit of a generated version' } : null,
        currentManifestHash: current.hash,
        judgments: effectiveJudgments(v.content),
        decisions: decisionsFor(v, current),
        readiness: acceptReadiness(v, current)
      }
    },

    diff(aId, bId) {
      const a = parseVersion(versionRow(aId))
      const b = parseVersion(versionRow(bId))
      const index = (arr) => new Map(arr.map((x) => [x.id, x]))
      const cmp = (A, B, key) => {
        const ia = index(A)
        const ib = index(B)
        const out = []
        for (const [id, x] of ib) {
          const y = ia.get(id)
          if (!y) out.push({ id, change: 'added', after: x })
          else if (key(y) !== key(x)) out.push({ id, change: 'changed', before: y, after: x })
        }
        for (const [id, y] of ia) if (!ib.has(id)) out.push({ id, change: 'removed', before: y })
        return out
      }
      return {
        from: { versionId: a.versionId, versionNo: a.versionNo, digest: a.digest, manifestHash: a.manifestHash },
        to: { versionId: b.versionId, versionNo: b.versionNo, digest: b.digest, manifestHash: b.manifestHash },
        steps: cmp(a.content.steps, b.content.steps, (s) => hashOf(s)),
        claims: cmp(a.content.claims, b.content.claims, claimDigest),
        missingEvidence: cmp(a.content.missingEvidence, b.content.missingEvidence, (x) => hashOf(x)),
        conflicts: cmp(a.content.conflicts, b.content.conflicts, (x) => hashOf(x)),
        sources: manifestDelta(a.sourceManifest, b.sourceManifest)
      }
    },

    // Which conclusions of a version need reassessment against the current sources.
    impact(versionId) {
      const v = parseVersion(versionRow(versionId))
      const current = currentManifest(db)
      const delta = manifestDelta(v.sourceManifest, current.entries)
      const touched = new Set([...delta.changed, ...delta.added, ...delta.removed].map((x) => x.sourceId))
      const passageChanges = delta.changed.map((c) => {
        const before = getSnapshot(db, c.from)
        const after = getSnapshot(db, c.to)
        const ids = [...new Set([...before.passages.map((p) => p.id), ...after.passages.map((p) => p.id)])]
        const changes = ids.map((id) => {
          const b = before.passages.find((p) => p.id === id)
          const a = after.passages.find((p) => p.id === id)
          return { passageId: id, change: !b ? 'added' : !a ? 'removed' : b.text === a.text ? 'unchanged' : 'changed', before: b?.text ?? null, after: a?.text ?? null }
        }).filter((x) => x.change !== 'unchanged')
        const structuredChanges = Object.keys({ ...before.structured, ...after.structured }).filter((k) => JSON.stringify(before.structured[k]) !== JSON.stringify(after.structured[k])).map((k) => ({ field: k, before: before.structured[k], after: after.structured[k] }))
        return { ...c, passages: changes, structured: structuredChanges }
      })
      const recheck = runChecks(v.content, { snapshots: snapshotsForManifest(db, current.entries), asOf: asOfDate() })
      const oldCodes = new Map(v.checks.findings.map((f) => [`${f.code}|${f.target}`, f]))
      const newCodes = new Map(recheck.findings.map((f) => [`${f.code}|${f.target}`, f]))
      const checkChanges = [
        ...[...newCodes].filter(([k]) => !oldCodes.has(k)).map(([, f]) => ({ change: 'new', ...f })),
        ...[...oldCodes].filter(([k]) => !newCodes.has(k)).map(([, f]) => ({ change: 'resolved', ...f }))
      ]
      const computedChanges = Object.keys(v.checks.computed).map((cid) => ({ claimId: cid, before: v.checks.computed[cid], after: recheck.computed[cid] })).filter((x) => x.before?.result !== x.after?.result || x.before?.text !== x.after?.text)
      const judgments = effectiveJudgments(v.content)
      const changedPassage = new Map()
      for (const c of passageChanges) for (const pc of c.passages) changedPassage.set(`${c.from}#${pc.passageId}`, pc.change)
      const affectedClaims = v.content.claims.map((c) => {
        const reasons = []
        let severity = null
        for (const e of c.evidence) {
          const sid = e.snapshotId.split('@')[0]
          if (!touched.has(sid)) continue
          const pc = changedPassage.get(`${e.snapshotId}#${e.passageId}`)
          if (pc) { reasons.push(`cited passage ${e.snapshotId} ${e.passageId} was ${pc} in the new revision`); severity = 'REASSESS' }
          else { reasons.push(`${e.snapshotId} was revised; cited passage ${e.passageId} is textually unchanged (re-confirm)`); severity = severity ?? 'RECONFIRM' }
        }
        if (c.kind === 'computed') {
          const deps = (v.checks.claimDeps[c.id] || []).filter((s) => touched.has(s))
          const viaCheck = computedChanges.find((x) => x.claimId === c.id)
          if (viaCheck) { reasons.push(`computed from ${deps.join(', ') || 'changed inputs'}: ${viaCheck.before?.result} -> ${viaCheck.after?.result ?? 'UNKNOWN'}`); severity = 'REASSESS' }
          else if (deps.length) { reasons.push(`computed from ${deps.join(', ')}, which changed; result unchanged (re-confirm)`); severity = severity ?? 'RECONFIRM' }
        }
        return { claimId: c.id, kind: c.kind, text: c.text, severity, reasons, judgment: judgments[c.id].current }
      }).filter((x) => x.reasons.length)
      const affectedIds = new Set(affectedClaims.map((c) => c.claimId))
      const affectedSteps = v.content.steps.filter((s) => s.claimIds.some((id) => affectedIds.has(id))).map((s) => ({ stepId: s.id, text: s.text, claimIds: s.claimIds.filter((id) => affectedIds.has(id)) }))
      const unaffectedClaims = v.content.claims.filter((c) => !affectedIds.has(c.id)).map((c) => c.id)
      return {
        versionId, versionState: v.state, versionManifestHash: v.manifestHash, currentManifestHash: current.hash, upToDate: v.manifestHash === current.hash,
        sources: { ...delta, changed: passageChanges }, affectedClaims, affectedSteps, unaffectedClaims, checkChanges, computedChanges,
        decisions: decisionsFor(v, current)
      }
    },

    editVersion(actor, versionId, { opId, content: rawContent, note, expectedDigest }) {
      return runOp(db, { opId, kind: 'edit_version', actor, request: { versionId, content: rawContent, note, expectedDigest }, permission: 'edit', subject: versionId }, () => {
        const v = parseVersion(versionRow(versionId))
        const current = currentManifest(db)
        if (candidateRow(v.candidateId).latest_version_id !== versionId) fail(409, 'NOT_LATEST_VERSION', 'Edit the latest version.')
        if (!expectedDigest || expectedDigest !== v.digest) fail(409, 'STALE_CONFLICT', 'The version changed since you loaded it.', { expectedDigest, actualDigest: v.digest })
        if (v.manifestHash !== current.hash) fail(409, 'STALE_CONFLICT', 'Sources changed since this version was generated; regenerate instead of editing.', { versionManifestHash: v.manifestHash, currentManifestHash: current.hash })
        if (!note || !note.trim()) fail(422, 'NOTE_REQUIRED', 'Describe the edit.')
        const { content, stripped } = normalizeContent(rawContent)
        if (hashOf(content) === v.digest) fail(422, 'NO_CHANGE', 'The edited content is identical to the current version.')
        const created = createVersion({ candidateId: v.candidateId, parentVersionId: versionId, actorId: actor.userId, content, stripped, manifestEntries: v.sourceManifest, manifestHash: v.manifestHash, note: note.trim(), opId })
        return { status: 201, body: { versionId: created.versionId, versionNo: created.versionNo, state: created.state, digest: created.digest, parentVersionId: versionId } }
      })
    },

    judge(actor, versionId, { opId, judgments }) {
      return runOp(db, { opId, kind: 'judge_claims', actor, request: { versionId, judgments }, permission: 'judge', subject: versionId }, () => {
        const v = parseVersion(versionRow(versionId))
        const current = currentManifest(db)
        if (v.manifestHash !== current.hash || v.state === 'STALE') fail(409, 'STALE_CONFLICT', 'Sources changed; judge the regenerated version.')
        if (!Array.isArray(judgments) || judgments.length === 0) fail(422, 'NO_JUDGMENTS', 'Provide at least one judgment.')
        const saved = []
        for (const j of judgments) {
          const c = v.content.claims.find((x) => x.id === j.claimId) ?? fail(422, 'UNKNOWN_CLAIM', `Claim ${j.claimId} is not in ${versionId}.`)
          if (c.kind !== 'fact') fail(422, 'NOT_A_FACT_CLAIM', `${c.id} is ${c.kind}; only fact claims take support judgments.`)
          if (!SUPPORT_VALUES.includes(j.support)) fail(422, 'INVALID_SUPPORT', `support must be one of ${SUPPORT_VALUES.join(', ')}.`)
          if (j.support === 'SUPPORTS' && v.checks.links[c.id].some((l) => l.status !== 'RESOLVED')) {
            fail(422, 'UNRESOLVED_CITATION', `${c.id} has a citation that does not resolve; it cannot be judged as supported.`)
          }
          const id = newId('jdg')
          db.prepare('INSERT INTO support_judgments (judgment_id, claim_digest, claim_id, version_id, reviewer_id, support, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, claimDigest(c), c.id, versionId, actor.userId, j.support, j.note ?? null, nowIso())
          saved.push({ judgmentId: id, claimId: c.id, support: j.support })
        }
        appendEvent(db, { actor: actor.userId, operation: 'judge_claims', opId, subject: v.candidateId, newRef: versionId, result: 'RECORDED', details: { judgments: saved } })
        return { status: 201, body: { saved } }
      })
    },

    // The acceptance gate. Everything is re-derived inside one IMMEDIATE
    // transaction; the client only names the decision and what it looked at.
    decide(actor, versionId, { opId, decision, rationale, expectedDigest, expectedManifestHash, ...rest }) {
      return runOp(db, { opId, kind: 'decide', actor, request: { versionId, decision, rationale, expectedDigest, expectedManifestHash }, permission: 'decide', subject: versionId }, () => {
        const v = parseVersion(versionRow(versionId))
        const current = currentManifest(db)
        if (!DECISIONS.includes(decision)) fail(422, 'INVALID_DECISION', `decision must be one of ${DECISIONS.join(', ')}.`, { ignoredFields: Object.keys(rest) })
        if (!rationale || !rationale.trim()) fail(422, 'RATIONALE_REQUIRED', 'A rationale is required for every decision.')
        if (!expectedDigest || !expectedManifestHash) fail(422, 'BINDING_REQUIRED', 'Send the candidate digest and manifest hash you reviewed.')
        if (expectedDigest !== v.digest || hashOf(v.content) !== v.digest) fail(409, 'STALE_CONFLICT', 'The candidate you reviewed is not this exact version.', { expectedDigest, actualDigest: v.digest })
        if (expectedManifestHash !== current.hash || v.manifestHash !== current.hash) {
          fail(409, 'STALE_CONFLICT', 'Sources changed after you loaded this version. Your decision was not recorded.', {
            reviewedManifestHash: expectedManifestHash, versionManifestHash: v.manifestHash, currentManifestHash: current.hash, delta: manifestDelta(v.sourceManifest, current.entries), versionNeedingReview: versionId
          })
        }
        if (v.state === 'STALE' || v.state === 'REJECTED') fail(409, `VERSION_${v.state}`, `Version is ${v.state}.`)
        if (candidateRow(v.candidateId).latest_version_id !== versionId) fail(409, 'NOT_LATEST_VERSION', 'Decide on the latest version.')
        let newState = v.state
        if (decision === 'ACCEPT_FOR_DEMO') {
          const readiness = acceptReadiness(v, current)
          if (!readiness.ready) fail(409, 'REVIEW_BLOCKED', 'Acceptance is blocked.', { reasons: readiness.reasons })
          newState = 'REVIEWED_FOR_DEMO'
        } else if (decision === 'REJECT') newState = 'REJECTED'
        else newState = 'DRAFT'
        const decisionId = newId('dec')
        db.prepare('INSERT INTO review_decisions (decision_id, version_id, candidate_digest, manifest_hash, reviewer_id, decision, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(decisionId, versionId, v.digest, current.hash, actor.userId, decision, rationale.trim(), nowIso())
        db.prepare('UPDATE candidate_versions SET state = ? WHERE version_id = ?').run(newState, versionId)
        appendEvent(db, { actor: actor.userId, operation: 'decide', opId, subject: v.candidateId, priorRef: versionId, newRef: decisionId, result: decision, details: { from: v.state, to: newState, digest: v.digest, manifestHash: current.hash } })
        return { status: 201, body: { decisionId, decision, versionId, state: newState, candidateDigest: v.digest, manifestHash: current.hash } }
      })
    },

    revoke(actor, decisionId, { opId, reason }) {
      return runOp(db, { opId, kind: 'revoke_decision', actor, request: { decisionId, reason }, permission: 'revoke', subject: decisionId }, () => {
        const d = db.prepare('SELECT * FROM review_decisions WHERE decision_id = ?').get(decisionId) ?? fail(404, 'NOT_FOUND', `Decision ${decisionId} not found.`)
        if (d.revoked_at) fail(409, 'ALREADY_REVOKED', 'Decision is already revoked.')
        if (d.decision !== 'ACCEPT_FOR_DEMO') fail(422, 'NOT_REVOCABLE', 'Only acceptances are revoked; record a new decision instead.')
        if (!reason || !reason.trim()) fail(422, 'REASON_REQUIRED', 'A reason is required.')
        db.prepare('UPDATE review_decisions SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE decision_id = ?').run(nowIso(), actor.userId, reason.trim(), decisionId)
        const v = versionRow(d.version_id)
        const stillAccepted = db.prepare("SELECT 1 FROM review_decisions WHERE version_id = ? AND decision = 'ACCEPT_FOR_DEMO' AND revoked_at IS NULL").get(d.version_id)
        let state = v.state
        if (v.state === 'REVIEWED_FOR_DEMO' && !stillAccepted) {
          state = 'NEEDS_REVIEW'
          db.prepare('UPDATE candidate_versions SET state = ? WHERE version_id = ?').run(state, d.version_id)
        }
        appendEvent(db, { actor: actor.userId, operation: 'revoke_decision', opId, subject: v.candidate_id, priorRef: decisionId, newRef: d.version_id, result: 'REVOKED', details: { reason: reason.trim(), versionState: state } })
        return { status: 200, body: { decisionId, revoked: true, versionId: d.version_id, versionState: state } }
      })
    },

    exportVersion(actor, versionId, { opId, mode = 'draft' }) {
      return runOp(db, { opId, kind: 'export', actor, request: { versionId, mode }, permission: 'export', subject: versionId }, () => {
        if (!['draft', 'reviewed'].includes(mode)) fail(422, 'INVALID_MODE', 'mode must be draft or reviewed.')
        const v = parseVersion(versionRow(versionId))
        const current = currentManifest(db)
        let decision = null
        if (mode === 'reviewed') {
          const all = db.prepare("SELECT * FROM review_decisions WHERE version_id = ? AND decision = 'ACCEPT_FOR_DEMO' ORDER BY created_at DESC").all(versionId)
          const statuses = all.map((d) => ({ d, s: decisionStatus(d, v, current) }))
          const valid = statuses.find((x) => x.s.valid)
          const checksNow = runChecks(v.content, { snapshots: snapshotsForManifest(db, current.entries), asOf: asOfDate() })
          const blocking = checksNow.findings.filter((f) => f.severity === 'BLOCKING')
          if (!valid || v.state !== 'REVIEWED_FOR_DEMO' || blocking.length) {
            fail(409, 'EXPORT_BLOCKED', 'No valid review decision applies to this exact version and the current sources.', {
              state: v.state,
              decisions: statuses.map((x) => ({ decisionId: x.d.decision_id, reviewer: userName(x.d.reviewer_id), reasons: x.s.reasons.map((r) => r.message) })),
              blockingChecks: blocking.map((f) => `${f.code}: ${f.message}`)
            })
          }
          decision = valid.d
        }
        // An edited version has no run of its own; report the run it descends from.
        let originRunId = v.runId
        for (let p = v.parentVersionId; !originRunId && p;) {
          const pr = db.prepare('SELECT run_id, parent_version_id FROM candidate_versions WHERE version_id = ?').get(p)
          originRunId = pr?.run_id
          p = pr?.parent_version_id
        }
        const doc = renderExport(v, { mode, decision, reviewerName: decision ? userName(decision.reviewer_id) : null, judgments: effectiveJudgments(v.content), run: originRunId ? api.getRun(originRunId) : null, edited: !v.runId, current })
        const exportId = newId('exp')
        const contentHash = hashOf(doc)
        db.prepare('INSERT INTO exports (export_id, version_id, mode, decision_id, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(exportId, versionId, mode, decision?.decision_id ?? null, contentHash, actor.userId, nowIso())
        appendEvent(db, { actor: actor.userId, operation: 'export', opId, subject: v.candidateId, priorRef: versionId, newRef: exportId, result: mode === 'reviewed' ? 'EXPORTED_REVIEWED' : 'EXPORTED_DRAFT', details: { contentHash, state: v.state } })
        return { status: 201, body: { exportId, contentHash, ...doc } }
      })
    },

    events: (opts) => listEvents(db, opts),
    verifyAudit: () => verifyChain(db)
  }
  return api
}

function renderExport(v, { mode, decision, reviewerName, judgments, run, edited, current }) {
  const banner = mode === 'reviewed'
    ? `REVIEWED FOR DEMO by ${reviewerName} at ${decision.created_at}. Prototype review status only: not an approval, publication or authorization.`
    : `UNREVIEWED DRAFT - NOT APPROVED. Current state: ${v.state}. Do not use as a procedure.`
  const gen = run ? `${run.mode} (${run.config.model}; prompt ${run.config.promptVersion}; config ${shortHash(run.configHash)}; run ${run.runId})${edited ? ', then edited by a reviewer' : ''}` : 'unknown'
  const lines = [`# ${v.content.title}`, '', `> ${banner}`, '', `- Version: ${v.versionId} (v${v.versionNo}), digest ${shortHash(v.digest)}`, `- Source manifest: ${shortHash(v.manifestHash)}${v.manifestHash === current.hash ? ' (current)' : ' (NOT current)'}`, `- Generation: ${gen}`, `- Objective: ${v.content.objective}`, '', '## Steps', '']
  const claims = new Map(v.content.claims.map((c) => [c.id, c]))
  for (const s of v.content.steps) {
    lines.push(`${s.id}. ${s.text}`)
    if (s.decisionPoint) lines.push(`   - Decision point: ${s.decisionPoint.condition}? If not: ${s.decisionPoint.ifFalse}`)
    for (const cid of s.claimIds) {
      const c = claims.get(cid)
      if (!c) continue
      const comp = v.checks.computed[cid]
      const j = judgments[cid]?.current
      lines.push(`   - [${cid}, ${c.kind}] ${comp ? comp.text : c.text}${j ? ` (reviewer: ${j.support})` : c.kind === 'fact' ? ' (not yet judged)' : ''}`)
      for (const l of v.checks.links[cid] || []) lines.push(`     - ${l.snapshotId} ${l.passageId}: "${l.quote}" [${l.status}]`)
    }
  }
  const section = (title, arr, fmt) => { if (arr.length) { lines.push('', `## ${title}`, ''); for (const x of arr) lines.push(fmt(x)) } }
  section('Assumptions', v.content.assumptions, (a) => `- ${a.id}: ${a.text}`)
  section('Open questions', v.content.openQuestions, (q) => `- ${q.id}: ${q.text}`)
  section('Missing evidence', v.content.missingEvidence, (m) => `- ${m.id}: ${m.text}`)
  section('Conflicts', v.content.conflicts, (x) => `- ${x.id}: ${x.text}`)
  section('Hypotheses (not established)', v.content.claims.filter((c) => c.kind === 'hypothesis'), (c) => `- ${c.id}: ${c.text}`)
  section('Blocking check findings', v.checks.findings.filter((f) => f.severity === 'BLOCKING'), (f) => `- ${f.code} (${f.target}): ${f.message}`)
  return {
    mode, banner, markdown: lines.join('\n'),
    evidenceRecord: {
      versionId: v.versionId, versionNo: v.versionNo, digest: v.digest, state: v.state, manifestHash: v.manifestHash, sourceManifest: v.sourceManifest,
      generation: run ? { runId: run.runId, mode: run.mode, config: run.config, configHash: run.configHash, editedAfterGeneration: Boolean(edited) } : null,
      claims: v.content.claims.map((c) => ({ ...c, links: v.checks.links[c.id], computed: v.checks.computed[c.id] ?? null, judgment: judgments[c.id]?.current ?? null })),
      findings: v.checks.findings,
      decision: decision ? { decisionId: decision.decision_id, reviewer: reviewerName, decision: decision.decision, rationale: decision.rationale, at: decision.created_at, candidateDigest: decision.candidate_digest, manifestHash: decision.manifest_hash } : null
    }
  }
}
