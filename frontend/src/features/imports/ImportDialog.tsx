import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, FileJson, FileUp, LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent } from 'react'

import { ApiError, errorMessage, uploadImport, type UploadPhase } from '../../api/client'
import type { ImportDetail, Issue, Meta } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { Dialog } from '../../components/ui/dialog'
import { cn } from '../../lib/cn'
import { formatBytes, plural } from '../../lib/format'
import { FormatHelp } from '../welcome/FormatHelp'

type State =
  | { kind: 'idle' }
  | { kind: 'selected'; file: File }
  | { kind: 'working'; file: File; phase: UploadPhase; fraction: number }
  | { kind: 'rejected'; file: File; message: string; issues: Issue[]; total: number; truncated: boolean }
  | { kind: 'duplicate'; file: File; importId: string; message: string }
  | { kind: 'failed'; file: File | null; message: string }
  | { kind: 'cancelled'; file: File }

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
  const queryClient = useQueryClient()
  const inputId = useId()
  const limit = meta?.limits.max_upload_bytes ?? 8 * 1024 * 1024

  // The parent remounts this dialog on every open (key), so state starts fresh;
  // an upload still running when it goes away is aborted.
  useEffect(() => () => controller.current?.abort(), [])

  const choose = (file: File | undefined) => {
    if (!file) return
    if (file.size === 0) {
      setState({ kind: 'failed', file, message: 'This file is empty. Choose an AUDR JSON or JSONL file.' })
      return
    }
    if (file.size > limit) {
      setState({
        kind: 'failed',
        file,
        message: `This file is ${formatBytes(file.size)}; one import is limited to ${formatBytes(limit)}. Split it by run and import the parts.`,
      })
      return
    }
    setState({ kind: 'selected', file })
  }

  const start = async (file: File) => {
    const abort = new AbortController()
    controller.current = abort
    setState({ kind: 'working', file, phase: 'uploading', fraction: 0 })
    try {
      const detail = await uploadImport(
        file,
        (phase, fraction) => setState({ kind: 'working', file, phase, fraction }),
        abort.signal,
      )
      await queryClient.invalidateQueries()
      onImported(detail)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setState({ kind: 'cancelled', file })
        // The server may have finished a fully uploaded file; show the real list.
        await queryClient.invalidateQueries()
        return
      }
      if (error instanceof ApiError && error.code === 'invalid_file' && error.payload) {
        setState({
          kind: 'rejected',
          file,
          message: error.message,
          issues: error.payload.issues ?? [],
          total: error.payload.issue_count ?? 0,
          truncated: Boolean(error.payload.truncated),
        })
      } else if (error instanceof ApiError && error.code === 'already_imported' && error.payload?.import_id) {
        setState({ kind: 'duplicate', file, importId: error.payload.import_id, message: error.message })
      } else {
        setState({ kind: 'failed', file, message: errorMessage(error) })
      }
    } finally {
      controller.current = null
    }
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    choose(event.dataTransfer.files[0])
  }

  const working = state.kind === 'working'
  const file = state.kind === 'idle' ? null : state.file
  const percent = working ? Math.round(state.fraction * 100) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && working) controller.current?.abort()
        onOpenChange(next)
      }}
      title="Import AUDR telemetry"
      description="The file is validated and analyzed locally; nothing is sent anywhere else."
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
            disabled={!file || working || state.kind === 'failed' || state.kind === 'duplicate'}
            onClick={() => file && void start(file)}
          >
            {working ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            {working ? 'Importing…' : state.kind === 'rejected' || state.kind === 'cancelled' ? 'Try again' : 'Import file'}
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
            {file ? 'Choose a different file' : 'Drop an AUDR file here, or browse'}
          </span>
          <span className="mt-1 text-xs text-ink-3">
            .jsonl, .json or .ndjson · up to {formatBytes(limit)} · {meta?.limits.max_records.toLocaleString('en-US') ?? '10,000'} records
          </span>
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            accept=".jsonl,.json,.ndjson,.txt,application/json,application/x-ndjson"
            className="sr-only"
            disabled={working}
            onChange={(event) => {
              choose(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </label>

        {file && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
            <FileJson className="size-5 shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-ink-3">{formatBytes(file.size)}</p>
            </div>
          </div>
        )}

        <div aria-live="polite" className="space-y-3">
          {working && (
            <div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink-2">
                  {state.phase === 'uploading'
                    ? 'Uploading to the local service…'
                    : 'Validating against the AUDR schema and running KORA Doctor…'}
                </span>
                {state.phase === 'uploading' && <span className="text-ink-3 tabular">{percent}%</span>}
              </div>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={state.phase === 'uploading' ? percent : undefined}
              >
                {state.phase === 'uploading' ? (
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
                ) : (
                  <div className="h-full w-1/3 animate-indeterminate rounded-full bg-accent/80" />
                )}
              </div>
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
              The upload was stopped. If the file had already reached the service, the import may still have completed —
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
