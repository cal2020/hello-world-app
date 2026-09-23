// Audit records for reviewer decisions. An approval binds to the exact source
// revisions it was made against; any source change makes it stale.

export function fingerprint(value) {
  // FNV-1a 32-bit over a stable JSON string. Identifies a record in the demo; not a security control.
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function createRecord({ caseId, decision, requirement, requirementRevision, evidence, judgment, checks, rationale, reviewer, reviewMs, at }) {
  const body = {
    caseId,
    decision,
    requirement: { id: requirement.id, rev: requirementRevision },
    evidence: { id: evidence.id, rev: evidence.rev },
    model: judgment?.status === 'ok' ? { version: judgment.model, source: judgment.source, choice: judgment.choice } : null,
    checks: checks.map((c) => ({ id: c.id, status: c.status })),
    rationale,
    reviewer: reviewer.name,
    reviewMs,
    at,
  }
  return { ...body, fingerprint: fingerprint(body) }
}

export function recordStatus(record, currentRevisions) {
  const reqRev = currentRevisions.requirements[record.requirement.id]
  const evRev = currentRevisions.evidence[record.evidence.id]
  if (reqRev !== record.requirement.rev || evRev !== record.evidence.rev) return 'stale'
  return 'current'
}

export function latestForCase(log, caseId) {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].caseId === caseId) return log[i]
  }
  return null
}
