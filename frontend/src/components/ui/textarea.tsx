import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3',
        'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/20',
        className,
      )}
      {...props}
    />
  )
}
