import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, FileJson, FileUp, LoaderCircle, SquareTerminal, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent } from 'react'

import { ApiError, errorMessage, uploadImport, type UploadPhase } from '../../api/client'
import type { ImportDetail, Issue, Meta } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { Dialog } from '../../components/ui/dialog'
import { cn } from '../../lib/cn'
import { formatBytes, plural } from '../../lib/format'
import { FormatHelp } from '../welcome/FormatHelp'
import { isTranscript, readTranscripts } from './claude-code'

/** One AUDR file, or one or more Claude Code transcripts. */
type Source = { kind: 'audr' | 'claude-code'; files: File[] }
type Phase = 'reading' | UploadPhase

type State =
  | { kind: 'idle' }
  | { kind: 'checking'; files: File[] }
  | { kind: 'selected'; source: Source }
  | { kind: 'working'; source: Source; phase: Phase; fraction: number }
  | { kind: 'rejected'; source: Source; message: string; issues: Issue[]; total: number; truncated: boolean }
  | { kind: 'duplicate'; source: Source; importId: string; message: string }
  | { kind: 'failed'; source: Source | null; message: string }
  | { kind: 'cancelled'; source: Source }

const LISTED_FILES = 4

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    // Focusable so keyboard users can scroll a long list of problems.
    <ol
      tabIndex={0}
      aria-label="Problems found in the file"
      className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-xl border border-line text-[13px] scrollbar-thin"
    >
      {issues.map((issue, index) => (
        <li key={`${issue.line ?? 0}-${index}`} className="flex gap-3 px-3.5 py-2.5">
          <span className="w-14 shrink-0 text-xs text-ink-3 tabular">
            {issue.line != null ? `Line ${issue.line}` : 'File'}
            {issue.column != null && <span className="block">col {issue.column}</span>}
          </span>
          <span className="min-w-0">
            <span className="block text-ink">{issue.message}</span>
            {issue.hint && <span className="mt-0.5 block text-xs text-ink-3">{issue.hint}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function FileList({ files, transcripts, checking }: { files: File[]; transcripts: boolean; checking: boolean }) {
  const shown = files.slice(0, LISTED_FILES)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  return (
    <div className="rounded-xl border border-line bg-surface-2">
      <ul className="divide-y divide-line">
        {shown.map((file, index) => (
          <li key={`${file.name}-${index}`} className="flex items-center gap-3 px-3.5 py-2.5">
            {transcripts ? (
              <SquareTerminal className="size-5 shrink-0 text-ink-3" />
            ) : (
              <FileJson className="size-5 shrink-0 text-ink-3" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-ink-3">{formatBytes(file.size)}</p>
            </div>
            {checking ? (
              <LoaderCircle aria-label="Checking the file" className="size-4 shrink-0 animate-spin text-ink-3" />
            ) : (
              transcripts && <Badge tone="outline">Claude Code transcript</Badge>
            )}
          </li>
        ))}
      </ul>
      {files.length > LISTED_FILES && (
        <p className="border-t border-line px-3.5 py-2 text-xs text-ink-3">
          and {plural(files.length - LISTED_FILES, 'more file')} · {formatBytes(total)} in all
        </p>
      )}
    </div>
  )
}

function progressText(source: Source, phase: Phase): string {
  if (phase === 'reading') {
    return source.files.length === 1
      ? 'Reading the transcript in this browser…'
      : `Reading ${source.files.length} transcripts in this browser…`
  }
  if (phase === 'uploading') {
    return source.kind === 'claude-code' ? 'Sending the usage to the local service…' : 'Uploading to the local service…'
  }
  return source.kind === 'claude-code'
    ? 'Pricing each call, checking the records and running KORA Doctor…'
    : 'Validating against the AUDR schema and running KORA Doctor…'
}

export function ImportDialog({
  open,
  onOpenChange,
  meta,
  onImported,
  onOpenExisting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meta: Meta | undefined
  onImported: (detail: ImportDetail) => void
  onOpenExisting: (importId: string) => void
}) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const pick = useRef(0)
  const queryClient = useQueryClient()
  const inputId = useId()
  const limit = meta?.limits.max_upload_bytes ?? 8 * 1024 * 1024
  const maxRecords = meta?.limits.max_records ?? 10_000

  // The parent remounts this dialog on every open (key), so state starts fresh;
  // an import still running when it goes away is aborted.
  useEffect(() => () => controller.current?.abort(), [])

  const choose = async (files: File[]) => {
    if (files.length === 0) return
    const id = ++pick.current
    const empty = files.find((file) => file.size === 0)
    if (empty) {
      setState({
        kind: 'failed',
        source: { kind: 'audr', files },
        message: `${empty.name} is empty. Choose an AUDR file or a Claude Code transcript.`,
      })
      return
    }
    setState({ kind: 'checking', files })
    let transcripts: boolean[]
    try {
      transcripts = await Promise.all(files.map((file) => isTranscript(file)))
    } catch {
      if (id === pick.current) {
        setState({ kind: 'failed', source: { kind: 'audr', files }, message: 'The file couldn’t be read. Choose it again.' })
      }
      return
    }
    if (id !== pick.current) return
    if (transcripts.every(Boolean)) {
      setState({ kind: 'selected', source: { kind: 'claude-code', files } })
      return
    }
    const source: Source = { kind: 'audr', files }
    if (files.length > 1) {
      setState({
        kind: 'failed',
        source,
        message:
          'Choose one AUDR file at a time. Several files can be imported together only when they are all Claude Code transcripts.',
      })
      return
    }
    const size = files[0]?.size ?? 0
    if (size > limit) {
      setState({
        kind: 'failed',
        source,
        message: `This file is ${formatBytes(size)}; one import is limited to ${formatBytes(limit)}. Split it by run and import the parts.`,
      })
      return
    }
    setState({ kind: 'selected', source })
  }

  const start = async (source: Source) => {
    const abort = new AbortController()
    controller.current = abort
    try {
      let upload = source.files[0]
      if (source.kind === 'claude-code') {
        setState({ kind: 'working', source, phase: 'reading', fraction: 0 })
        const usage = await readTranscripts(
          source.files,
          (fraction) => setState({ kind: 'working', source, phase: 'reading', fraction }),
          abort.signal,
        )
        if (usage.requests === 0) {
          setState({
            kind: 'failed',
            source,
            message:
              'No API calls were found. Choose a session transcript from ~/.claude/projects/; a session with no replies yet has nothing to analyze.',
          })
          return
        }
        if (usage.requests > maxRecords) {
          setState({
            kind: 'failed',
            source,
            message: `These transcripts have ${plural(usage.requests, 'API call')}; one import holds at most ${maxRecords.toLocaleString('en-US')}. Import fewer sessions at a time.`,
          })
          return
        }
        const fallback = source.files.length === 1 ? (upload?.name ?? 'transcript.jsonl') : `${source.files.length} Claude Code transcripts`
        upload = new File([usage.toText()], usage.displayName(fallback), { type: 'application/x-ndjson' })
        if (upload.size > limit) {
          setState({
            kind: 'failed',
            source,
            message: `The usage in these transcripts takes ${formatBytes(upload.size)}, over the ${formatBytes(limit)} import limit. Import fewer sessions at a time.`,
          })
          return
        }
      }
      if (!upload) return
      setState({ kind: 'working', source, phase: 'uploading', fraction: 0 })
      const detail = await uploadImport(
        upload,
        (phase, fraction) => setState({ kind: 'working', source, phase, fraction }),
        abort.signal,
      )
      await queryClient.invalidateQueries()
      onImported(detail)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setState({ kind: 'cancelled', source })
        // The server may have finished a fully uploaded file; show the real list.
        await queryClient.invalidateQueries()
        return
      }
      if (error instanceof ApiError && error.code === 'invalid_file' && error.payload) {
        setState({
          kind: 'rejected',
          source,
          message: error.message,
          issues: error.payload.issues ?? [],
          total: error.payload.issue_count ?? 0,
          truncated: Boolean(error.payload.truncated),
        })
      } else if (error instanceof ApiError && error.code === 'already_imported' && error.payload?.import_id) {
        setState({ kind: 'duplicate', source, importId: error.payload.import_id, message: error.message })
      } else {
        setState({ kind: 'failed', source, message: errorMessage(error) })
      }
    } finally {
      controller.current = null
    }
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    void choose(Array.from(event.dataTransfer.files))
  }

  const working = state.kind === 'working'
  const source = state.kind === 'idle' || state.kind === 'checking' ? null : state.source
  const files = state.kind === 'checking' ? state.files : (source?.files ?? [])
  const transcripts = source?.kind === 'claude-code'
  const percent = working ? Math.round(state.fraction * 100) : 0
  const determinate = working && state.phase !== 'processing'
  const importLabel = transcripts
    ? files.length === 1
      ? 'Import transcript'
      : `Import ${files.length} transcripts`
    : 'Import file'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && working) controller.current?.abort()
        onOpenChange(next)
      }}
      title="Import telemetry"
      description="AUDR files and Claude Code transcripts are read and analyzed on this device; nothing is sent anywhere else."
      wide
      footer={
        <>
          {working ? (
            <Button variant="secondary" onClick={() => controller.current?.abort()}>
              <X /> Cancel import
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!source || working || state.kind === 'failed' || state.kind === 'duplicate'}
            onClick={() => source && void start(source)}
          >
            {working ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            {working ? 'Importing…' : state.kind === 'rejected' || state.kind === 'cancelled' ? 'Try again' : importLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label
          htmlFor={inputId}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent/60 hover:bg-hover/60',
            working && 'pointer-events-none opacity-60',
          )}
        >
          <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
            <FileUp className="size-5" />
          </span>
          <span className="mt-3 text-sm font-semibold">
            {files.length === 0
              ? 'Drop an AUDR file or Claude Code transcripts here, or browse'
              : files.length === 1
                ? 'Choose a different file'
                : 'Choose different files'}
          </span>
          <span className="mt-1 text-xs text-balance text-ink-3">
            AUDR .jsonl, .json or .ndjson up to {formatBytes(limit)} · Claude Code transcripts of any size ·{' '}
            {maxRecords.toLocaleString('en-US')} records per import
          </span>
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            multiple
            accept=".jsonl,.json,.ndjson,.txt,application/json,application/x-ndjson"
            className="sr-only"
            disabled={working}
            onChange={(event) => {
              void choose(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
        </label>

        {files.length > 0 && <FileList files={files} transcripts={transcripts} checking={state.kind === 'checking'} />}

        <div aria-live="polite" className="space-y-3">
          {working && (
            <div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink-2">{progressText(state.source, state.phase)}</span>
                {determinate && <span className="text-ink-3 tabular">{percent}%</span>}
              </div>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={determinate ? percent : undefined}
              >
                {determinate ? (
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
                ) : (
                  <div className="h-full w-1/3 animate-indeterminate rounded-full bg-accent/80" />
                )}
              </div>
              {state.phase === 'reading' && (
                <p className="mt-1.5 text-xs text-ink-3">
                  Only model names, token counts and times are kept; the conversation stays on this device.
                </p>
              )}
              {state.phase === 'processing' && (
                <p className="mt-1.5 text-xs text-ink-3">Large files take a few seconds (about 0.5 ms per record).</p>
              )}
            </div>
          )}
          {state.kind === 'rejected' && (
            <div className="space-y-2.5">
              <Callout tone="error" title={state.message}>
                Nothing was imported. Fix the {state.total === 1 ? 'problem' : 'problems'} below and import the file again.
              </Callout>
              <IssueList issues={state.issues} />
              {state.truncated && (
                <p className="text-xs text-ink-3">
                  Showing the first {state.issues.length} of {plural(state.total, 'problem')}.
                </p>
              )}
            </div>
          )}
          {state.kind === 'duplicate' && (
            <Callout
              tone="warn"
              title="Already imported"
              action={
                <Button size="sm" onClick={() => onOpenExisting(state.importId)}>
                  Open the existing import
                </Button>
              }
            >
              {state.message}
            </Callout>
          )}
          {state.kind === 'failed' && (
            <Callout tone="error" title="Not imported">
              {state.message}
            </Callout>
          )}
          {state.kind === 'cancelled' && (
            <Callout tone="warn" title="Import cancelled">
              The import was stopped. If the data had already reached the service, the import may still have completed —
              check the list of imports.
            </Callout>
          )}
        </div>

        {(state.kind === 'idle' || state.kind === 'rejected') && (
          <details className="group rounded-xl border border-line">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
              <CircleAlert className="size-4 text-ink-3" /> What can I import?
            </summary>
            <div className="px-3.5 pb-3.5">
              <FormatHelp meta={meta} className="shadow-none" />
            </div>
          </details>
        )}
      </div>
    </Dialog>
  )
}
