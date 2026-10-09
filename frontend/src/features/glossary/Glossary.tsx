import { MousePointerClick } from 'lucide-react'

import type { Meta } from '../../api/types'
import { Badge, type BadgeTone } from '../../components/ui/badge'

const ORDER: { key: keyof Meta['glossary']; label: string; tone: BadgeTone }[] = [
  { key: 'observed', label: 'Observed', tone: 'observed' },
  { key: 'estimated_cost', label: 'Estimated cost', tone: 'estimated' },
  { key: 'candidate', label: 'Candidate', tone: 'candidate' },
  { key: 'scenario_estimate', label: 'Scenario estimate', tone: 'estimate' },
  { key: 'measured_change', label: 'Measured change', tone: 'measured' },
  { key: 'unknown_cost', label: 'Unknown cost', tone: 'warn' },
]

export function Glossary({ meta }: { meta: Meta | undefined }) {
  return (
    <div className="px-5 pt-1 pb-6">
      <div className="rounded-2xl border border-dashed border-line-strong px-4 py-5 text-center">
        <MousePointerClick className="mx-auto size-5 text-ink-3" />
        <p className="mt-2 text-sm font-semibold">Select a finding or a call</p>
        <p className="mt-1 text-[13px] text-ink-3">Its evidence, rule, rationale and limits appear here.</p>
      </div>
      <h2 className="mt-6 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">How to read the numbers</h2>
      <dl className="mt-3 space-y-3.5">
        {ORDER.map(({ key, label, tone }) => (
          <div key={key}>
            <dt>
              <Badge tone={tone}>{label}</Badge>
            </dt>
            <dd className="mt-1.5 text-[13px] leading-5 text-ink-2">{meta?.glossary[key] ?? '…'}</dd>
          </div>
        ))}
      </dl>
      {meta && (
        <p className="mt-6 text-xs leading-5 text-ink-3">
          Findings come from {meta.analyzer.name} {meta.analyzer.version} (
          <code className="text-[11px]">{meta.analyzer.revision.slice(0, 7)}</code>), run unmodified on AUDR{' '}
          {meta.audr_spec_version} telemetry.
        </p>
      )}
    </div>
  )
}
