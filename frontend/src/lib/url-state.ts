import { useSyncExternalStore } from 'react'

import type { Equivalence } from '../api/types'

/** View selection lives in the URL, so reload and back/forward restore it. */
export interface UrlState {
  view: 'inspect' | 'compare'
  import: string | null
  run: string | null
  finding: string | null
  call: string | null
  base: string | null
  cand: string | null
  eq: Equivalence | null
}

const EQUIVALENCES: readonly Equivalence[] = ['equivalent', 'not_equivalent', 'unsure']
const listeners = new Set<() => void>()
let cache: { search: string; state: UrlState } | null = null

function parse(search: string): UrlState {
  const params = new URLSearchParams(search)
  const eq = params.get('eq')
  return {
    view: params.get('view') === 'compare' ? 'compare' : 'inspect',
    import: params.get('import'),
    run: params.get('run'),
    finding: params.get('finding'),
    call: params.get('call'),
    base: params.get('base'),
    cand: params.get('cand'),
    eq: EQUIVALENCES.includes(eq as Equivalence) ? (eq as Equivalence) : null,
  }
}

function snapshot(): UrlState {
  const search = window.location.search
  if (!cache || cache.search !== search) cache = { search, state: parse(search) }
  return cache.state
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  window.addEventListener('popstate', callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('popstate', callback)
  }
}

export function serialize(state: UrlState): string {
  const params = new URLSearchParams()
  if (state.view === 'compare') params.set('view', 'compare')
  const keys = ['import', 'run', 'finding', 'call', 'base', 'cand', 'eq'] as const
  for (const key of keys) {
    const value = state[key]
    if (value) params.set(key, value)
  }
  const text = params.toString()
  return text ? `?${text}` : window.location.pathname
}

export function navigate(patch: Partial<UrlState>, options: { replace?: boolean } = {}): void {
  const next = { ...snapshot(), ...patch }
  const url = serialize(next)
  if (url === (window.location.search || window.location.pathname)) return
  if (options.replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  for (const listener of listeners) listener()
}

export function useUrlState(): [UrlState, typeof navigate] {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  return [state, navigate]
}
