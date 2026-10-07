import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

export interface SelectGroup {
  label: string
  items: { value: string; label: string; hint?: string; disabled?: boolean }[]
}

export function Select({
  value,
  onChange,
  groups,
  placeholder,
  label,
  id,
  icon,
}: {
  value: string | null
  onChange: (value: string) => void
  groups: SelectGroup[]
  placeholder: string
  label: string
  id?: string
  icon?: ReactNode
}) {
  return (
    <S.Root value={value ?? undefined} onValueChange={onChange}>
      <S.Trigger
        id={id}
        aria-label={label}
        className={cn(
          'group inline-flex h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border border-line-strong bg-surface px-3 text-left text-sm shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
          'hover:bg-hover data-[placeholder]:text-ink-3 focus-visible:border-accent',
        )}
      >
        {icon && <span className="text-ink-3 [&_svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon className="text-ink-3">
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-[min(420px,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] min-w-[280px] animate-pop-in overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <S.Viewport className="p-1.5">
            {groups.map((group) => (
              <S.Group key={group.label}>
                <S.Label className="truncate px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
                  {group.label}
                </S.Label>
                {group.items.map((item) => (
                  <S.Item
                    key={item.value}
                    value={item.value}
                    disabled={item.disabled}
                    className="relative flex cursor-default flex-col rounded-lg py-2 pr-8 pl-2.5 text-[13px] outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover"
                  >
                    <S.ItemText>{item.label}</S.ItemText>
                    {item.hint && <span className="text-xs text-ink-3">{item.hint}</span>}
                    <S.ItemIndicator className="absolute top-2.5 right-2.5 text-accent-ink">
                      <Check className="size-4" />
                    </S.ItemIndicator>
                  </S.Item>
                ))}
              </S.Group>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}
