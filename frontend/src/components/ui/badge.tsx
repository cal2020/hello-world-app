import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

const tones = {
  neutral: 'bg-hover text-ink-2 border-line',
  outline: 'bg-transparent text-ink-2 border-line-strong',
  accent: 'bg-accent-soft text-accent-ink border-transparent',
  observed: 'bg-observed-soft text-observed-ink border-transparent',
  candidate: 'bg-candidate-soft text-candidate-ink border-transparent',
  estimate: 'bg-transparent text-candidate-ink border-dashed border-candidate',
  measured: 'bg-good-soft text-good-ink border-transparent',
  good: 'bg-good-soft text-good-ink border-transparent',
  bad: 'bg-bad-soft text-bad-ink border-transparent',
  warn: 'bg-warn-soft text-warn-ink border-transparent',
} as const

export type BadgeTone = keyof typeof tones

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] leading-none font-medium whitespace-nowrap [&_svg]:size-3.5',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
