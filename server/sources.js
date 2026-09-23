// Source store and retrieval.
//
// The store preserves every imported revision with its content hash. Authority
// is an explicit rule, not an inference: for each sourceId the snapshot with
// the highest revisionSeq is active, and imports must increase revisionSeq.
// Ingesting a source does not make its claims true.
import { hashOf, fail, nowIso } from './util.js'

const KINDS = new Set(['requirement', 'system_model', 'record', 'guidance'])
const ACCESS = new Set(['PERMITTED', 'RESTRICTED'])

export function validateSource(src) {
  const problems = []
  for (const f of ['sourceId', 'revision', 'kind', 'title', 'origin']) {
    if (typeof src?.[f] !== 'string' || !src[f].trim()) problems.push(`${f} is required`)
  }
  if (!Number.isInteger(src?.revisionSeq) || src.revisionSeq < 1) problems.push('revisionSeq must be a positive integer')
  if (src && !KINDS.has(src.kind)) problems.push(`kind must be one of ${[...KINDS].join(', ')}`)
  if (src && !ACCESS.has(src.accessLabel ?? 'PERMITTED')) problems.push('accessLabel must be PERMITTED or RESTRICTED')
  if (!Array.isArray(src?.passages) || src.passages.length === 0) problems.push('passages must be a non-empty array')
  const ids = new Set()
  for (const p of src?.passages ?? []) {
    if (typeof p?.id !== 'string' || typeof p?.text !== 'string' || !p.text.trim()) problems.push('each passage needs id and text')
    if (ids.has(p?.id)) problems.push(`duplicate passage id ${p?.id}`)
    ids.add(p?.id)
  }
  if (problems.length) fail(422, 'INVALID_SOURCE', 'Source failed validation.', { problems })
  return {
    sourceId: src.sourceId.trim(),
    revision: src.revision.trim(),
    revisionSeq: src.revisionSeq,
    kind: src.kind,
    title: src.title,
    origin: src.origin,
    accessLabel: src.accessLabel ?? 'PERMITTED',
    effectiveFrom: src.effectiveFrom ?? null,
    structured: src.structured ?? {},
    passages: src.passages.map((p) => ({ id: p.id, text: p.text }))
  }
}

export function snapshotIdOf(sourceId, revision) {
  return `${sourceId}@${revision}`
}

// Returns { snapshot, created }. Re-importing identical content is a no-op;
// a different payload under an existing revision, or a revision older than
// the active one, is rejected rather than silently overwriting history.
export function importSnapshot(db, rawSource, actorId) {
  const src = validateSource(rawSource)
  const contentHash = hashOf(src)
  const snapshotId = snapshotIdOf(src.sourceId, src.revision)
  const existing = db.prepare('SELECT * FROM source_snapshots WHERE source_id = ? AND (revision = ? OR revision_seq = ?)').get(src.sourceId, src.revision, src.revisionSeq)
  if (existing) {
    if (existing.content_hash === contentHash && existing.snapshot_id === snapshotId) return { snapshot: rowToSnapshot(existing), created: false }
    fail(409, 'REVISION_CONFLICT', `Revision ${src.revision} (seq ${src.revisionSeq}) of ${src.sourceId} already exists with different content.`, {
      existing: existing.snapshot_id, existingHash: existing.content_hash, attemptedHash: contentHash
    })
  }
  const active = db.prepare('SELECT snapshot_id, revision_seq FROM source_snapshots WHERE source_id = ? ORDER BY revision_seq DESC LIMIT 1').get(src.sourceId)
  if (active && src.revisionSeq < active.revision_seq) {
    fail(409, 'OUT_OF_ORDER_REVISION', `${snapshotId} is older than the active revision ${active.snapshot_id}; history is not rewritten.`, {
      active: active.snapshot_id
    })
  }
  db.prepare(
    `INSERT INTO source_snapshots (snapshot_id, source_id, revision, revision_seq, kind, title, origin, access_label, effective_from, content_json, content_hash, imported_by, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(snapshotId, src.sourceId, src.revision, src.revisionSeq, src.kind, src.title, src.origin, src.accessLabel, src.effectiveFrom, JSON.stringify(src), contentHash, actorId, nowIso())
  return { snapshot: getSnapshot(db, snapshotId), created: true, supersedes: active?.snapshot_id ?? null }
}

function rowToSnapshot(r) {
  const content = JSON.parse(r.content_json)
  return {
    snapshotId: r.snapshot_id, sourceId: r.source_id, revision: r.revision, revisionSeq: r.revision_seq, kind: r.kind,
    title: r.title, origin: r.origin, accessLabel: r.access_label, effectiveFrom: r.effective_from,
    contentHash: r.content_hash, importedBy: r.imported_by, importedAt: r.imported_at,
    structured: content.structured, passages: content.passages
  }
}

export function getSnapshot(db, snapshotId) {
  const r = db.prepare('SELECT * FROM source_snapshots WHERE snapshot_id = ?').get(snapshotId)
  return r ? rowToSnapshot(r) : null
}

export function listSnapshots(db) {
  return db.prepare('SELECT * FROM source_snapshots ORDER BY source_id, revision_seq').all().map(rowToSnapshot)
}

export function activeSnapshots(db) {
  return db.prepare(
    `SELECT s.* FROM source_snapshots s
     JOIN (SELECT source_id, MAX(revision_seq) AS seq FROM source_snapshots GROUP BY source_id) m
       ON s.source_id = m.source_id AND s.revision_seq = m.seq
     ORDER BY s.source_id`
  ).all().map(rowToSnapshot)
}

// The source manifest is the set of active snapshots and their hashes. Its
// hash is what review decisions bind to: any added or revised source changes it.
export function currentManifest(db) {
  const entries = activeSnapshots(db).map((s) => ({ snapshotId: s.snapshotId, sourceId: s.sourceId, revision: s.revision, contentHash: s.contentHash, accessLabel: s.accessLabel }))
  return { entries, hash: hashOf(entries) }
}

export function manifestHashOf(entries) {
  return hashOf(entries)
}

export function snapshotsForManifest(db, entries) {
  const map = new Map()
  for (const e of entries) map.set(e.snapshotId, getSnapshot(db, e.snapshotId))
  return map
}

// Retrieval: only PERMITTED snapshots in the manifest are eligible. The corpus
// is small, so every permitted passage is returned with its locator; the
// method is recorded on the run so an evaluation can see what the model saw.
export const RETRIEVAL_CONFIG = { method: 'permitted-manifest-all-passages', version: 'retrieval-v1' }

export function retrieve(db, manifestEntries) {
  const included = []
  const excluded = []
  const passages = []
  const sources = []
  for (const e of manifestEntries) {
    const snap = getSnapshot(db, e.snapshotId)
    if (snap.accessLabel !== 'PERMITTED') {
      excluded.push({ snapshotId: snap.snapshotId, reason: `accessLabel=${snap.accessLabel}` })
      continue
    }
    included.push(snap.snapshotId)
    sources.push({ snapshotId: snap.snapshotId, sourceId: snap.sourceId, revision: snap.revision, kind: snap.kind, title: snap.title, structured: snap.structured })
    for (const p of snap.passages) passages.push({ snapshotId: snap.snapshotId, sourceId: snap.sourceId, kind: snap.kind, passageId: p.id, text: p.text })
  }
  return { included, excluded, passages, sources }
}
