/** Messages between the page and the worker that runs the Python backend (browser build). */

export const BOOT_STEPS = [
  'Download Python (Pyodide, compiled to WebAssembly)',
  'Load FastAPI, jsonschema and Jinja2',
  'Load AI Cost Inspector and KORA Doctor',
  'Open the data saved in this browser',
] as const

export type ToWorker =
  | { kind: 'init'; base: string }
  | {
      kind: 'request'
      id: number
      method: string
      path: string
      headers: Record<string, string>
      body?: ArrayBuffer
    }
  | { kind: 'wipe' }

export type FailureReason = 'locked' | 'error'

export type FromWorker =
  | { kind: 'progress'; step: number }
  | { kind: 'ready'; seconds: number; pyodide: string }
  | { kind: 'failed'; reason: FailureReason; message: string }
  | { kind: 'response'; id: number; status: number; headers: [string, string][]; body: ArrayBuffer }
  | { kind: 'wiped' }
