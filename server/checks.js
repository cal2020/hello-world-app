// Deterministic validation. Code owns identifiers, citation resolution, dates,
// numeric thresholds and cross-record consistency. Passing these checks means
// the draft is mechanically sound; it does not mean the claims are true. That
// judgment belongs to a reviewer (see review.js).
import { daysBetween } from './util.js'

export const CHECKS_VERSION = 'checks-v1'
export const INJECTION_RE = /(ignore (all )?previous|mark this procedure approved|^system:)/i

const CONTENT_FIELDS = ['title', 'objective', 'steps', 'claims', 'assumptions', 'openQuestions', 'missingEvidence', 'conflicts']
const CLAIM_KINDS = new Set(['fact', 'hypothesis', 'computed'])

// Model output is untrusted. Keep only the fields the candidate schema defines;
// anything else (for example "approved": true) is dropped and reported.
export function normalizeContent(raw) {
  const stripped = []
  const content = {}
  for (const k of Object.keys(raw || {})) if (!CONTENT_FIELDS.includes(k)) stripped.push(k)
  content.title = String(raw?.title ?? 'Untitled candidate')
  content.objective = String(raw?.objective ?? '')
  const arr = (v) => (Array.isArray(v) ? v : [])
  content.steps = arr(raw?.steps).map((s) => {
    const step = { id: String(s?.id ?? ''), text: String(s?.text ?? ''), claimIds: arr(s?.claimIds).map(String) }
    if (s?.decisionPoint && typeof s.decisionPoint === 'object') step.decisionPoint = { condition: String(s.decisionPoint.condition ?? ''), ifFalse: String(s.decisionPoint.ifFalse ?? '') }
    return step
  })
  content.claims = arr(raw?.claims).map((c) => {
    const claim = { id: String(c?.id ?? ''), kind: String(c?.kind ?? ''), text: String(c?.text ?? ''), evidence: arr(c?.evidence).map((e) => ({ snapshotId: String(e?.snapshotId ?? ''), passageId: String(e?.passageId ?? ''), quote: String(e?.quote ?? '') })) }
    if (c?.check && c.check !== 'NONE') claim.check = String(c.check)
    return claim
  })
  const simple = (v) => arr(v).map((x) => ({ id: String(x?.id ?? ''), text: String(x?.text ?? '') }))
  content.assumptions = simple(raw?.assumptions)
  content.openQuestions = simple(raw?.openQuestions)
  content.missingEvidence = arr(raw?.missingEvidence).map((x) => ({ id: String(x?.id ?? ''), about: String(x?.about ?? ''), text: String(x?.text ?? '') }))
  content.conflicts = arr(raw?.conflicts).map((x) => ({ id: String(x?.id ?? ''), text: String(x?.text ?? ''), evidence: arr(x?.evidence).map((e) => ({ snapshotId: String(e?.snapshotId ?? ''), passageId: String(e?.passageId ?? ''), quote: String(e?.quote ?? '') })) }))
  return { content, stripped }
}

