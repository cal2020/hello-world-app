import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/cn'

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-2xl border border-line bg-surface shadow-card', className)} {...props} />
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
  titleId,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  className?: string
  titleId?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="flex min-w-0 flex-[1_1_18rem] items-start gap-2.5">
        {icon && <span className="mt-0.5 text-ink-3 [&_svg]:size-4">{icon}</span>}
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description && <p className="text-[13px] leading-5 text-ink-3">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
