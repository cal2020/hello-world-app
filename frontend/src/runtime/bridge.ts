/**
 * Page side of the browser build: starts the worker that runs the Python backend and turns
 * each API request into a message, and each reply back into a standard `Response`, so the
 * rest of the app cannot tell it from the network.
 */
import type { FailureReason, FromWorker, ToWorker } from './protocol'

export type EngineState =
  | { phase: 'starting'; step: number }
  | { phase: 'ready'; seconds: number; pyodide: string }
  | { phase: 'failed'; reason: FailureReason; message: string }

const NULL_BODY = new Set([101, 103, 204, 205, 304])

let worker: Worker | undefined
let state: EngineState = { phase: 'starting', step: 0 }
const listeners = new Set<() => void>()
const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>()
let nextId = 1
let onWiped: (() => void) | undefined

function update(next: EngineState) {
  state = next
  for (const listener of listeners) listener()
}

function fail(reason: FailureReason, message: string) {
  update({ phase: 'failed', reason, message })
  for (const [id, waiting] of pending) {
    pending.delete(id)
    waiting.reject(new TypeError(message))
  }
}

function send(message: ToWorker, transfer: Transferable[] = []) {
  worker?.postMessage(message, transfer)
}

export function startEngine(): void {
  if (worker || state.phase === 'failed') return
  if (typeof WebAssembly !== 'object') {
    fail('error', 'This browser cannot run WebAssembly, which the in-browser engine needs. Try a current version of Chrome, Edge, Firefox or Safari.')
    return
  }
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ai-cost-inspector-engine' })
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data
    switch (message.kind) {
      case 'progress':
        update({ phase: 'starting', step: message.step })
        break
      case 'ready':
        update({ phase: 'ready', seconds: message.seconds, pyodide: message.pyodide })
        break
      case 'failed':
        fail(message.reason, message.message)
        break
      case 'response': {
        const waiting = pending.get(message.id)
        if (!waiting) return
        pending.delete(message.id)
        const body = NULL_BODY.has(message.status) ? null : message.body
        waiting.resolve(new Response(body, { status: message.status, headers: message.headers }))
        break
      }
      case 'wiped':
        onWiped?.()
        break
    }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    fail('error', `The in-browser engine stopped: ${event.message || 'unknown error'}. Reload the page to start it again.`)
  }
  send({ kind: 'init', base: new URL(import.meta.env.BASE_URL, window.location.href).href })
}

export function subscribeEngine(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEngineState(): EngineState {
  return state
}

/** `fetch`-compatible: the request is served by the backend in the worker. */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  startEngine()
  if (state.phase === 'failed') throw new TypeError(state.message)
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value
  })
  const body = init.body == null ? undefined : await new Response(init.body).arrayBuffer()
  const signal = init.signal ?? undefined
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<Response>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    signal?.addEventListener(
      'abort',
      () => {
        if (pending.delete(id)) reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
    const method = (init.method ?? 'GET').toUpperCase()
    send({ kind: 'request', id, method, path, headers, body }, body ? [body] : [])
  })
}

/** Deletes the database saved in this browser. Reload afterwards to start empty. */
export function clearSavedData(): Promise<void> {
  startEngine()
  return new Promise((resolve) => {
    onWiped = resolve
    send({ kind: 'wipe' })
  })
}
