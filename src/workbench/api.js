// Thin API client. The demo identity token is kept in localStorage purely as
// a convenience; the server decides what each identity may do.
const KEY = 'ttp-wb-token'

export function getToken() {
  try { return localStorage.getItem(KEY) || 'demo-reviewer-alvarez' } catch { return 'demo-reviewer-alvarez' }
}
export function setToken(t) {
  try { localStorage.setItem(KEY, t) } catch { /* storage unavailable: keep in memory only */ }
  memoryToken = t
}
let memoryToken = null

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`)
    this.status = status
    this.code = body?.error
    this.details = body?.details || {}
  }
}

export async function api(method, path, body) {
  const token = memoryToken || getToken()
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

// Each user action gets a fresh operation id; the server makes retries of the
// same id safe.
export const newOpId = () => `ui-${crypto.randomUUID()}`
