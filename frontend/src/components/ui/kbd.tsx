import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface-2 px-1 text-[11px] font-medium text-ink-3',
        className,
      )}
      {...props}
    />
  )
}
