import { ToggleGroup } from 'radix-ui'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T
  onChange: (value: T) => void
  items: { value: T; label: ReactNode; icon?: ReactNode; text: string }[]
  label: string
  className?: string
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      aria-label={label}
      className={cn('inline-flex h-9 items-center gap-0.5 rounded-xl border border-line bg-hover/70 p-0.5', className)}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          aria-label={item.text}
          className={cn(
            'inline-flex h-7.5 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium text-ink-2 transition-colors [&_svg]:size-4',
            'hover:text-ink data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--line)]',
          )}
        >
          {item.icon}
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
