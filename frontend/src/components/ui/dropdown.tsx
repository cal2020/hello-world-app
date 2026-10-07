import { DropdownMenu as M } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/cn'

export const DropdownMenu = M.Root
export const DropdownTrigger = M.Trigger

export function DropdownContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className="z-50 min-w-[220px] animate-pop-in rounded-xl border border-line bg-surface p-1.5 shadow-pop focus:outline-none"
      >
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function DropdownItem({
  className,
  danger = false,
  ...props
}: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn(
        'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none [&_svg]:size-4',
        danger ? 'text-bad-ink data-[highlighted]:bg-bad-soft' : 'text-ink data-[highlighted]:bg-hover',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{children}</M.Label>
}

export function DropdownSeparator() {
  return <M.Separator className="my-1.5 h-px bg-line" />
}

export const DropdownRadioGroup = M.RadioGroup

export function DropdownRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem
      className={cn(
        'flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-8 text-[13px] text-ink outline-none select-none data-[highlighted]:bg-hover [&_svg]:size-4',
        'relative',
        className,
      )}
      {...props}
    >
      <M.ItemIndicator className="absolute left-2.5 inline-flex">
        <span className="size-1.5 rounded-full bg-accent" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  )
}
