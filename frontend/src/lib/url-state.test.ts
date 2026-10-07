import { afterEach, describe, expect, it } from 'vitest'

import { navigate, serialize, type UrlState } from './url-state'

const EMPTY: UrlState = { view: 'inspect', import: null, run: null, finding: null, call: null, base: null, cand: null, eq: null }

describe('url state', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('serializes only what is set', () => {
    expect(serialize({ ...EMPTY, run: 'run_1', finding: 'fnd_2' })).toBe('?run=run_1&finding=fnd_2')
    expect(serialize({ ...EMPTY, view: 'compare', base: 'a', cand: 'b', eq: 'equivalent' })).toBe(
      '?view=compare&base=a&cand=b&eq=equivalent',
    )
  })

  it('navigates by merging into the current state, so reload restores the view', () => {
    navigate({ run: 'run_1' })
    navigate({ finding: 'fnd_9' })
    expect(window.location.search).toBe('?run=run_1&finding=fnd_9')
    navigate({ finding: null, call: 'call_3' }, { replace: true })
    expect(window.location.search).toBe('?run=run_1&call=call_3')
  })
})
