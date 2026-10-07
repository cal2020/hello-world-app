import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ComparisonResult, ComparisonScope, Spend } from '../../api/types'
import { ComparisonResultView } from './ComparisonResultView'

const spend = (amount: string | null, unknown = 0): Spend => ({
  by_currency: amount == null ? [] : [{ currency: 'USD', amount }],
  known_calls: amount == null ? 0 : 1,
  unknown_calls: unknown,
  total_calls: (amount == null ? 0 : 1) + unknown,
  complete: unknown === 0 && amount != null,
})

function scope(partial: Partial<ComparisonScope>): ComparisonScope {
  return {
    scope: 'all_calls',
    label: 'All calls',
    comparable: true,
    reasons: [],
    notes: [],
    rows: [],
    baseline_spend: spend('0'),
    candidate_spend: spend('0'),
    ...partial,
  }
}

function result(partial: Partial<ComparisonResult>): ComparisonResult {
  const ref = (id: string) => ({
    id,
    run_id: id,
    display_name: id,
    import_id: 'imp',
    import_filename: 'x.jsonl',
    synthetic: false,
    calls: 1,
    spend: spend('1'),
  })
  const delta = { baseline: 1, candidate: 1, delta: 0 }
  const tokenDelta = { ...delta, baseline_reported: '1/1', candidate_reported: '1/1' }
  return {
    baseline: ref('baseline-run'),
    candidate: ref('candidate-run'),
    equivalence: 'equivalent',
    kind: 'measured_change',
    headline_scope: 'all_calls',
    scopes: [],
    usage: {
      calls: delta,
      model_calls: delta,
      tool_calls: { baseline: 0, candidate: 0, delta: 0 },
      tokens: {
        input_tokens: tokenDelta,
        output_tokens: tokenDelta,
        reasoning_tokens: { baseline: null, candidate: null, delta: null, baseline_reported: '0/1', candidate_reported: '0/1' },
        cache_read_tokens: { baseline: null, candidate: null, delta: null, baseline_reported: '0/1', candidate_reported: '0/1' },
        cache_write_tokens: { baseline: null, candidate: null, delta: null, baseline_reported: '0/1', candidate_reported: '0/1' },
        requests: tokenDelta,
      },
    },
    by_model: [],
    findings: { baseline_open: 2, candidate_open: 1, baseline_flagged_calls: 2, candidate_flagged_calls: 1 },
    outcomes: { baseline: 'resolved', candidate: 'resolved' },
    quality: {
      measured: false,
      note: 'AUDR telemetry carries no output-quality measure. This comparison covers cost and usage only.',
    },
    notes: [],
    ...partial,
  }
}

describe('ComparisonResultView', () => {
  it('shows a measured decrease with exact amounts', () => {
    const s = scope({
      rows: [{ currency: 'USD', baseline: '0.09912', candidate: '0.07272', delta: '-0.0264', percent: '-26.63', percent_note: null }],
    })
    render(<ComparisonResultView result={result({ scopes: [s] })} />)
    expect(screen.getByText('Measured change')).toBeInTheDocument()
    expect(screen.getAllByText('−$0.0264').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−26.63%').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('lower')).toBeInTheDocument()
  })

  it('never shows a percentage for a zero baseline', () => {
    const s = scope({
      rows: [
        {
          currency: 'USD',
          baseline: '0',
          candidate: '0.75',
          delta: '0.75',
          percent: null,
          percent_note: 'The baseline is 0 in this currency, so a percentage change is undefined.',
        },
      ],
    })
    render(<ComparisonResultView result={result({ scopes: [s] })} />)
    expect(screen.getByText(/percentage change is undefined/)).toBeInTheDocument()
    // No formatted percentage value anywhere (the "%" column header is fine).
    expect(document.body.textContent).not.toMatch(/[+−-]?\d[\d.,]*%/)
  })

  it('explains why runs with unknown costs are not comparable', () => {
    const reason = 'The baseline has 1 call(s) without a reported cost, so its total is incomplete.'
    const s = scope({
      comparable: false,
      reasons: [reason],
      rows: [{ currency: 'USD', baseline: '0.25', candidate: '0.5', delta: null, percent: null, percent_note: null }],
      baseline_spend: spend('0.25', 1),
    })
    render(<ComparisonResultView result={result({ kind: 'not_comparable', headline_scope: null, scopes: [s] })} />)
    expect(screen.getAllByText('Not comparable').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/baseline has 1 call\(s\) without a reported cost/).length).toBeGreaterThan(0)
  })

  it('always carries the no-quality-measure note and makes no quality claim', () => {
    render(<ComparisonResultView result={result({ scopes: [scope({})] })} />)
    expect(screen.getByText(/carries no output-quality measure/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/quality (is|was) (preserved|maintained|unchanged)|same quality/i)
  })
})
