import type { CallRecord } from '../../api/types'

/** Step order (calls without a step last), then completion time, then file order. */
export function sortCalls(calls: CallRecord[]): CallRecord[] {
  return [...calls].sort(
    (a, b) => (a.step ?? Infinity) - (b.step ?? Infinity) || a.event_ms - b.event_ms || a.ordinal - b.ordinal,
  )
}
