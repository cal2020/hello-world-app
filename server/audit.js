// Append-only audit log with a hash chain. The chain makes accidental or
// in-app rewrites detectable; it is not proof against a database administrator.
import { canonicalJson, sha256, newId, nowIso } from './util.js'

export function appendEvent(db, { actor, operation, opId = null, subject = null, priorRef = null, newRef = null, result, details = {} }) {
  const last = db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get()
  const prevHash = last ? last.hash : 'GENESIS'
  const event = { eventId: newId('evt'), at: nowIso(), actor, operation, opId, subject, priorRef, newRef, result, details }
  const hash = sha256(prevHash + canonicalJson(event))
  db.prepare(
    `INSERT INTO audit_events (event_id, at, actor, operation, op_id, subject, prior_ref, new_ref, result, details_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(event.eventId, event.at, actor, operation, opId, subject, priorRef, newRef, result, JSON.stringify(details), prevHash, hash)
  return event
}

export function listEvents(db, { subject = null, limit = 500 } = {}) {
  const rows = subject
    ? db.prepare('SELECT * FROM audit_events WHERE subject = ? OR prior_ref = ? OR new_ref = ? ORDER BY seq DESC LIMIT ?').all(subject, subject, subject, limit)
    : db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?').all(limit)
  return rows.map(rowToEvent)
}

function rowToEvent(r) {
  return {
    seq: r.seq, eventId: r.event_id, at: r.at, actor: r.actor, operation: r.operation, opId: r.op_id,
    subject: r.subject, priorRef: r.prior_ref, newRef: r.new_ref, result: r.result,
    details: JSON.parse(r.details_json || '{}'), hash: r.hash
  }
}

export function verifyChain(db) {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all()
  let prev = 'GENESIS'
  for (const r of rows) {
    const event = {
      eventId: r.event_id, at: r.at, actor: r.actor, operation: r.operation, opId: r.op_id, subject: r.subject,
      priorRef: r.prior_ref, newRef: r.new_ref, result: r.result, details: JSON.parse(r.details_json || '{}')
    }
    if (r.prev_hash !== prev || sha256(prev + canonicalJson(event)) !== r.hash) {
      return { ok: false, brokenAt: r.seq, count: rows.length }
    }
    prev = r.hash
  }
  return { ok: true, count: rows.length }
}
