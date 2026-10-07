import { ArrowDown, ArrowUp, Bot, ChevronLeft, ChevronRight, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { CallRecord } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Card, CardHeader } from '../../components/ui/card'
import { Money } from '../../components/ui/money'
import { Tip } from '../../components/ui/tooltip'
import { categoryMeta } from '../../lib/categories'
import { cn } from '../../lib/cn'
import { formatDuration, formatInt, formatOffset, geometryValue } from '../../lib/format'
import { sortCalls } from './sort'

type SortKey = 'step' | 'cost' | 'duration'
const PAGE = 50

function tokens(call: CallRecord, key: string): string {
  const value = call.usage[key]
  return typeof value === 'number' ? formatInt(value) : '—'
}

export function CallsTable({
  calls,
  startMs,
  selectedCallId,
  onSelectCall,
}: {
  calls: CallRecord[]
  startMs: number
  selectedCallId: string | null
  onSelectCall: (id: string) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'step', desc: false })
  const [page, setPage] = useState(0)
  const rows = useMemo(() => {
    const base = sortCalls(calls)
    if (sort.key === 'step') return sort.desc ? base.reverse() : base
    const value = (c: CallRecord) =>
      sort.key === 'cost' ? (c.cost.amount == null ? -1 : geometryValue(c.cost.amount)) : (c.duration_ms ?? -1)
    return [...base].sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)))
  }, [calls, sort])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const current = Math.min(page, pages - 1)
  const visible = rows.slice(current * PAGE, current * PAGE + PAGE)

  const header = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const active = sort.key === key
    const Arrow = active && sort.desc ? ArrowDown : ArrowUp
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
        className={cn('px-3 py-2 font-medium', align === 'right' && 'text-right')}
      >
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'step' }))}
          className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}
        >
          {label}
          <Arrow className={cn('size-3', !active && 'opacity-0')} />
        </button>
      </th>
    )
  }

  return (
    <Card aria-labelledby="calls-title">
      <CardHeader
        titleId="calls-title"
        title="Calls"
        description="Normalized telemetry for every record in this run. Select a row for full details."
      />
      <div className="relative overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[760px] border-t border-line text-[13px]">
          <thead className="bg-surface-2 text-left text-xs text-ink-3">
            <tr>
              {header('step', 'Step')}
              <th scope="col" className="px-3 py-2 font-medium">Resource</th>
              <th scope="col" className="px-3 py-2 font-medium">Ends at</th>
              {header('duration', 'Duration', 'right')}
              <th scope="col" className="px-3 py-2 text-right font-medium">Tokens in / out</th>
              {header('cost', 'Cost', 'right')}
              <th scope="col" className="px-3 py-2 font-medium">Findings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((call) => {
              const Icon = call.is_model ? Bot : Wrench
              const open = call.findings.filter((f) => !f.dismissed)
              const selected = call.id === selectedCallId
              return (
                <tr
                  key={call.id}
                  onClick={() => onSelectCall(call.id)}
                  className={cn('cursor-pointer transition-colors', selected ? 'bg-accent-soft' : 'hover:bg-hover')}
                >
                  <td className="px-3 py-2.5 text-ink-3 tabular">{call.step ?? '—'}</td>
                  <td className="max-w-[18rem] px-3 py-2.5">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelectCall(call.id)
                      }}
                      className="flex min-w-0 items-center gap-2 text-left"
                    >
                      <Icon aria-hidden className={cn('size-3.5 shrink-0', call.is_model ? 'text-model' : 'text-tool')} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{call.resource.name}</span>
                        <span className="block truncate text-xs text-ink-3">
                          {call.resource.provider} · {call.resource.operation}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-2 tabular">{formatOffset(call.event_ms - startMs)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-ink-2 tabular">
                    {call.duration_ms != null ? formatDuration(call.duration_ms) : <span className="text-ink-3">not reported</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-ink-2 tabular">
                    {call.is_model ? `${tokens(call, 'input_tokens')} / ${tokens(call, 'output_tokens')}` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap font-medium tabular">
                    <Money amount={call.cost.amount} currency={call.cost.currency} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1">
                      {[...new Set(open.map((f) => f.category))].map((category) => {
                        const meta = categoryMeta(category)
                        return (
                          <Tip key={category} content={meta.label}>
                            <span className="relative inline-flex size-6 items-center justify-center rounded-md bg-candidate-soft text-candidate-ink">
                              <meta.icon aria-hidden className="size-3.5" />
                              <span className="sr-only">{meta.label}</span>
                            </span>
                          </Tip>
                        )
                      })}
                      {open.length === 0 && <span className="text-ink-3">—</span>}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5 text-xs text-ink-3">
          Page {current + 1} of {pages}
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}>
            <ChevronLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </Card>
  )
}
