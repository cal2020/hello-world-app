import type { Money as MoneyValue, Spend } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatMoney, isRounded } from '../../lib/format'

/** One amount. Hover shows the exact decimal; unknown is labelled, never zero. */
export function Money({
  amount,
  currency,
  signed = false,
  className,
}: {
  amount: string | null | undefined
  currency: string | null | undefined
  signed?: boolean
  className?: string
}) {
  if (amount == null || currency == null) {
    return (
      <span className={cn('text-warn-ink', className)} title="No cost was reported for this call">
        Unknown
      </span>
    )
  }
  const text = formatMoney(amount, currency, { signed })
  const exact = `${amount} ${currency}`
  return (
    <span className={className} title={isRounded(amount) ? `Exact: ${exact}` : exact}>
      {isRounded(amount) && <span aria-hidden>≈</span>}
      {text}
    </span>
  )
}

/** A spend total: one line per currency (never summed across currencies). */
export function SpendValue({ spend, className }: { spend: Spend; className?: string }) {
  if (spend.by_currency.length === 0) {
    return <span className={cn('text-warn-ink', className)}>{spend.unknown_calls ? 'Unknown' : '—'}</span>
  }
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1.5', className)}>
      {spend.by_currency.map((m: MoneyValue, index) => (
        <span key={m.currency} className="inline-flex items-baseline gap-1.5">
          {index > 0 && <span className="text-ink-3">+</span>}
          <Money amount={m.amount} currency={m.currency} />
        </span>
      ))}
    </span>
  )
}
