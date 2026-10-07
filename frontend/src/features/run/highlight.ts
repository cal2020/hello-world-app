import type { FindingSummary } from '../../api/types'

export interface TimelineHighlight {
  affected: Set<string>
  reference: Set<string>
}

/** Calls to emphasize on the timeline for the selected finding. */
export function highlightFor(finding: FindingSummary | null | undefined): TimelineHighlight | null {
  if (!finding) return null
  return {
    affected: new Set(finding.call_ids),
    reference: new Set(finding.reference_call_id ? [finding.reference_call_id] : []),
  }
}
