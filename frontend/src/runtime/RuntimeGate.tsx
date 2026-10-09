import { Check, Download, Loader2, RotateCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'

import { LogoMark } from '../components/layout/Logo'
import { Button } from '../components/ui/button'
import { cn } from '../lib/cn'
import { getEngineState, startEngine, subscribeEngine, type EngineState } from './bridge'
import { BOOT_STEPS } from './protocol'

/** Browser build: shows startup progress until the in-browser engine is ready. */
export function RuntimeGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeEngine, getEngineState)
  useEffect(() => startEngine(), [])
  if (state.phase === 'ready') return children
  return <BootScreen state={state} />
}

function BootScreen({ state }: { state: Exclude<EngineState, { phase: 'ready' }> }) {
  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-glow" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-dots [mask-image:linear-gradient(to_bottom,black_20%,transparent)]"
      />
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-pop sm:p-7">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-[-0.015em]">AI Cost Inspector</span>
        </div>
        {state.phase === 'failed' ? <Failure state={state} /> : <Progress step={state.step} />}
      </div>
    </main>
  )
}

function Progress({ step }: { step: number }) {
  return (
    <>
      <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em]">Starting the analysis engine</h1>
      <p className="mt-1.5 text-[13.5px] leading-5 text-ink-2">
        The same Python backend as the desktop version, running inside this page.
      </p>
      <ol className="mt-5 space-y-2.5" aria-label="Startup progress">
        {BOOT_STEPS.map((label, index) => {
          const done = index < step
          const current = index === step
          return (
            <li key={label} className="flex items-center gap-2.5 text-[13.5px]" aria-current={current ? 'step' : undefined}>
              <span
                aria-hidden
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5',
                  done ? 'bg-good-soft text-good-ink' : current ? 'text-accent-ink' : 'border border-line',
                )}
              >
                {done ? <Check /> : current ? <Loader2 className="animate-spin" /> : null}
              </span>
              <span className={cn(done ? 'text-ink-2' : current ? 'font-medium text-ink' : 'text-ink-3')}>{label}</span>
            </li>
          )
        })}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {BOOT_STEPS[step] ?? 'Starting'}…
      </p>
      <div className="mt-5 space-y-2 border-t border-line pt-4 text-xs leading-5 text-ink-3">
        <p className="flex gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Files you import are analyzed on this device and never uploaded. Your data is saved in this browser.
        </p>
        <p className="flex gap-2">
          <Download aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          The first visit downloads about 19 MB; later visits start from the browser’s cache.
        </p>
      </div>
    </>
  )
}

function Failure({ state }: { state: Extract<EngineState, { phase: 'failed' }> }) {
  return (
    <div role="alert">
      <h1 className="mt-5 flex items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
        <TriangleAlert aria-hidden className="size-5 text-warn-ink" />
        {state.reason === 'locked' ? 'Already open in another tab' : 'The analysis engine couldn’t start'}
      </h1>
      <p className="mt-2 text-[13.5px] leading-5 text-ink-2">{state.message}</p>
      <Button className="mt-5" variant="primary" onClick={() => window.location.reload()}>
        <RotateCw /> Reload
      </Button>
    </div>
  )
}
