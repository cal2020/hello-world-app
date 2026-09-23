// Idempotent mutating operations and demo identities.
//
// Every mutation carries a client-generated opId. The operation row is written
// in the same transaction as the mutation, so a crash after COMMIT but before
// the HTTP response leaves a record that a retry can return instead of
// re-applying the change. Rejected operations are recorded too, so a retry of a
// denied request returns the same denial.
import { tx } from './db.js'
import { appendEvent } from './audit.js'
import { hashOf, nowIso, WorkbenchError, fail } from './util.js'

export const ROLE_PERMISSIONS = {
  viewer: new Set(['read']),
  author: new Set(['read', 'import_source', 'generate', 'edit', 'export', 'evaluate']),
  reviewer: new Set(['read', 'import_source', 'generate', 'edit', 'export', 'evaluate', 'judge', 'decide', 'revoke'])
}

// Demo identities: bearer tokens are fixed strings for a local prototype.
// This is an authorization-boundary demonstration, not authentication.
export const DEMO_USERS = [
  { userId: 'u_alvarez', name: 'R. Alvarez (reviewer)', role: 'reviewer', token: 'demo-reviewer-alvarez' },
  { userId: 'u_patel', name: 'S. Patel (reviewer)', role: 'reviewer', token: 'demo-reviewer-patel' },
  { userId: 'u_kim', name: 'J. Kim (author)', role: 'author', token: 'demo-author-kim' },
  { userId: 'u_viewer', name: 'Observer (read-only)', role: 'viewer', token: 'demo-viewer' }
]

export function seedUsers(db) {
  const stmt = db.prepare('INSERT OR IGNORE INTO users (user_id, name, role, token) VALUES (?, ?, ?, ?)')
  for (const u of DEMO_USERS) stmt.run(u.userId, u.name, u.role, u.token)
}

export function userForToken(db, token) {
  if (!token) return null
  const row = db.prepare('SELECT user_id, name, role FROM users WHERE token = ?').get(token)
  return row ? { userId: row.user_id, name: row.name, role: row.role } : null
}

export function requirePermission(user, permission) {
  if (!user) fail(401, 'UNAUTHENTICATED', 'A demo identity is required for this action.')
  if (!ROLE_PERMISSIONS[user.role]?.has(permission)) {
    fail(403, 'FORBIDDEN', `Role '${user.role}' may not perform '${permission}'.`, { permission, role: user.role })
  }
}

// Test-only fault hook: WORKBENCH_FAULT=crash_after_commit:<kind> exits the
// process after the transaction commits and before a response is sent.
function maybeCrashAfterCommit(kind) {
  if (process.env.WORKBENCH_FAULT === `crash_after_commit:${kind}`) {
    process.stderr.write(`[fault] crash_after_commit:${kind}\n`)
    process.exit(86)
  }
}

export function runOp(db, { opId, kind, actor, request, permission, subject = null }, fn) {
  if (!opId || typeof opId !== 'string' || opId.length < 8) {
    fail(400, 'OP_ID_REQUIRED', 'Mutating operations require an opId (string, 8+ chars).')
  }
  const requestHash = hashOf({ kind, request })
  const existing = db.prepare('SELECT * FROM operations WHERE op_id = ?').get(opId)
  if (existing) return replay(existing, requestHash, kind)

  let result
  try {
    result = tx(db, () => {
      const again = db.prepare('SELECT * FROM operations WHERE op_id = ?').get(opId)
      if (again) return { replayed: again }
      if (permission) requirePermission(actor, permission)
      const out = fn()
      db.prepare(
        `INSERT INTO operations (op_id, kind, actor, request_hash, status, http_status, response_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'COMMITTED', ?, ?, ?, ?)`
      ).run(opId, kind, actor?.userId ?? 'anonymous', requestHash, out.status ?? 200, JSON.stringify(out.body), nowIso(), nowIso())
      return out
    })
  } catch (err) {
    if (!(err instanceof WorkbenchError)) throw err
    // Record the rejection and an audit event, outside the rolled-back transaction.
    recordRejection(db, { opId, kind, actor, requestHash, err, subject })
    throw err
  }
  if (result.replayed) return replay(result.replayed, requestHash, kind)
  maybeCrashAfterCommit(kind)
  return { status: result.status ?? 200, body: result.body, replayed: false }
}

export function recordRejection(db, { opId, kind, actor, requestHash, err, subject = null }) {
  tx(db, () => {
    const row = db.prepare('SELECT status FROM operations WHERE op_id = ?').get(opId)
    if (row && row.status !== 'PENDING') return
    if (row) {
      db.prepare("UPDATE operations SET status = 'REJECTED', http_status = ?, response_json = ?, completed_at = ? WHERE op_id = ?")
        .run(err.status, JSON.stringify(err.toJSON()), nowIso(), opId)
    } else {
      db.prepare(
        `INSERT INTO operations (op_id, kind, actor, request_hash, status, http_status, response_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'REJECTED', ?, ?, ?, ?)`
      ).run(opId, kind, actor?.userId ?? 'anonymous', requestHash, err.status, JSON.stringify(err.toJSON()), nowIso(), nowIso())
    }
    appendEvent(db, {
      actor: actor?.userId ?? 'anonymous', operation: kind, opId, subject, result: `REJECTED:${err.code}`,
      details: { message: err.message, ...err.details }
    })
  })
}

export function maybeCrash(kind) {
  maybeCrashAfterCommit(kind)
}

function replay(row, requestHash, kind) {
  if (row.request_hash !== requestHash || row.kind !== kind) {
    fail(409, 'OP_ID_REUSED', 'This opId was already used for a different request.', { opId: row.op_id })
  }
  const body = JSON.parse(row.response_json)
  if (row.status === 'REJECTED') {
    throw new WorkbenchError(row.http_status, body.error, body.message, { ...(body.details || {}), replayed: true })
  }
  return { status: row.http_status, body, replayed: true }
}

// For long-running operations (a live model call happens outside any
// transaction): reserve the opId first, complete it later.
export function reserveOp(db, { opId, kind, actor, request }) {
  if (!opId || typeof opId !== 'string' || opId.length < 8) {
    fail(400, 'OP_ID_REQUIRED', 'Mutating operations require an opId (string, 8+ chars).')
  }
  const requestHash = hashOf({ kind, request })
  const existing = db.prepare('SELECT * FROM operations WHERE op_id = ?').get(opId)
  if (existing) {
    if (existing.status === 'PENDING') {
      if (existing.request_hash !== requestHash) fail(409, 'OP_ID_REUSED', 'This opId was already used for a different request.')
      return { pending: true, row: existing }
    }
    return { done: replay(existing, requestHash, kind) }
  }
  // Caller holds a transaction.
  db.prepare(
    `INSERT INTO operations (op_id, kind, actor, request_hash, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)`
  ).run(opId, kind, actor?.userId ?? 'anonymous', requestHash, nowIso())
  return { reserved: true }
}

export function completeOp(db, opId, status, httpStatus, body) {
  db.prepare('UPDATE operations SET status = ?, http_status = ?, response_json = ?, completed_at = ? WHERE op_id = ?')
    .run(status, httpStatus, JSON.stringify(body), nowIso(), opId)
}
