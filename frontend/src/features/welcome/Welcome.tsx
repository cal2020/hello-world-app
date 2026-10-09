import { Coins, GitCompareArrows, Microscope, ShieldCheck, Sparkles, SquareTerminal, Upload } from 'lucide-react'

import { IN_BROWSER } from '../../api/transport'
import type { Meta } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { FormatHelp } from './FormatHelp'

const FEATURES = [
  {
    icon: Coins,
    title: 'Observed spend, exactly',
    body: 'Decimal totals per currency, straight from the telemetry. Calls without a reported cost stay visibly unknown and never count as zero.',
  },
  {
    icon: Microscope,
    title: 'Evidence, not verdicts',
    body: 'Every optimization candidate links to its records, the rule that fired, the analyzer’s rationale and its limits.',
  },
  {
    icon: GitCompareArrows,
    title: 'Measured change',
    body: 'Compare two runs after you mark whether they did equivalent work. Zero and unknown baselines are handled honestly.',
  },
]

export function Welcome({
  meta,
  onLoadDemo,
  onImport,
  demoLoading,
}: {
  meta: Meta | undefined
  onLoadDemo: () => void
  onImport: () => void
  demoLoading: boolean
}) {
  return (
    <div className="relative isolate overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-glow" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] bg-dots [mask-image:linear-gradient(to_bottom,black_20%,transparent)]"
      />
      <div className="mx-auto max-w-4xl px-5 pt-14 pb-16 sm:px-8 sm:pt-20">
        <Badge tone="accent" className="h-7 px-3 text-xs">
          <ShieldCheck /> {IN_BROWSER ? 'Runs in your browser' : 'Runs locally'} · AUDR {meta?.audr_spec_version ?? '1.0.0'} · {meta?.analyzer.name ?? 'KORA Doctor'}{' '}
          {meta?.analyzer.version ?? '0.1.0'}
        </Badge>
        <h1 className="mt-6 text-[2.5rem] leading-[1.04] font-semibold tracking-[-0.04em] text-balance sm:text-[3.4rem]">
          See where your agent’s money goes —{' '}
          <span className="bg-gradient-to-r from-accent to-[#d95926] bg-clip-text text-transparent dark:to-[#f59e6b]">
            and which calls deserve a second look.
          </span>
        </h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-7 text-ink-2 text-pretty">
          Import AUDR telemetry or your Claude Code transcripts, follow every model and tool call on a timeline, review
          optimization candidates with the evidence behind them, and measure what changed after a fix.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button size="lg" variant="primary" onClick={onLoadDemo} disabled={demoLoading}>
            <Sparkles /> {demoLoading ? 'Loading demo…' : 'Explore the demo'}
          </Button>
          <Button size="lg" onClick={onImport}>
            <Upload /> Import a file
          </Button>
        </div>
        <p className="mt-3 text-[13px] text-ink-3">
          The demo adds three synthetic, documented runs, labelled as synthetic everywhere.
        </p>

        <section
          aria-labelledby="claude-code-title"
          className="mt-8 flex max-w-2xl flex-col gap-3 rounded-2xl border border-line bg-surface/80 p-4 shadow-card backdrop-blur sm:flex-row sm:items-center"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
            <SquareTerminal className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="claude-code-title" className="text-sm font-semibold">
              Using Claude Code?
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-2">
              Import session transcripts from <code className="text-[12px]">~/.claude/projects</code> to see what each call
              would cost at API list prices. The conversation itself never leaves this device.
            </p>
          </div>
          <Button onClick={onImport} className="shrink-0">
            Import transcripts
          </Button>
        </section>

        <div className="mt-14 grid gap-4 @2xl:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-line bg-surface/80 p-5 shadow-card backdrop-blur">
              <div className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
                <Icon className="size-[18px]" />
              </div>
              <p className="mt-3.5 text-[15px] font-semibold tracking-[-0.01em]">{title}</p>
              <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{body}</p>
            </div>
          ))}
        </div>

        <h2 className="mt-14 text-sm font-semibold">What you can import</h2>
        <FormatHelp meta={meta} className="mt-3" />
      </div>
    </div>
  )
}
