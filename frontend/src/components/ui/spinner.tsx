import { LoaderCircle } from 'lucide-react'

import { cn } from '../../lib/cn'

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle role="img" aria-label={label} className={cn('size-4 animate-spin text-ink-3', className)} />
}
