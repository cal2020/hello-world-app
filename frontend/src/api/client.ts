import { IN_BROWSER, transport } from './transport'
import type { ApiErrorPayload, ImportDetail } from './types'

/** Sent on every request; the API refuses changes without it (blocks cross-site forms). */
export const CLIENT_HEADERS = { 'X-Requested-With': 'cost-inspector' } as const

export const NETWORK_MESSAGE = IN_BROWSER
  ? 'The in-browser analysis engine stopped responding. Reload the page to start it again.'
  : "Can't reach the local analysis service. Start it with `make dev` (or `make start`), then try again."

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: ApiErrorPayload | undefined

  constructor(status: number, code: string, message: string, payload?: ApiErrorPayload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let payload: ApiErrorPayload | undefined
  try {
    const body = (await response.json()) as { error?: ApiErrorPayload }
    payload = body.error
  } catch {
    payload = undefined
  }
  return new ApiError(
    response.status,
    payload?.code ?? 'http_error',
    payload?.message ?? `The request failed (HTTP ${response.status}).`,
    payload,
  )
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await transport(path, {
      ...init,
      headers: { Accept: 'application/json', ...CLIENT_HEADERS, ...init.headers },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'network', NETWORK_MESSAGE)
  }
  if (!response.ok) throw await toApiError(response)
  return (await response.json()) as T
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } }
}

export type UploadPhase = 'uploading' | 'processing'

/**
 * Uploads one file with real byte progress (XMLHttpRequest exposes upload progress;
 * fetch does not). Aborting stops the transfer. If the server already received the
 * whole file it may still finish the import, so callers re-read the import list.
 */
export function uploadImport(
  file: File,
  onProgress: (phase: UploadPhase, fraction: number) => void,
  signal: AbortSignal,
): Promise<ImportDetail> {
  if (IN_BROWSER) {
    // Nothing is uploaded: the file goes straight to the engine in this page.
    onProgress('processing', 1)
    return api<ImportDetail>(`/api/imports?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    })
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/imports?filename=${encodeURIComponent(file.name)}`)
    for (const [key, value] of Object.entries(CLIENT_HEADERS)) xhr.setRequestHeader(key, value)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress('uploading', event.loaded / event.total)
    }
    xhr.upload.onload = () => onProgress('processing', 1)
    xhr.onload = () => {
      let body: unknown
      try {
        body = JSON.parse(xhr.responseText) as unknown
      } catch {
        body = null
      }
      if (xhr.status === 201) {
        resolve(body as ImportDetail)
        return
      }
      const payload = (body as { error?: ApiErrorPayload } | null)?.error
      reject(
        new ApiError(
          xhr.status,
          payload?.code ?? 'http_error',
          payload?.message ?? `The import failed (HTTP ${xhr.status}).`,
          payload,
        ),
      )
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', NETWORK_MESSAGE))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    onProgress('uploading', 0)
    xhr.send(file)
  })
}

function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      /* fall through to the ASCII name */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition)
  return plain?.[1] ?? fallback
}

/** Fetches a report and hands it to the browser. Resolves only once real bytes exist. */
export async function downloadFile(url: string, fallbackName: string): Promise<{ filename: string; size: number }> {
  let response: Response
  try {
    response = await transport(url, { headers: CLIENT_HEADERS })
  } catch {
    throw new ApiError(0, 'network', NETWORK_MESSAGE)
  }
  if (!response.ok) throw await toApiError(response)
  const blob = await response.blob()
  if (blob.size === 0) throw new ApiError(500, 'empty_report', 'The report came back empty; nothing was saved.')
  const filename = filenameFrom(response.headers.get('Content-Disposition'), fallbackName)
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
  return { filename, size: blob.size }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.'
  return 'Something unexpected went wrong. Reload the page and try again.'
}
