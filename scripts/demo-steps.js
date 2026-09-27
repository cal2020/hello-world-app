// Shared scripted demo steps used by the reset stages, the browser-only build
// and the CLI walkthrough. Everything recorded here is labeled as scripted demo
// setup (op ids start with 'setup-'), so it is never mistaken for a human reading.
import { loadScenario, loadInbox } from '../server/fixtures.js'

export const OBJECTIVE = 'Draft a candidate inspection procedure for PSK-7 portable sensor kit device DEV-0193.'
let n = 0
export const op = (p) => `${p}-${Date.now()}-${++n}`

export function seedSources(wb, author) {
  for (const s of loadScenario()) wb.importSource(author, { opId: op('setup-seed'), source: s })
}

export async function generate(wb, author, candidateId = null) {
  return (await wb.startRun(author, { opId: op('setup-run'), candidateId, objective: OBJECTIVE, provider: 'fixture' })).body
}

export function importInbox(wb, author, name) {
  return wb.importSource(author, { opId: op('setup-import'), source: loadInbox(name) }).body
}

// Reviewer removes claims whose citations do not resolve (recording why).
export function removeUnresolved(wb, reviewer, versionId) {
  const v = wb.getVersion(versionId)
  const bad = v.content.claims.filter((c) => v.checks.links[c.id].some((l) => l.status !== 'RESOLVED'))
  if (!bad.length) return v
  wb.judge(reviewer, v.versionId, { opId: op('setup-judge'), judgments: bad.map((c) => ({ claimId: c.id, support: 'DOES_NOT_SUPPORT', note: 'Scripted demo setup: quoted text is not in the cited passage.' })) })
  const drop = new Set(bad.map((c) => c.id))
  const content = structuredClone(v.content)
  content.claims = content.claims.filter((c) => !drop.has(c.id))
  content.steps = content.steps.map((s) => ({ ...s, claimIds: s.claimIds.filter((id) => !drop.has(id)) })).filter((s) => s.claimIds.length)
  const e = wb.editVersion(reviewer, v.versionId, { opId: op('setup-edit'), content, note: 'Scripted demo setup: removed unsupported battery-cleaning step (citation does not resolve).', expectedDigest: v.digest })
  return wb.getVersion(e.body.versionId)
}

export function judgeAll(wb, reviewer, versionId) {
  const v = wb.getVersion(versionId)
  const facts = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current)
  if (facts.length) wb.judge(reviewer, versionId, { opId: op('setup-judge'), judgments: facts.map((c) => ({ claimId: c.id, support: 'SUPPORTS', note: 'Scripted demo setup (not a human reading)' })) })
  return wb.getVersion(versionId)
}

export function accept(wb, reviewer, v) {
  return wb.decide(reviewer, v.versionId, { opId: op('setup-decide'), decision: 'ACCEPT_FOR_DEMO', rationale: 'Scripted demo setup: each step traces to a current passage; calibration computed by the workbench.', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }).body
}

export const STAGES = ['sources', 'draft', 'reviewed', 'changed']

// Brings a freshly seeded workbench to a named demo stage. Used by
// scripts/reset.js, src/static/entry.js and the tests so all three agree.
//   sources   only the seeded sources (start of the live demo)
//   draft     + first generated candidate (v1)
//   reviewed  + corrected log, regenerated, edited and accepted for demo (v3)
//   changed   + REQ-002 revision B imported (v3 becomes STALE)
export async function setupStage(wb, author, reviewer, stage = 'sources') {
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage '${stage}'. Use one of: ${STAGES.join(', ')}.`)
  seedSources(wb, author)
  if (stage === 'sources') return
  const r = await generate(wb, author)
  if (stage === 'draft') return
  importInbox(wb, author, 'insp-log-rev2')
  const r2 = await generate(wb, author, r.candidateId)
  accept(wb, reviewer, judgeAll(wb, reviewer, removeUnresolved(wb, reviewer, r2.versionId).versionId))
  if (stage === 'changed') importInbox(wb, author, 'req-002-revB')
}
