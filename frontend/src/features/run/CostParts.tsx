import type { CostParts as CostPartsData, Spend } from '../../api/types'
import { Card, CardHeader } from '../../components/ui/card'
import { Money } from '../../components/ui/money'
import { hasEstimates } from '../../lib/cost-basis'
import { formatInt, geometryValue } from '../../lib/format'

const PARTS = {
  cache_read_cost: { label: 'Cache reads', counter: 'cache_read_tokens', note: 'context re-read from the cache' },
  cache_write_cost: { label: 'Cache writes', counter: 'cache_write_tokens', note: 'context written to the cache' },
  output_token_cost: { label: 'Output', counter: 'output_tokens', note: 'text and tool calls' },
  reasoning_cost: { label: 'Thinking', counter: 'reasoning_tokens', note: 'billed as output' },
  input_token_cost: { label: 'Uncached input', counter: 'input_tokens', note: 'read without the cache' },
} as const

type Part = keyof typeof PARTS

/** Model-call cost split by token type, for telemetry that reports the split. */
export function CostParts({ parts, spend }: { parts: CostPartsData | null | undefined; spend: Spend }) {
  if (!parts) return null
  const partial = parts.covered_calls < parts.priced_model_calls
  return (
    <Card aria-labelledby="cost-parts-title">
      <CardHeader
        titleId="cost-parts-title"
        title="Where the cost goes"
        description={
          `Model-call cost by token type${hasEstimates(spend) ? ', estimated at Anthropic list prices' : ''}.` +
          (partial ? ` ${parts.covered_calls} of ${parts.priced_model_calls} priced model calls report the split.` : '')
        }
      />
      {parts.by_currency.map(({ currency, parts: amounts }) => {
        const rows = (Object.keys(PARTS) as Part[])
          .filter((part) => amounts[part] != null)
          .map((part) => ({ part, amount: amounts[part] ?? '0', value: geometryValue(amounts[part]) }))
          .sort((a, b) => b.value - a.value)
        const total = rows.reduce((sum, row) => sum + row.value, 0)
        return (
          <ul key={currency} className="space-y-1 px-5 pb-4" aria-label={`Cost by token type in ${currency}`}>
            {rows.map(({ part, amount, value }) => {
              const share = total > 0 ? value / total : 0
              const info = PARTS[part]
              const tokens = parts.tokens[info.counter]
              return (
                <li
                  key={part}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-1.5 @xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_auto]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{info.label}</span>
                    <span className="block text-xs text-ink-3">
                      {tokens != null ? `${formatInt(tokens)} tokens · ` : ''}
                      {info.note}
                    </span>
                  </span>
                  <span className="order-3 col-span-2 h-2 overflow-hidden rounded-full bg-hover @xl:order-none @xl:col-span-1" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-model"
                      style={{ width: `${Math.max(share * 100, value > 0 ? 1.5 : 0)}%` }}
                    />
                  </span>
                  <span className="text-right text-[13px] whitespace-nowrap tabular">
                    <Money amount={amount} currency={currency} />
                    <span className="ml-2 inline-block w-11 text-xs text-ink-3">{Math.round(share * 100)}%</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )
      })}
    </Card>
  )
}
