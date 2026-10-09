import type { Money, Spend } from '../api/types'

export const MINUS = '−'
const MAX_FRACTION_DIGITS = 8

export function fractionDigits(amount: string): number {
  const dot = amount.indexOf('.')
  return dot < 0 ? 0 : amount.length - dot - 1
}

/** True when the display rounds away digits of the exact amount. */
export function isRounded(amount: string): boolean {
  return fractionDigits(amount.replace(/^[-+]/, '')) > MAX_FRACTION_DIGITS
}

// Building an Intl.NumberFormat is far slower than using one; large runs format
// thousands of amounts per render.
const moneyFormatters = new Map<string, Intl.NumberFormat>()

function moneyFormatter(currency: string, belowOne: boolean, signed: boolean): Intl.NumberFormat {
  const key = `${currency}|${belowOne ? 1 : 0}|${signed ? 1 : 0}`
  let formatter = moneyFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: belowOne ? 4 : 2,
      maximumFractionDigits: MAX_FRACTION_DIGITS,
      signDisplay: signed ? 'exceptZero' : 'auto',
    })
    moneyFormatters.set(key, formatter)
  }
  return formatter
}

/**
 * Formats an exact decimal string. Intl.NumberFormat receives the string itself,
 * which it treats as an exact decimal, so no digit passes through binary floating
 * point. Unknown costs are labelled, never shown as zero.
 */
export function formatMoney(
  amount: string | null | undefined,
  currency: string | null | undefined,
  options: { signed?: boolean } = {},
): string {
  if (amount == null || currency == null) return 'Unknown'
  const magnitude = amount.replace(/^[-+]/, '')
  const belowOne = (magnitude.split('.')[0] ?? '0') === '0'
  try {
    const formatter = moneyFormatter(currency, belowOne, Boolean(options.signed))
    return formatter.format(amount as Intl.StringNumericLiteral).replace('-', MINUS)
  } catch {
    return `${amount.replace('-', MINUS)} ${currency}`
  }
}

export function formatMoneyItem(item: Money, options: { signed?: boolean } = {}): string {
  return formatMoney(item.amount, item.currency, options)
}

/** "$0.0991" or "$0.0014 + €0.0070"; currencies are listed, never summed. */
export function formatSpend(spend: Spend): string {
  if (spend.by_currency.length === 0) return spend.unknown_calls ? 'Unknown' : formatMoney('0', 'USD')
  return spend.by_currency.map((m) => formatMoneyItem(m)).join(' + ')
}

export function formatPercent(value: string | null | undefined, signed = true): string {
  if (value == null) return '—'
  const negative = value.startsWith('-')
  const magnitude = value.replace(/^[-+]/, '')
  const sign = negative ? MINUS : signed && Number(magnitude) !== 0 ? '+' : ''
  return `${sign}${magnitude}%`
}

export function formatInt(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-US')
}

export function formatSignedInt(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value === 0) return '0'
  return `${value > 0 ? '+' : MINUS}${Math.abs(value).toLocaleString('en-US')}`
}

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function formatCompact(value: number): string {
  return compactFormatter.format(value)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  if (ms < 3_600_000) {
    const seconds = Math.round(ms / 1000)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }
  if (ms < 86_400_000) {
    const minutes = Math.round(ms / 60_000)
    const rest = minutes % 60
    return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`
  }
  const hours = Math.round(ms / 3_600_000)
  const rest = hours % 24
  return rest ? `${Math.floor(hours / 24)}d ${rest}h` : `${hours / 24}d`
}

export function formatOffset(ms: number): string {
  return `+${formatDuration(Math.max(0, ms))}`
}

export function formatDateTime(epochMs: number): string {
  const date = new Date(epochMs)
  const base = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

/** A calendar date such as 9 Oct 2026, from YYYY-MM-DD. */
export function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!year || !month || !day) return isoDate
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((then - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86_400), 'day')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

export function shortId(id: string, keep = 10): string {
  return id.length <= keep + 3 ? id : `${id.slice(0, keep)}…`
}

/** Numeric value for chart geometry only (bar widths); never for displayed money. */
export function geometryValue(amount: string | null | undefined): number {
  if (amount == null) return 0
  const value = Number(amount)
  return Number.isFinite(value) ? Math.abs(value) : 0
}
