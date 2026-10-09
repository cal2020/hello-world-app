import { FileJson, FlaskConical, Inbox, Lock, Sparkles, Upload } from 'lucide-react'
import type { KeyboardEvent } from 'react'

import { IN_BROWSER } from '../../api/transport'
import type { ImportSummary } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatRelative, plural } from '../../lib/format'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Callout } from '../ui/callout'
import { SpendValue } from '../ui/money'
import { Skeleton } from '../ui/skeleton'

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-item]'))
  const index = items.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  event.preventDefault()
  const next = items[event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)]
  next?.focus()
}

export function Sidebar({
  imports,
  loading,
  error,
  onRetry,
  selectedImport,
  selectedRun,
  onSelectImport,
  onSelectRun,
  onImport,
  onLoadDemo,
  demoLoading,
  demoLoaded,
  footer,
  onClearData,
}: {
  imports: ImportSummary[] | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  selectedImport: string | null
  selectedRun: string | null
  onSelectImport: (id: string) => void
  onSelectRun: (id: string) => void
  onImport: () => void
  onLoadDemo: () => void
  demoLoading: boolean
  demoLoaded: boolean
  footer?: string
  /** Browser build: offer to delete the data saved in this browser. */
  onClearData?: () => void
}) {
  const ordered = [...(imports ?? [])].reverse()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          Imports {imports && imports.length > 0 && <span className="ml-1 text-ink-3/80">{imports.length}</span>}
        </p>
        <Button variant="ghost" size="icon-sm" aria-label="Import an AUDR file" onClick={onImport}>
          <Upload />
        </Button>
      </div>

      <nav aria-label="Imports and runs" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 scrollbar-thin" onKeyDown={moveFocus}>
        {loading && (
          <div className="space-y-3 px-1.5 pt-1" aria-label="Loading imports">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        )}
        {error && !loading && (
          <Callout tone="error" title="Couldn't load imports" className="mx-1.5" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>
            {error}
          </Callout>
        )}
        {!loading && !error && ordered.length === 0 && (
          <div className="mx-1.5 mt-2 rounded-xl border border-dashed border-line-strong p-4 text-center">
            <Inbox className="mx-auto size-5 text-ink-3" />
            <p className="mt-2 text-[13px] font-medium">No runs yet</p>
            <p className="mt-0.5 text-xs text-ink-3">Import AUDR telemetry or explore the synthetic demo.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <Button size="sm" variant="primary" onClick={onLoadDemo} disabled={demoLoading}>
                <Sparkles /> {demoLoading ? 'Loading demo…' : 'Load demo runs'}
              </Button>
              <Button size="sm" onClick={onImport}>
                <Upload /> Import file
              </Button>
            </div>
          </div>
        )}
        <ul className="space-y-3">
          {ordered.map((imp) => {
            const importSelected = selectedImport === imp.id && !selectedRun
            return (
              <li key={imp.id}>
                <button
                  type="button"
                  data-nav-item
                  onClick={() => onSelectImport(imp.id)}
                  aria-current={importSelected ? 'page' : undefined}
                  className={cn(
                    'group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                    importSelected ? 'bg-accent-soft' : 'hover:bg-hover',
                  )}
                >
                  <FileJson className={cn('mt-0.5 size-4 shrink-0', importSelected ? 'text-accent-ink' : 'text-ink-3')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold" title={imp.filename}>
                      {imp.filename}
                    </span>
                    <span className="block truncate text-xs text-ink-3">
                      {plural(imp.runs.length, 'run')} · {formatRelative(imp.imported_at)}
                    </span>
                  </span>
                  {imp.synthetic && (
                    <span className="mt-0.5 shrink-0" title="Synthetic demo data">
                      <FlaskConical aria-label="Synthetic demo data" className="size-3.5 text-ink-3" />
                    </span>
                  )}
                </button>
                <ul className="mt-0.5 space-y-0.5 border-l border-line pl-2 ml-[15px]">
                  {imp.runs.map((run) => {
                    const selected = selectedRun === run.id
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          data-nav-item
                          onClick={() => onSelectRun(run.id)}
                          aria-current={selected ? 'page' : undefined}
                          className={cn(
                            'relative flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                            selected ? 'bg-accent-soft' : 'hover:bg-hover',
                          )}
                        >
                          {selected && <span aria-hidden className="absolute top-2 bottom-2 -left-[9px] w-0.5 rounded-full bg-accent" />}
                          <span className="min-w-0 flex-1">
                            <span className={cn('line-clamp-2 text-[13px] leading-[18px]', selected ? 'font-medium text-ink' : 'text-ink')}>
                              {run.display_name}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
                              <SpendValue spend={run.spend} className="whitespace-nowrap tabular" />
                              {run.spend.unknown_calls > 0 && (
                                <span className="whitespace-nowrap text-warn-ink">+{run.spend.unknown_calls} unknown</span>
                              )}
                              <span className="whitespace-nowrap">· {plural(run.calls, 'call')}</span>
                            </span>
                          </span>
                          {run.open_findings > 0 && (
                            <Badge tone="candidate" className="mt-0.5 h-5 px-1.5" title={`${plural(run.open_findings, 'open candidate')}`}>
                              {run.open_findings}
                            </Badge>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
        {!loading && ordered.length > 0 && !demoLoaded && (
          <button
            type="button"
            onClick={onLoadDemo}
            disabled={demoLoading}
            className="mt-4 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-ink-3 hover:bg-hover hover:text-ink-2"
          >
            <Sparkles className="size-3.5" /> {demoLoading ? 'Loading demo…' : 'Add the synthetic demo runs'}
          </button>
        )}
      </nav>

      <div className="border-t border-line px-4 py-3 text-xs leading-5 text-ink-3">
        <p className="flex items-center gap-1.5">
          <Lock className="size-3.5" />{' '}
          {IN_BROWSER ? 'Runs in your browser · files stay on this device' : 'Local only · telemetry stays on this machine'}
        </p>
        {footer && <p className="mt-0.5 truncate">{footer}</p>}
        {onClearData && (
          <button
            type="button"
            onClick={onClearData}
            className="-mx-1 mt-1 rounded px-1 text-xs text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink-2"
          >
            Clear data saved in this browser
          </button>
        )}
      </div>
    </div>
  )
}
