import type { CostBasis, Spend } from '../api/types'

const LABELS: Record<CostBasis, string> = {
  none: 'Observed',
  reported: 'Observed',
  estimated: 'Estimated',
  mixed: 'Observed + estimated',
}

/** How to label an amount: reported by the telemetry, estimated at list prices, or both. */
export function costLabel(spend: Pick<Spend, 'basis'> | null | undefined): string {
  return LABELS[spend?.basis ?? 'reported']
}

/** The same label in running text: "observed", "estimated" or "observed + estimated". */
export function costWord(spend: Pick<Spend, 'basis'> | null | undefined): string {
  return costLabel(spend).toLowerCase()
}

/** Some known costs are list-price estimates rather than reported amounts. */
export function hasEstimates(spend: Pick<Spend, 'basis'> | null | undefined): boolean {
  return spend?.basis === 'estimated' || spend?.basis === 'mixed'
}
