import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from './button'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy ${label}` : `Copy ${label}`}
      title={state === 'failed' ? 'Copy failed: clipboard unavailable' : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setState('copied')
        } catch {
          setState('failed')
        }
      }}
    >
      {state === 'copied' ? <Check className="text-good-ink" /> : <Copy />}
    </Button>
  )
}
