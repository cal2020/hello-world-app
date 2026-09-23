// Small shared helpers: canonical JSON, hashing, ids, errors.
import { createHash, randomUUID } from 'node:crypto'

// Deterministic JSON: object keys sorted recursively so hashes are stable.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function hashOf(value) {
  return 'sha256:' + sha256(canonicalJson(value))
}

export function shortHash(h) {
  return h ? h.replace('sha256:', '').slice(0, 12) : ''
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function nowIso() {
  return new Date().toISOString()
}

// Errors carry an HTTP status and a machine-readable code so the UI and the
// evaluation runner can distinguish "blocked by policy" from "broken".
export class WorkbenchError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
  toJSON() {
    return { error: this.code, message: this.message, details: this.details }
  }
}

export const fail = (status, code, message, details) => {
  throw new WorkbenchError(status, code, message, details)
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z')
  const b = Date.parse(toIso + 'T00:00:00Z')
  return Math.round((b - a) / 86400000)
}
