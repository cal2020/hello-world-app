// Shared scripted demo steps used by the reset stages and the CLI walkthrough.
import { loadScenario, loadInbox } from '../server/fixtures.js'

export const OBJECTIVE = 'Draft a candidate inspection procedure for PSK-7 portable sensor kit device DEV-0193.'
let n = 0
export const op = (p) => `${p}-${Date.now()}-${++n}`

export function seedSources(wb, author) {
  for (const s of loadScenario()) wb.importSource(author, { opId: op('seed'), source: s })
}

export async function generate(wb, author, candidateId = null) {
  return (await wb.startRun(author, { opId: op('run'), candidateId, objective: OBJECTIVE, provider: 'fixture' })).body
}

export function importInbox(wb, author, name) {
  return wb.importSource(author, { opId: op('import'), source: loadInbox(name) }).body
}

// Reviewer removes claims whose citations do not resolve (recording why).
export function removeUnresolved(wb, reviewer, versionId) {
  const v = wb.getVersion(versionId)
  const bad = v.content.claims.filter((c) => v.checks.links[c.id].some((l) => l.status !== 'RESOLVED'))
  if (!bad.length) return v
  wb.judge(reviewer, v.versionId, { opId: op('judge'), judgments: bad.map((c) => ({ claimId: c.id, support: 'DOES_NOT_SUPPORT', note: 'Quoted text is not in the cited passage.' })) })
  const drop = new Set(bad.map((c) => c.id))
  const content = structuredClone(v.content)
  content.claims = content.claims.filter((c) => !drop.has(c.id))
  content.steps = content.steps.map((s) => ({ ...s, claimIds: s.claimIds.filter((id) => !drop.has(id)) })).filter((s) => s.claimIds.length)
  const e = wb.editVersion(reviewer, v.versionId, { opId: op('edit'), content, note: 'Removed unsupported battery-cleaning step (citation does not resolve).', expectedDigest: v.digest })
  return wb.getVersion(e.body.versionId)
}

export function judgeAll(wb, reviewer, versionId) {
  const v = wb.getVersion(versionId)
  const facts = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current)
  if (facts.length) wb.judge(reviewer, versionId, { opId: op('judge'), judgments: facts.map((c) => ({ claimId: c.id, support: 'SUPPORTS', note: 'Read cited passage.' })) })
  return wb.getVersion(versionId)
}

export function accept(wb, reviewer, v) {
  return wb.decide(reviewer, v.versionId, { opId: op('decide'), decision: 'ACCEPT_FOR_DEMO', rationale: 'Each step traces to a current passage; calibration computed by the workbench.', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }).body
}
