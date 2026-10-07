import { Braces, DatabaseZap, Feather, Network, Repeat2, type LucideIcon } from 'lucide-react'

import type { Category } from '../api/types'

/**
 * Category identity is carried by icon + label, in one "candidate" hue. Five hues
 * would not stay distinguishable when any two categories sit side by side.
 */
export const CATEGORY_META: Record<Category, { label: string; short: string; icon: LucideIcon; blurb: string }> = {
  duplicate_repeated: {
    label: 'Repeated call',
    short: 'Repeated',
    icon: Repeat2,
    blurb: 'Same usage signature repeated within one run',
  },
  cache_reuse: {
    label: 'Cache / reuse candidate',
    short: 'Reuse',
    icon: DatabaseZap,
    blurb: 'Same usage signature seen in other runs',
  },
  deterministic_candidate: {
    label: 'Deterministic alternative',
    short: 'Rules',
    icon: Braces,
    blurb: 'Run or label text suggests a task code could do',
  },
  smaller_model_candidate: {
    label: 'Cheaper-model review',
    short: 'Model',
    icon: Feather,
    blurb: 'Short call on a high-end model',
  },
  orchestration_overhead: {
    label: 'Orchestration overhead',
    short: 'Steps',
    icon: Network,
    blurb: 'Many model calls in one run',
  },
}

export const CATEGORY_ORDER: Category[] = [
  'duplicate_repeated',
  'cache_reuse',
  'deterministic_candidate',
  'smaller_model_candidate',
  'orchestration_overhead',
]

export function categoryMeta(category: string) {
  return CATEGORY_META[category as Category] ?? CATEGORY_META.duplicate_repeated
}
