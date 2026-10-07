import { Bot, Info, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { CallRecord } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardHeader } from '../../components/ui/card'
import { Money } from '../../components/ui/money'
import { Tip } from '../../components/ui/tooltip'
import { categoryMeta } from '../../lib/categories'
import { cn } from '../../lib/cn'
import { formatDateTime, formatDuration, formatInt, formatMoney, formatOffset } from '../../lib/format'
import type { TimelineHighlight } from './highlight'
import { sortCalls } from './sort'

const TICK_STEPS = [
  50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
]
const PAGE = 300

function tickValues(span: number): number[] {
  const step = TICK_STEPS.find((s) => span / s <= 6) ?? TICK_STEPS[TICK_STEPS.length - 1] ?? 1000
  const out: number[] = []
  for (let t = 0; t <= span + 0.001; t += step) out.push(t)
  return out
}

const GRID =
  'grid-cols-[1.75rem_minmax(0,8.5rem)_minmax(0,1fr)_4.75rem] @xl:grid-cols-[2.25rem_minmax(0,13rem)_minmax(0,1fr)_5.75rem]'

function CallTip({ call, offsetMs }: { call: CallRecord; offsetMs: number }) {
  const open = call.findings.filter((f) => !f.dismissed)
  const input = call.usage.input_tokens
  const output = call.usage.output_tokens
  return (
    <div className="space-y-0.5">
      <p className="font-semibold">
        {call.resource.name}{' '}
        <span className="font-normal opacity-75">
          {call.resource.provider} · {call.resource.operation}
        </span>
      </p>
      <p className="opacity-90">
        Step {call.step ?? '—'} · {call.duration_ms != null ? formatDuration(call.duration_ms) : 'duration not reported'} ·
        ends {formatOffset(offsetMs)}
      </p>
      <p className="opacity-90">
        Cost {call.cost.amount != null ? formatMoney(call.cost.amount, call.cost.currency) : 'not reported (unknown)'}
        {call.is_model && (
          <>
            {' · '}
            {typeof input === 'number' ? formatInt(input) : '—'} in / {typeof output === 'number' ? formatInt(output) : '—'} out
          </>
        )}
      </p>
      {open.length > 0 && (
        <p className="opacity-90">
          {open.length} open finding{open.length === 1 ? '' : 's'}:{' '}
          {[...new Set(open.map((f) => categoryMeta(f.category).label))].join(', ')}
        </p>
      )}
    </div>
  )
}

