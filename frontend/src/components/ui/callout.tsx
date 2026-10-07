import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

const tones = {
  info: { box: 'bg-surface-2 border-line text-ink-2', icon: Info, iconClass: 'text-ink-3' },
  warn: { box: 'bg-warn-soft border-transparent text-warn-ink', icon: TriangleAlert, iconClass: '' },
  error: { box: 'bg-bad-soft border-transparent text-bad-ink', icon: CircleAlert, iconClass: '' },
} as const

export function Callout({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: keyof typeof tones
  title?: ReactNode
  children?: ReactNode
  className?: string
  action?: ReactNode
}) {
  const { box, icon: Icon, iconClass } = tones[tone]
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={cn('flex gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-5', box, className)}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5')}>{children}</div>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  )
}