// snapshots: Map<snapshotId, snapshot> for exactly the manifest the version is checked against.
export function runChecks(content, { snapshots, asOf, strippedFields = [] }) {
  const findings = []
  const add = (severity, code, target, message, extra = {}) => findings.push({ severity, code, target, message, ...extra })
  const snaps = [...snapshots.values()]
  const bySourceId = new Map(snaps.map((s) => [s.sourceId, s]))
  const claimsById = new Map()
  const links = {}
  const computed = {}
  const claimDeps = {}
  const checkDeps = {}

  // --- Structure
  const seen = new Set()
  for (const c of content.claims) {
    if (!c.id || seen.has(c.id)) add('BLOCKING', 'SCHEMA_CLAIM_ID', c.id || '(empty)', 'Claim ids must be present and unique.')
    seen.add(c.id)
    claimsById.set(c.id, c)
    if (!CLAIM_KINDS.has(c.kind)) add('BLOCKING', 'SCHEMA_CLAIM_KIND', c.id, `Claim kind '${c.kind}' is not fact, hypothesis or computed.`)
  }
  const stepIds = new Set()
  for (const s of content.steps) {
    if (!s.id || stepIds.has(s.id)) add('BLOCKING', 'SCHEMA_STEP_ID', s.id || '(empty)', 'Step ids must be present and unique.')
    stepIds.add(s.id)
    if (s.claimIds.length === 0) add('WARNING', 'STEP_WITHOUT_CLAIMS', s.id, 'Step has no supporting claims.')
    for (const cid of s.claimIds) if (!claimsById.has(cid)) add('BLOCKING', 'SCHEMA_DANGLING_CLAIM', s.id, `Step references missing claim ${cid}.`)
  }
  if (content.steps.length === 0) add('BLOCKING', 'SCHEMA_NO_STEPS', 'candidate', 'Candidate has no steps.')
  for (const f of strippedFields) add('WARNING', 'MODEL_FIELD_IGNORED', f, `Generator output field '${f}' is not part of the candidate schema and was discarded. Model output cannot set review status.`)

  // --- Citations: existence and exact quote, per evidence item
  const instructionPassages = new Set()
  for (const s of snaps) for (const p of s.passages) if (INJECTION_RE.test(p.text)) {
    instructionPassages.add(`${s.snapshotId}#${p.id}`)
    add('WARNING', 'INSTRUCTION_LIKE_SOURCE_TEXT', `${s.snapshotId}#${p.id}`, 'Source passage contains instruction-like text. It is treated as data and grants no authority.')
  }
  const resolve = (e) => {
    const snap = snapshots.get(e.snapshotId)
    if (!snap) return { status: 'OUTSIDE_MANIFEST', detail: `${e.snapshotId} is not in the source manifest being checked (superseded or never imported).` }
    if (snap.accessLabel !== 'PERMITTED') return { status: 'RESTRICTED_SOURCE', detail: `${e.snapshotId} is ${snap.accessLabel}.` }
    const p = snap.passages.find((x) => x.id === e.passageId)
    if (!p) return { status: 'MISSING_PASSAGE', detail: `${e.snapshotId} has no passage ${e.passageId}.` }
    if (!e.quote || !p.text.includes(e.quote)) return { status: 'QUOTE_MISMATCH', detail: 'Quoted text does not appear in the cited passage.' }
    const start = p.text.indexOf(e.quote)
    return { status: 'RESOLVED', detail: 'Citation resolves to the exact retained passage.', span: [start, start + e.quote.length], sourceId: snap.sourceId, contentHash: snap.contentHash }
  }
  const stepsUsing = (cid) => content.steps.filter((s) => s.claimIds.includes(cid)).map((s) => s.id)
  for (const c of content.claims) {
    links[c.id] = c.evidence.map((e) => ({ ...e, ...resolve(e) }))
    claimDeps[c.id] = [...new Set(c.evidence.map((e) => snapshots.get(e.snapshotId)?.sourceId ?? e.snapshotId.split('@')[0]))]
    for (const l of links[c.id]) {
      if (l.status !== 'RESOLVED') add('BLOCKING', `CITATION_${l.status}`, c.id, `${l.detail} (${l.snapshotId} ${l.passageId})`)
      if (instructionPassages.has(`${l.snapshotId}#${l.passageId}`)) add('BLOCKING', 'CLAIM_CITES_INSTRUCTION_TEXT', c.id, 'Claim relies on instruction-like source text.')
    }
    if (c.kind === 'fact' && c.evidence.length === 0) add('BLOCKING', 'FACT_WITHOUT_EVIDENCE', c.id, 'Fact claim has no cited evidence.')
    if (c.kind === 'hypothesis' && stepsUsing(c.id).length) add('BLOCKING', 'HYPOTHESIS_SUPPORTS_STEP', c.id, `Hypothesis is used to support ${stepsUsing(c.id).join(', ')}.`)
  }

  // --- Calibration: pick the most recent certificate by date (code, not model)
  const certs = snaps.filter((s) => s.structured?.recordType === 'calibration_certificate').sort((a, b) => b.structured.calibrationDate.localeCompare(a.structured.calibrationDate))
  const latestCert = certs[0]
  for (const c of content.claims) {
    for (const e of c.evidence) {
      const s = snapshots.get(e.snapshotId)
      if (s?.structured?.recordType === 'calibration_certificate' && latestCert && s.sourceId !== latestCert.sourceId) {
        add('BLOCKING', 'OBSOLETE_EVIDENCE', c.id, `Cites ${s.sourceId} (${s.structured.calibrationDate}); the most recent certificate is ${latestCert.sourceId} (${latestCert.structured.calibrationDate}).`)
      }
    }
  }
  const req002 = snaps.find((s) => s.structured?.reqId === 'REQ-002')
  checkDeps.CALIBRATION_CURRENT = [...(req002 ? [req002.sourceId] : []), ...certs.map((c) => c.sourceId)]
  let cal = { result: 'UNKNOWN', text: 'Calibration currency cannot be computed: requirement or certificate missing.' }
  if (req002 && latestCert) {
    const limit = req002.structured.maxCalibrationAgeDays
    const age = daysBetween(latestCert.structured.calibrationDate, asOf)
    const ok = age <= limit
    cal = {
      result: ok ? 'PASS' : 'FAIL',
      ageDays: age, limitDays: limit, certificate: latestCert.snapshotId, requirement: req002.snapshotId,
      text: `${latestCert.sourceId} dated ${latestCert.structured.calibrationDate} is ${age} days old at ${asOf}; ${req002.snapshotId} allows ${limit} days, so calibration is ${ok ? 'CURRENT' : 'NOT CURRENT (device must be tagged HOLD)'}.`
    }
  }
  const calClaims = content.claims.filter((c) => c.kind === 'computed' && c.check === 'CALIBRATION_CURRENT')
  for (const c of calClaims) {
    computed[c.id] = { check: 'CALIBRATION_CURRENT', ...cal }
    claimDeps[c.id] = [...new Set([...claimDeps[c.id], ...checkDeps.CALIBRATION_CURRENT])]
  }
  if (req002) {
    if (cal.result === 'UNKNOWN') add('BLOCKING', 'CALIBRATION_UNKNOWN', 'REQ-002', cal.text)
    else add(cal.result === 'PASS' ? 'INFO' : 'WARNING', `CALIBRATION_${cal.result}`, 'REQ-002', cal.text)
    if (calClaims.length === 0) add('WARNING', 'CALIBRATION_NOT_ADDRESSED', 'REQ-002', 'No computed calibration-currency claim; currency is not stated in the draft.')
  }
  for (const c of content.claims) if (c.kind === 'computed' && !computed[c.id]) add('BLOCKING', 'UNKNOWN_COMPUTED_CHECK', c.id, `Computed claim names unsupported check '${c.check}'.`)

  // --- Requirement coverage: every mandatory requirement cited by a step's claim
  const coverage = []
  for (const r of snaps.filter((s) => s.kind === 'requirement' && s.structured?.mandatory)) {
    const claimIds = content.claims.filter((c) => stepsUsing(c.id).length && (links[c.id] || []).some((l) => l.status === 'RESOLVED' && l.snapshotId === r.snapshotId)).map((c) => c.id)
    coverage.push({ reqId: r.structured.reqId, snapshotId: r.snapshotId, covered: claimIds.length > 0, claimIds })
    if (!claimIds.length) add('BLOCKING', 'REQUIREMENT_NOT_COVERED', r.snapshotId, `No step is supported by a resolved citation to ${r.snapshotId}.`)
  }
  checkDeps.REQUIREMENT_COVERAGE = coverage.map((c) => c.snapshotId.split('@')[0])

  // --- Source-record checks the draft cannot waive
  const model = snaps.find((s) => s.kind === 'system_model')
  const log = snaps.find((s) => s.structured?.recordType === 'inspection_log')
  const asset = snaps.find((s) => s.structured?.recordType === 'asset_register')
  const recordGaps = []
  if (model) {
    checkDeps.INSPECTION_OBSERVATIONS = [model.sourceId, ...(log ? [log.sourceId] : [])]
    for (const el of model.structured.elements.filter((e) => e.type === 'InspectionPoint')) {
      if (!log?.structured.observations?.some((o) => o.point === el.id)) {
        recordGaps.push(el.id)
        add('BLOCKING', 'MISSING_OBSERVATION', el.id, `No observation for ${el.id} (${el.name}) in ${log ? log.snapshotId : 'any inspection log'}.`)
      }
    }
  }
  const recordConflicts = []
  if (asset && log) {
    checkDeps.RECORD_CONSISTENCY = [asset.sourceId, log.sourceId]
    if (asset.structured.serial !== log.structured.recordedSerial) {
      recordConflicts.push('SERIAL')
      add('BLOCKING', 'RECORD_CONFLICT', 'serial', `${asset.snapshotId} lists ${asset.structured.serial}; ${log.snapshotId} records ${log.structured.recordedSerial}.`)
    }
  }

  // --- Gaps the draft itself declares: visible, and they block unconditional acceptance
  for (const m of content.missingEvidence) add('BLOCKING', 'DECLARED_MISSING_EVIDENCE', m.id, m.text)
  for (const x of content.conflicts) {
    add('BLOCKING', 'DECLARED_CONFLICT', x.id, x.text)
    links[x.id] = x.evidence.map((e) => ({ ...e, ...resolve(e) }))
  }
  for (const q of content.openQuestions) add('WARNING', 'OPEN_QUESTION', q.id, q.text)

  const summary = { blocking: 0, warning: 0, info: 0 }
  for (const f of findings) summary[f.severity.toLowerCase()]++
  const totalCitations = Object.entries(links).filter(([k]) => claimsById.has(k)).reduce((a, [, v]) => a + v.length, 0)
  const invalidCitations = Object.entries(links).filter(([k]) => claimsById.has(k)).reduce((a, [, v]) => a + v.filter((l) => l.status !== 'RESOLVED').length, 0)
  return {
    version: CHECKS_VERSION, asOf, findings, links, computed, coverage, claimDeps, checkDeps, summary,
    metrics: {
      requirementsCovered: coverage.filter((c) => c.covered).length, requirementsTotal: coverage.length,
      citationsTotal: totalCitations, citationsInvalid: invalidCitations,
      recordGaps, recordConflicts,
      declaredGaps: content.missingEvidence.map((m) => m.about), declaredConflicts: content.conflicts.length
    }
  }
}
