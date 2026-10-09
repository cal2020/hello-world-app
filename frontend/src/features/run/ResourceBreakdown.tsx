import { Bot, Wrench } from 'lucide-react'
import { useMemo } from 'react'

import type { ResourceRow } from '../../api/types'
import { Card, CardHeader } from '../../components/ui/card'
import { SpendValue } from '../../components/ui/money'
import { cn } from '../../lib/cn'
import { hasEstimates } from '../../lib/cost-basis'
import { geometryValue, plural } from '../../lib/format'

export function ResourceBreakdown({ rows, title = 'Cost by model and tool' }: { rows: ResourceRow[]; title?: string }) {
  const { ordered, maxByCurrency, currencies } = useMemo(() => {
    const max: Record<string, number> = {}
    const seen = new Set<string>()
    for (const row of rows) {
      for (const m of row.spend.by_currency) {
        seen.add(m.currency)
        max[m.currency] = Math.max(max[m.currency] ?? 0, geometryValue(m.amount))
      }
    }
    const sorted = [...rows].sort(
      (a, b) =>
        geometryValue(b.spend.by_currency[0]?.amount) - geometryValue(a.spend.by_currency[0]?.amount) ||
        b.calls - a.calls,
    )
    return { ordered: sorted, maxByCurrency: max, currencies: [...seen] }
  }, [rows])

  return (
    <Card aria-labelledby="resources-title">
      <CardHeader
        titleId="resources-title"
        title={title}
        description={
          rows.some((row) => hasEstimates(row.spend))
            ? 'Cost per resource, estimated from token counts at Anthropic list prices.'
            : currencies.length > 1
              ? 'Observed cost per resource. Bars compare amounts within the same currency only.'
              : 'Observed cost per resource, from reported cost.total_cost.'
        }
      />
      <ul className="space-y-1 px-5 pb-4">
        {ordered.map((row) => {
          const first = row.spend.by_currency[0]
          const width = first ? (geometryValue(first.amount) / (maxByCurrency[first.currency] || 1)) * 100 : 0
          const Icon = row.resource_type === 'model' ? Bot : Wrench
          return (
            <li key={`${row.resource_type}:${row.provider}:${row.name}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-1.5 @xl:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
              <span className="flex min-w-0 items-center gap-2">
                <Icon aria-hidden className={cn('size-3.5 shrink-0', row.resource_type === 'model' ? 'text-model' : 'text-tool')} />
                <span className="truncate text-[13px] font-medium" title={row.name}>
                  {row.name}
                </span>
                <span className="hidden truncate text-xs text-ink-3 @2xl:inline">{row.provider}</span>
              </span>
              <span className="order-3 col-span-2 h-2 overflow-hidden rounded-full bg-hover @xl:order-none @xl:col-span-1" aria-hidden>
                {first && (
                  <span
                    className={cn('block h-full rounded-full', row.resource_type === 'model' ? 'bg-model' : 'bg-tool')}
                    style={{ width: `${Math.max(width, first && geometryValue(first.amount) > 0 ? 1.5 : 0)}%` }}
                  />
                )}
              </span>
              <span className="text-right text-[13px] whitespace-nowrap">
                <SpendValue spend={row.spend} className="font-medium tabular" />
                <span className="ml-2 text-xs text-ink-3">{plural(row.calls, 'call')}</span>
                {row.spend.unknown_calls > 0 && (
                  <span className="ml-1.5 text-xs text-warn-ink">· {row.spend.unknown_calls} unknown</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
