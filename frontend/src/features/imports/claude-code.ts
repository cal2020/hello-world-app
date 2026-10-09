/**
 * Claude Code session transcripts (`~/.claude/projects/<project>/<session-id>.jsonl`).
 *
 * The page reads them itself and passes on only what the cost import uses: one entry per
 * API request (model, token counts, time), session titles and Claude Code's own cost
 * figure. Message content never leaves this step. The backend turns the result into AUDR
 * records (backend/src/cost_inspector/ingest/claude_code.py) and reads a full transcript
 * the same way, so both give identical records.
 */

const SNIFF_BYTES = 64 * 1024
/** Entry types worth parsing; every other line (mostly conversation) is skipped unread. */
const MARKERS = ['"assistant"', '"ai-title"', '"custom-title"', '"cost-state"']
const ENTRY_KEYS = ['type', 'sessionId', 'requestId', 'timestamp', 'isSidechain', 'agentId', 'version', 'effort']
const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_creation',
  'output_tokens_details',
  'server_tool_use',
  'service_tier',
  'speed',
  'inference_geo',
]

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0

function pick(source: Json, keys: readonly string[]): Json {
  const out: Json = {}
  for (const key of keys) if (key in source) out[key] = source[key]
  return out
}

/** True when a file's beginning looks like a Claude Code transcript rather than AUDR. */
export function looksLikeTranscript(head: string): boolean {
  if (!head.trimStart().startsWith('{')) return false
  for (const raw of head.split('\n').slice(0, 50)) {
    const line = raw.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue // a pretty-printed object, or a line longer than the window
    }
    if (!isObject(value) || 'spec_version' in value || 'record_id' in value) return false
    if (
      typeof value.type === 'string' &&
      ('sessionId' in value || value.type === 'summary' || value.type === 'file-history-snapshot')
    ) {
      return true
    }
  }
  return head.includes('"sessionId"') && !head.includes('"spec_version"')
}

export async function isTranscript(file: Blob): Promise<boolean> {
  return looksLikeTranscript(await file.slice(0, SNIFF_BYTES).text())
}

/**
 * The usage entries of one or more transcripts. A response is logged once per content
 * block; the last entry for a request wins but keeps the position of the first, so
 * entries stay in file order relative to Claude Code's saved cost figures.
 */
export class UsageExtract {
  private readonly lines: string[] = []
  private readonly slotOf = new Map<string, number>()
  private readonly titles = new Map<string, { ai?: string; custom?: string }>()
  readonly sessions = new Set<string>()

  /** API requests found (the same ones the backend will count). */
  get requests(): number {
    return this.slotOf.size
  }

  addLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed || !MARKERS.some((marker) => trimmed.includes(marker))) return
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isObject(entry)) return
    const session = text(entry.sessionId)
    if (entry.type === 'assistant') this.addResponse(entry, session)
    else if (!session) return
    else if (entry.type === 'ai-title' || entry.type === 'custom-title') {
      const ai = text(entry.aiTitle)
      const custom = text(entry.customTitle)
      if (entry.type === 'ai-title' && ai) this.title(session).ai = ai
      else if (entry.type === 'custom-title' && custom) this.title(session).custom = custom
      else return
      this.lines.push(JSON.stringify(pick(entry, ['type', 'sessionId', 'aiTitle', 'customTitle'])))
    } else if (entry.type === 'cost-state') {
      this.lines.push(JSON.stringify(pick(entry, ['type', 'sessionId', 'totalCostUSD'])))
    }
  }

  private addResponse(entry: Json, session: string | null): void {
    const message = entry.message
    if (!isObject(message) || !isObject(message.usage)) return
    const model = text(message.model)
    const usage = message.usage
    const key = text(entry.requestId) ?? text(message.id)
    // "<synthetic>" marks messages Claude Code wrote itself: no API call was made.
    if (!model || model === '<synthetic>' || !key || !session || !text(entry.timestamp)) return
    if (!isCount(usage.input_tokens) && !isCount(usage.output_tokens)) return
    const lean = JSON.stringify({
      ...pick(entry, ENTRY_KEYS),
      message: { id: message.id, model: message.model, usage: pick(usage, USAGE_KEYS) },
    })
    const slot = this.slotOf.get(key)
    if (slot === undefined) {
      this.slotOf.set(key, this.lines.length)
      this.lines.push(lean)
    } else {
      this.lines[slot] = lean
    }
    this.sessions.add(session)
  }

  private title(session: string): { ai?: string; custom?: string } {
    let entry = this.titles.get(session)
    if (!entry) this.titles.set(session, (entry = {}))
    return entry
  }

  /** The extract as JSONL, ready to import. */
  toText(): string {
    return this.lines.length ? `${this.lines.join('\n')}\n` : ''
  }

  /** A display name for the import: the session's title when there is one. */
  displayName(fallback: string): string {
    if (this.sessions.size > 1) return `Claude Code – ${this.sessions.size} sessions`
    const [session] = this.sessions
    const title = session ? this.titles.get(session) : undefined
    const name = title?.custom ?? title?.ai
    return name ? `Claude Code – ${name}` : fallback
  }
}

/** Splits streamed text into lines without rescanning long lines. */
export class LineSplitter {
  private pending: string[] = []
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  push(chunk: string): void {
    let start = 0
    let end = chunk.indexOf('\n')
    while (end !== -1) {
      this.pending.push(chunk.slice(start, end))
      this.onLine(this.pending.join(''))
      this.pending = []
      start = end + 1
      end = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) this.pending.push(chunk.slice(start))
  }

  end(): void {
    if (this.pending.length) this.onLine(this.pending.join(''))
    this.pending = []
  }
}

/** Reads transcripts in this page, a chunk at a time, keeping only their usage entries. */
export async function readTranscripts(
  files: readonly File[],
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<UsageExtract> {
  const extract = new UsageExtract()
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1
  let read = 0
  for (const file of files) {
    const decoder = new TextDecoder()
    const lines = new LineSplitter((line) => extract.addLine(line))
    const reader = file.stream().getReader()
    try {
      for (;;) {
        if (signal.aborted) throw new DOMException('The import was cancelled.', 'AbortError')
        const { done, value } = await reader.read()
        if (done) break
        read += value.byteLength
        lines.push(decoder.decode(value, { stream: true }))
        onProgress(read / total)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    }
    lines.push(decoder.decode())
    lines.end()
  }
  return extract
}
