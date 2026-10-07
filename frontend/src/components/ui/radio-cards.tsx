import { RadioGroup } from 'radix-ui'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

export function RadioCards<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T | null
  onChange: (value: T) => void
  options: { value: T; title: string; description: string; icon: ReactNode }[]
  label: string
}) {
  return (
    <RadioGroup.Root
      value={value ?? ''}
      onValueChange={(next) => onChange(next as T)}
      aria-label={label}
      className="grid gap-2 @2xl:grid-cols-3"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'group flex items-start gap-3 rounded-xl border border-line-strong bg-surface p-3.5 text-left transition-colors',
            'hover:bg-hover data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft',
            'data-[state=checked]:shadow-[0_0_0_1px_var(--accent)]',
          )}
        >
          <span className="mt-0.5 text-ink-3 group-data-[state=checked]:text-accent-ink [&_svg]:size-[18px]">
            {option.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">{option.title}</span>
            <span className="mt-0.5 block text-[13px] leading-5 text-ink-2">{option.description}</span>
          </span>
          <span
            aria-hidden
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong group-data-[state=checked]:border-accent"
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
