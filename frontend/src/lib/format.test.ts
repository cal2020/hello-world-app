import { describe, expect, it } from 'vitest'

import { formatDuration, formatMoney, formatPercent, formatSpend, isRounded, MINUS, plural } from './format'

describe('formatMoney', () => {
  it('keeps exact decimal digits without float rounding', () => {
    // 0.1 + 0.2 in binary floating point would print 0.30000000000000004
    expect(formatMoney('0.3', 'USD')).toBe('$0.3000')
    expect(formatMoney('0.09912', 'USD')).toBe('$0.09912')
    expect(formatMoney('0.0000001', 'USD')).toBe('$0.0000001')
    expect(formatMoney('12.5', 'USD')).toBe('$12.50')
  })

  it('rounds only past 8 decimals and says so', () => {
    expect(formatMoney('12.645679001234567891', 'USD')).toBe('$12.645679')
    expect(isRounded('12.645679001234567891')).toBe(true)
    expect(isRounded('0.09912')).toBe(false)
  })

  it('labels unknown cost instead of showing zero', () => {
    expect(formatMoney(null, 'USD')).toBe('Unknown')
    expect(formatMoney('0.5', null)).toBe('Unknown')
    expect(formatMoney('0', 'USD')).toBe('$0.0000')
  })

  it('formats other currencies and signed deltas', () => {
    expect(formatMoney('0.007', 'EUR')).toBe('€0.0070')
    expect(formatMoney('-0.0264', 'USD', { signed: true })).toBe(`${MINUS}$0.0264`)
    expect(formatMoney('0.0264', 'USD', { signed: true })).toBe('+$0.0264')
  })
})

describe('formatSpend', () => {
  it('lists currencies separately and never sums them', () => {
    const spend = {
      by_currency: [
        { currency: 'EUR', amount: '0.007' },
        { currency: 'USD', amount: '0.0014' },
      ],
      known_calls: 4,
      unknown_calls: 3,
      total_calls: 7,
      complete: false,
    }
    expect(formatSpend(spend)).toBe('€0.0070 + $0.0014')
  })

  it('reports unknown when no call has a cost', () => {
    expect(formatSpend({ by_currency: [], known_calls: 0, unknown_calls: 2, total_calls: 2, complete: false })).toBe('Unknown')
  })
})

describe('other formatters', () => {
  it('formats percentages with a real minus and explicit missing value', () => {
    expect(formatPercent('-26.63')).toBe(`${MINUS}26.63%`)
    expect(formatPercent('100')).toBe('+100%')
    expect(formatPercent('0')).toBe('0%')
    expect(formatPercent(null)).toBe('—')
  })

  it('formats durations and plurals', () => {
    expect(formatDuration(920)).toBe('920 ms')
    expect(formatDuration(2410)).toBe('2.41 s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(null)).toBe('—')
    expect(plural(1, 'call')).toBe('1 call')
    expect(plural(1200, 'call')).toBe('1,200 calls')
  })
})
