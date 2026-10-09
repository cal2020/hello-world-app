/**
 * Module worker for the browser build. It loads Pyodide (CPython compiled to WebAssembly),
 * the backend's packages and our app bundle, then serves the page's API requests with the
 * unchanged FastAPI application (see backend/src/cost_inspector/browser_runtime.py).
 *
 * The SQLite database lives in Pyodide's in-memory file system. After every request that
 * can change data, the file is saved to IndexedDB, and it is restored on the next visit.
 * A Web Lock lets only one tab own the data, so two tabs cannot overwrite each other.
 */
import type { FromWorker, ToWorker } from './protocol'

interface PyProxy {
  destroy(): void
}
interface PyBytes extends PyProxy {
  toJs(): Uint8Array
}
interface PyResult extends PyProxy {
  get(index: 0): string
  get(index: 1): PyBytes
}
interface BrowserRuntime extends PyProxy {
  boot(dbPath: string): void
  handle(method: string, path: string, headersJson: string, body?: Uint8Array): Promise<PyResult>
}
interface Pyodide {
  FS: {
    mkdirTree(path: string): void
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    analyzePath(path: string): { exists: boolean }
  }
  loadPackage(names: string[], options?: { messageCallback?: (message: string) => void }): Promise<unknown>
  unpackArchive(buffer: ArrayBuffer, format: string, options?: { extractDir?: string }): void
  runPython(code: string): unknown
  pyimport(name: string): unknown
}
interface Manifest {
  pyodide: { version: string; packages: string[] }
}
type RequestMessage = Extract<ToWorker, { kind: 'request' }>

const DB_PATH = '/data/inspector.sqlite3'
const SAVED = { database: 'ai-cost-inspector', store: 'files', key: 'inspector.sqlite3' }
const LOCK = 'ai-cost-inspector-data'

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  navigator: { locks?: LockManager }
}
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

let pyodide: Pyodide | undefined
let runtime: BrowserRuntime | undefined
const queue: RequestMessage[] = []
let draining = false

// ---------------------------------------------------------------- saved database (IndexedDB)

function openSaved(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(SAVED.database, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore(SAVED.store)
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB is unavailable'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openSaved()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(SAVED.store, mode)
      const request = run(transaction.objectStore(SAVED.store))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB error'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

async function loadSaved(): Promise<Uint8Array | undefined> {
  const value = await withStore<unknown>('readonly', (store) => store.get(SAVED.key))
  return value instanceof Uint8Array ? value : undefined
}

const save = (bytes: Uint8Array) => withStore('readwrite', (store) => store.put(bytes, SAVED.key))
const forget = () => withStore('readwrite', (store) => store.delete(SAVED.key))

// ---------------------------------------------------------------- startup

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`)
  return response
}

async function boot(base: string): Promise<void> {
  const started = performance.now()
  const url = (path: string) => new URL(path, base).href
  const manifest = (await (await fetchOk(url('build-manifest.json'))).json()) as Manifest

  post({ kind: 'progress', step: 0 })
  const module = (await import(/* @vite-ignore */ url('pyodide/pyodide.mjs'))) as {
    loadPyodide(options: { indexURL: string }): Promise<Pyodide>
  }
  const py = await module.loadPyodide({ indexURL: url('pyodide/') })

  post({ kind: 'progress', step: 1 })
  await py.loadPackage(manifest.pyodide.packages, { messageCallback: () => undefined })

  post({ kind: 'progress', step: 2 })
  const [bundle, bytecode] = await Promise.all([
    fetchOk(url('app.zip')).then((response) => response.arrayBuffer()),
    fetchOk(url('bytecode.zip')).then((response) => response.arrayBuffer()),
  ])
  py.unpackArchive(bundle, 'zip', { extractDir: '/app' })
  // Precompiled at build time by this same Pyodide (browser/precompile.mjs): skips compiling
  // FastAPI, pydantic and the rest from source on every visit.
  py.unpackArchive(bytecode, 'zip', { extractDir: '/' })
  py.runPython('import sys\nsys.path.insert(0, "/app")')
  const app = py.pyimport('cost_inspector.browser_runtime') as BrowserRuntime

  post({ kind: 'progress', step: 3 })
  py.FS.mkdirTree('/data')
  const saved = await loadSaved()
  if (saved) py.FS.writeFile(DB_PATH, saved)
  app.boot(DB_PATH)

  pyodide = py
  runtime = app
  post({ kind: 'ready', seconds: Math.round((performance.now() - started) / 100) / 10, pyodide: manifest.pyodide.version })
  void drain()
}

function startWithLock(base: string): void {
  const run = async () => {
    await boot(base)
    // Hold the lock for as long as this tab is open.
    await new Promise<never>(() => undefined)
  }
  const report = (error: unknown) => {
    const locked = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
    post(
      locked
        ? {
            kind: 'failed',
            reason: 'locked',
            message:
              'AI Cost Inspector is already open in another tab of this browser, and only one tab can use the saved data at a time. Close that tab, then reload this one.',
          }
        : { kind: 'failed', reason: 'error', message: errorText(error) },
    )
  }
  const locks = scope.navigator.locks
  if (!locks) {
    run().catch(report)
    return
  }
  // A reload can briefly overlap the previous page's worker, so wait a few seconds for the lock.
  locks.request(LOCK, { signal: AbortSignal.timeout(5000) }, run).catch(report)
}

// ---------------------------------------------------------------- requests

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 600 ? `…${text.slice(-600)}` : text
}

async function serve(message: RequestMessage): Promise<void> {
  try {
    if (!pyodide || !runtime) throw new Error('The engine has not started.')
    const body = message.body ? new Uint8Array(message.body) : undefined
    const result = await runtime.handle(message.method, message.path, JSON.stringify(message.headers), body)
    const meta = JSON.parse(result.get(0)) as { status: number; headers: [string, string][] }
    const proxy = result.get(1)
    const bytes = proxy.toJs().slice()
    proxy.destroy()
    result.destroy()
    if (message.method !== 'GET' && message.method !== 'HEAD' && pyodide.FS.analyzePath(DB_PATH).exists) {
      await save(pyodide.FS.readFile(DB_PATH))
    }
    post({ kind: 'response', id: message.id, status: meta.status, headers: meta.headers, body: bytes.buffer }, [bytes.buffer])
  } catch (error) {
    const payload = { error: { code: 'browser_engine_error', message: `The in-browser engine failed: ${errorText(error)}` } }
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    post(
      { kind: 'response', id: message.id, status: 500, headers: [['content-type', 'application/json']], body: bytes.buffer },
      [bytes.buffer],
    )
  }
}

async function drain(): Promise<void> {
  if (draining || !runtime) return
  draining = true
  try {
    // One request at a time: Python here is single-threaded, and order matters for writes.
    for (let next = queue.shift(); next; next = queue.shift()) await serve(next)
  } finally {
    draining = false
  }
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.kind === 'init') {
    startWithLock(message.base)
  } else if (message.kind === 'request') {
    queue.push(message)
    void drain()
  } else {
    forget().then(
      () => post({ kind: 'wiped' }),
      (error: unknown) => post({ kind: 'failed', reason: 'error', message: errorText(error) }),
    )
  }
}
