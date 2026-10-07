import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { formatInt } from '../../lib/format'
import { Button } from './button'

/**
 * Renders the first `initial` items and grows on request. One finding can flag more
 * than a thousand calls; drawing every row at once stalls the inspector.
 */
export function ShowMoreList<T>({
  items,
  render,
  as: List = 'ul',
  className,
  initial = 25,
  step = 100,
}: {
  items: readonly T[]
  render: (item: T, index: number) => ReactNode
  as?: 'ul' | 'ol'
  className?: string
  initial?: number
  step?: number
}) {
  const [limit, setLimit] = useState(initial)
  const hidden = Math.max(0, items.length - limit)
  return (
    <>
      <List className={className}>{items.slice(0, limit).map(render)}</List>
      {hidden > 0 && (
        <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setLimit((n) => n + step)}>
          <ChevronDown /> Show {formatInt(Math.min(step, hidden))} more · {formatInt(hidden)} not shown
        </Button>
      )}
    </>
  )
}
