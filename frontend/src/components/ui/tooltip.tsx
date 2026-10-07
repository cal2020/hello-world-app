import { Tooltip as T } from 'radix-ui'
import type { ReactNode } from 'react'

export const TooltipProvider = T.Provider

export function Tip({
  content,
  children,
  side = 'top',
  align = 'center',
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}) {
  if (content == null || content === '') return <>{children}</>
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-xs animate-pop-in rounded-lg bg-ink px-2.5 py-1.5 text-xs leading-5 text-page shadow-pop"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
