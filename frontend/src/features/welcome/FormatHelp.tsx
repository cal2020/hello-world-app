import { FileCheck2, Ruler, ShieldCheck, SquareTerminal } from 'lucide-react'

import type { Meta } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatBytes, formatDay } from '../../lib/format'

const EXAMPLE = `{"spec_version":"1.0.0","record_id":"01K4N8D2J4P7Q9R3S6T8V1W5XY",
 "emitter":{"component":"router","name":"my-router","version":"1.2.0"},
 "timing":{"event_time":"2026-10-07T12:00:00.480Z","duration_ms":480},
 "resource":{"provider":"anthropic","type":"model","name":"claude-sonnet-4-5",
             "operation":"generation","modality":"text"},
 "run":{"run_id":"run-2026-10-07-0042","span_id":"model-1","step":1},
 "attribution":{"environment":"development","labels":{"step":"classify-intent"}},
 "usage":{"llm":{"input_tokens":1800,"output_tokens":60,"requests":1}},
 "cost":{"total_cost":0.0063,"currency":"USD"}}`

export function FormatHelp({ meta, className }: { meta: Meta | undefined; className?: string }) {
  const maxBytes = meta?.limits.max_upload_bytes ?? 8 * 1024 * 1024
  const maxRecords = meta?.limits.max_records ?? 10_000
  const items = [
    {
      icon: FileCheck2,
      title: 'AUDR v1.0 records',
      body: (
        <>
          JSONL (one record per line), a JSON array, or a single JSON object. Each record is checked against the
          official AUDR {meta?.audr_spec_version ?? '1.0.0'} schema; problems are reported with their line, and a file with
          any invalid record is not imported.
        </>
      ),
    },
    {
      icon: SquareTerminal,
      title: 'Claude Code transcripts',
      body: (
        <>
          Each session is saved as <code className="text-[12px]">~/.claude/projects/&lt;project&gt;/&lt;session&gt;.jsonl</code>
          , with subagents in <code className="text-[12px]">&lt;session&gt;/subagents/</code>. Choose one or several. Costs
          are estimated from tokens at Anthropic API list prices ({formatDay(meta?.pricing.date ?? '2026-10-09')}), not
          billed amounts. The folder is hidden in file pickers: press ⌘⇧. on macOS or Ctrl+H on Linux.
        </>
      ),
    },
    {
      icon: Ruler,
      title: 'Bounded',
      body: (
        <>
          Up to {maxRecords.toLocaleString('en-US')} records per import. AUDR files up to {formatBytes(maxBytes)}, larger
          traces can be split by run; transcripts of any size.
        </>
      ),
    },
    {
      icon: ShieldCheck,
      title: 'Private by design',
      body: (
        <>
          AUDR carries no prompts or responses, and from transcripts only model names, token counts and times are kept.
          User, account and credential identifiers are dropped; everything is stored locally in SQLite.
        </>
      ),
    },
  ]
  return (
    <div className={cn('rounded-2xl border border-line bg-surface shadow-card', className)}>
      <div className="grid gap-px overflow-hidden rounded-t-2xl bg-line @2xl:grid-cols-2">
        {items.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-surface p-5">
            <Icon className="size-[18px] text-accent-ink" />
            <p className="mt-2.5 text-sm font-semibold">{title}</p>
            <p className="mt-1 text-[13px] leading-5 text-ink-2">{body}</p>
          </div>
        ))}
      </div>
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-5 py-3 text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">›</span>
          Show an example record
        </summary>
        <pre className="mx-5 mb-5 overflow-x-auto rounded-xl border border-line bg-surface-2 p-4 text-[12px] leading-5 text-ink-2 scrollbar-thin">
          <code>{EXAMPLE}</code>
        </pre>
      </details>
    </div>
  )
}
