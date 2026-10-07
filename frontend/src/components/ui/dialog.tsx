import { AlertDialog as A, Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { Button } from './button'

const overlay = 'fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] animate-fade-in'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[min(88dvh,820px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'animate-pop-in rounded-2xl border border-line bg-surface shadow-pop focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
            <div className="min-w-0">
              <D.Title className="text-lg font-semibold tracking-[-0.01em]">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-ink-2">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close dialog" className="-mr-2">
                <X />
              </Button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-5 scrollbar-thin">{children}</div>
          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  children?: ReactNode
  confirmLabel: string
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className={overlay} />
        <A.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-pop-in rounded-2xl border border-line bg-surface p-6 shadow-pop focus:outline-none">
          <A.Title className="text-lg font-semibold tracking-[-0.01em]">{title}</A.Title>
          <A.Description className="mt-1.5 text-sm text-ink-2">{description}</A.Description>
          {children && <div className="mt-4">{children}</div>}
          <div className="mt-6 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </A.Cancel>
            <Button variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? 'Deleting…' : confirmLabel}
            </Button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  )
}

/** Side panel used for the sidebar and inspector on narrow screens. */
export function Sheet({
  open,
  onOpenChange,
  side,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  side: 'left' | 'right'
  title: string
  children: ReactNode
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(
            'fixed inset-y-0 z-50 flex w-[min(420px,calc(100vw-24px))] flex-col bg-surface shadow-pop focus:outline-none',
            side === 'left'
              ? 'left-0 animate-slide-in-left border-r border-line'
              : 'right-0 animate-slide-in-right border-l border-line',
          )}
        >
          <D.Title className="sr-only">{title}</D.Title>
          <D.Description className="sr-only">{title}</D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