export function Timeline({
  calls,
  startMs,
  endMs,
  rule,
  highlight,
  selectedCallId,
  onSelectCall,
}: {
  calls: CallRecord[]
  startMs: number
  endMs: number
  rule: string
  highlight: TimelineHighlight | null
  selectedCallId: string | null
  onSelectCall: (id: string) => void
}) {
  const [limit, setLimit] = useState(PAGE)
  const rows = useMemo(() => sortCalls(calls), [calls])
  const span = Math.max(1, endMs - startMs)
  const ticks = useMemo(() => tickValues(span), [span])
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / span) * 100))}%`
  const visible = rows.slice(0, limit)

  return (
    <Card aria-labelledby="timeline-title">
      <CardHeader
        titleId="timeline-title"
        title="Call timeline"
        description={`${rows.length} calls in step order across ${formatDuration(span)}`}
        actions={
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-4 rounded-[3px] bg-model" /> Model call
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-4 rounded-[3px] bg-tool" /> Tool call
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-candidate" /> Has open candidates
            </span>
            {highlight && (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-4 rounded-[3px] bg-model ring-2 ring-candidate" /> In selected finding
              </span>
            )}
            <Tip content={rule}>
              <button type="button" aria-label="How the timeline is drawn" className="text-ink-3 hover:text-ink">
                <Info className="size-4" />
              </button>
            </Tip>
          </div>
        }
      />
      <div className="px-3 pb-3 sm:px-4">
        <div aria-hidden className={cn('grid items-end gap-3 px-2 pb-1', GRID)}>
          <span className="text-right text-[11px] text-ink-3">#</span>
          <span className="text-[11px] text-ink-3">Resource</span>
          <span className="relative h-4">
            {ticks.map((t, i) => (
              <span
                key={t}
                className={cn(
                  'absolute bottom-0 text-[11px] whitespace-nowrap text-ink-3 tabular',
                  i === 0 ? '' : i === ticks.length - 1 && t / span > 0.9 ? '-translate-x-full' : '-translate-x-1/2',
                )}
                style={{ left: pct(t) }}
              >
                {t === 0 ? '0' : formatDuration(t)}
              </span>
            ))}
          </span>
          <span className="text-right text-[11px] text-ink-3">Cost</span>
        </div>
        <ol className="space-y-px">
          {visible.map((call) => {
            const start = (call.start_ms ?? call.event_ms) - startMs
            const end = call.event_ms - startMs
            const open = call.findings.filter((f) => !f.dismissed).length
            const inFinding = highlight?.affected.has(call.id) ?? false
            const isReference = highlight?.reference.has(call.id) ?? false
            const dim = highlight != null && !inFinding && !isReference
            const selected = selectedCallId === call.id
            const Icon = call.is_model ? Bot : Wrench
            // The button's name is its visible text plus these screen-reader-only parts,
            // so what is announced starts with what is shown (WCAG 2.5.3).
            const duration = call.duration_ms != null ? formatDuration(call.duration_ms) : 'duration not reported'
            const status = [
              open ? `${open} open finding${open === 1 ? '' : 's'}` : 'no open findings',
              inFinding ? 'in the selected finding' : isReference ? 'reference call of the selected finding' : '',
            ]
              .filter(Boolean)
              .join(', ')
            return (
              <li key={call.id}>
                <Tip content={<CallTip call={call} offsetMs={end} />} side="top" align="start">
                  <button
                    type="button"
                    onClick={() => onSelectCall(call.id)}
                    aria-pressed={selected}
                    className={cn(
                      'group grid w-full items-center gap-3 rounded-lg px-2 py-[5px] text-left transition-colors duration-150',
                      GRID,
                      selected ? 'bg-accent-soft' : 'hover:bg-hover',
                      // Outside the selected finding: marks fade, text stays readable.
                      dim && 'text-ink-3',
                    )}
                  >
                    <span className="text-right text-xs text-ink-3 tabular">
                      <span className="sr-only">Step </span>
                      {call.step ?? '—'}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Icon
                        aria-hidden
                        className={cn(
                          'size-3.5 shrink-0 transition-opacity',
                          call.is_model ? 'text-model' : 'text-tool',
                          dim && 'opacity-40 group-hover:opacity-100',
                        )}
                      />
                      <span className="truncate text-[13px]" title={call.resource.name}>
                        {call.resource.name}
                      </span>
                      <span className="sr-only">, {call.is_model ? 'model' : 'tool'} call</span>
                      {open > 0 && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-candidate" />}
                      {isReference && (
                        <Badge tone="outline" className="h-[18px] px-1.5 text-[10.5px]">
                          <span className="sr-only">, </span>Reference
                        </Badge>
                      )}
                    </span>
                    <span
                      className={cn('relative h-5 transition-opacity', dim && 'opacity-35 group-hover:opacity-100')}
                      aria-hidden
                    >
                      {ticks.map((t) => (
                        <span key={t} className="absolute inset-y-0 w-px bg-grid" style={{ left: pct(t) }} />
                      ))}
                      {call.duration_ms != null ? (
                        <span
                          className={cn(
                            'absolute top-1/2 h-2.5 min-w-[3px] -translate-y-1/2 rounded-[3px]',
                            call.is_model ? 'bg-model' : 'bg-tool',
                            (inFinding || isReference) && 'ring-2 ring-offset-1 ring-offset-surface',
                            inFinding ? 'ring-candidate' : isReference ? 'ring-ink-3' : '',
                          )}
                          style={{ left: pct(start), width: `max(3px, calc(${pct(end)} - ${pct(start)}))` }}
                        />
                      ) : (
                        <span
                          className={cn(
                            'absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
                            call.is_model ? 'bg-model' : 'bg-tool',
                          )}
                          style={{ left: pct(end) }}
                        />
                      )}
                    </span>
                    <span className="text-right text-[13px] tabular">
                      <span className="sr-only">, {duration}, cost </span>
                      <Money amount={call.cost.amount} currency={call.cost.currency} />
                      <span className="sr-only">, {status}</span>
                    </span>
                  </button>
                </Tip>
              </li>
            )
          })}
        </ol>
        {rows.length > limit && (
          <div className="mt-2 flex items-center justify-center gap-3 text-xs text-ink-3">
            Showing {limit} of {rows.length} calls
            <Button size="sm" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - limit)} more
            </Button>
          </div>
        )}
        <p className="mt-3 px-2 text-xs text-ink-3">
          Started {formatDateTime(startMs)} (local time). The calls table below lists every value shown here.
        </p>
      </div>
    </Card>
  )
}
