import type { ReactNode } from 'react'

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-2xl border border-line bg-surface-2 text-ink-3 [&_svg]:size-5">
        {icon}
      </div>
      <p className="text-sm font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
