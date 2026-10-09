import { CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Scenario, Spend, Tokens } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Money, SpendValue } from '../../components/ui/money'
import { Tip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { costLabel, costWord, hasEstimates } from '../../lib/cost-basis'
import { formatDuration, formatInt, plural } from '../../lib/format'

const DOTS = { observed: 'bg-model', candidate: 'bg-candidate', neutral: 'bg-ink-3/50' } as const

export function StatTile({
  label,
  kind = 'neutral',
  hint,
  children,
  footer,
  className,
}: {
  label: string
  kind?: keyof typeof DOTS
  hint?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-card', className)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOTS[kind])} />
        <p className="min-w-0 truncate text-[13px] font-medium text-ink-2">{label}</p>
        {hint && (
          <Tip content={hint}>
            <button type="button" aria-label={`About ${label}`} className="ml-auto text-ink-3 hover:text-ink">
              <Info className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <div className="mt-2 min-w-0 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{children}</div>
      {footer && <div className="mt-auto pt-2.5 text-[12.5px] leading-5 text-ink-3">{footer}</div>}
    </div>
  )
}

export function SpendTile({
  spend,
  label,
  glossary,
  estimateGlossary,
}: {
  spend: Spend
  label?: string
  /** What observed values are. */
  glossary?: string
  /** What estimated costs are; shown instead when the spend includes estimates. */
  estimateGlossary?: string
}) {
  const estimated = hasEstimates(spend)
  const allPriced =
    spend.basis === 'estimated'
      ? `All ${spend.total_calls} calls priced from their tokens`
      : spend.basis === 'mixed'
        ? `All ${spend.total_calls} calls have a cost; ${spend.estimated_calls} estimated`
        : `All ${spend.total_calls} calls report a cost`
  return (
    <StatTile
      label={label ?? `${costLabel(spend)} spend`}
      kind="observed"
      hint={estimated ? (estimateGlossary ?? glossary) : glossary}
      footer={
        <>
          {spend.unknown_calls === 0 ? (
            <span className="inline-flex items-center gap-1">
              <CircleCheck className="size-3.5 shrink-0 text-good-ink" />
              {allPriced}
            </span>
          ) : (
            <span className="inline-flex items-start gap-1 text-warn-ink">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {plural(spend.unknown_calls, 'call')} without a {estimated ? 'known' : 'reported'} cost (not counted as zero)
              </span>
            </span>
          )}
          {estimated && <span className="mt-0.5 block">At Anthropic API list prices; not billed amounts.</span>}
          {spend.by_currency.length > 1 && <span className="mt-0.5 block">Currencies are never converted or combined.</span>}
        </>
      }
    >
      {spend.by_currency.length === 0 ? (
        <span className="text-warn-ink">Unknown</span>
      ) : (
        <span className="flex flex-col">
          {spend.by_currency.map((m) => (
            <Money key={m.currency} amount={m.amount} currency={m.currency} className="truncate" />
          ))}
        </span>
      )}
    </StatTile>
  )
}

export function CallsTile({
  calls,
  modelCalls,
  toolCalls,
  spanMs,
  extra,
}: {
  calls: number
  modelCalls: number
  toolCalls: number
  spanMs?: number | null
  extra?: ReactNode
}) {
  return (
    <StatTile
      label="Calls"
      footer={
        <>
          <span className="flex flex-wrap gap-x-3">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[2px] bg-model" /> {formatInt(modelCalls)} model
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[2px] bg-tool" /> {formatInt(toolCalls)} tool
            </span>
          </span>
          {spanMs != null && <span className="mt-0.5 block">Wall-clock span {formatDuration(spanMs)}</span>}
          {extra}
        </>
      }
    >
      {formatInt(calls)}
    </StatTile>
  )
}

export function TokensTile({ tokens }: { tokens: Tokens }) {
  const anyReported = Object.values(tokens).some((t) => t.total != null)
  // Reasoning and cache counters are legitimately absent on many calls; input and
  // output tokens are expected on every model call.
  const partial = [tokens.input_tokens, tokens.output_tokens].some((t) => t.reported_calls < t.model_calls)
  const extras = (
    [
      ['reasoning', tokens.reasoning_tokens.total],
      ['cache read', tokens.cache_read_tokens.total],
      ['cache write', tokens.cache_write_tokens.total],
    ] as const
  ).filter(([, v]) => v != null)
  const row = (value: number | null, label: string) => (
    <span className="flex items-baseline gap-1.5">
      <span>{value == null ? '—' : formatInt(value)}</span>
      <span className="text-[13px] font-medium tracking-normal text-ink-3">{label}</span>
    </span>
  )
  return (
    <StatTile
      label="Tokens"
      footer={
        anyReported ? (
          <>
            {extras.length > 0 ? extras.map(([k, v]) => `${formatInt(v)} ${k}`).join(' · ') : 'No reasoning or cache tokens reported'}
            {partial && <span className="mt-0.5 block text-warn-ink">Some model calls did not report input or output tokens.</span>}
          </>
        ) : (
          'No model call reported token counters.'
        )
      }
    >
      {anyReported ? (
        <span className="flex flex-col">
          {row(tokens.input_tokens.total, 'input')}
          {row(tokens.output_tokens.total, 'output')}
        </span>
      ) : (
        <span className="text-ink-3">Not reported</span>
      )}
    </StatTile>
  )
}

export function CandidatesTile({
  scenario,
  totalCalls,
  openFindings,
  dismissedFindings,
  observed,
  glossary,
}: {
  scenario: Scenario
  totalCalls: number
  openFindings: number
  dismissedFindings: number
  observed: Spend
  glossary?: { candidate?: string; scenario_estimate?: string }
}) {
  const flagged = scenario.open.flagged_calls
  const flaggedSpend = scenario.open.flagged_spend
  const single = observed.by_currency.length === 1 && flaggedSpend.by_currency.length <= 1 && observed.complete
  const total = Number(observed.by_currency[0]?.amount ?? 0)
  const part = Number(flaggedSpend.by_currency[0]?.amount ?? 0)
  const share = single && total > 0 ? Math.min(1, part / total) : null
  return (
    <StatTile
      label="Optimization candidates"
      kind="candidate"
      hint={glossary?.candidate}
      footer={
        <span className="block space-y-1.5">
          <span className="block">
            {plural(openFindings, 'open finding')}
            {dismissedFindings > 0 && ` · ${dismissedFindings} dismissed`}
          </span>
          {flagged > 0 && (
            <span className="block">
              <SpendValue spend={flaggedSpend} className="text-ink-2" /> {costWord(observed)} on flagged calls
              {share != null && ` (${Math.round(share * 100)}%)`}
            </span>
          )}
          {share != null && flagged > 0 && (
            <span
              role="meter"
              aria-label={`Share of ${costWord(observed)} spend on flagged calls`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              className="block h-1.5 w-full overflow-hidden rounded-full bg-candidate-soft"
            >
              <span className="block h-full rounded-full bg-candidate" style={{ width: `${share * 100}%` }} />
            </span>
          )}
          {scenario.open.estimate.length > 0 && (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <Badge tone="estimate" className="h-5">
                Scenario estimate
              </Badge>
              <span className="whitespace-nowrap">
                up to{' '}
                {scenario.open.estimate.map((m, i) => (
                  <span key={m.currency}>
                    {i > 0 && ' + '}
                    <Money amount={m.amount} currency={m.currency} className="text-ink-2" />
                  </span>
                ))}
              </span>
              <Tip content={`${glossary?.scenario_estimate ?? ''} ${scenario.method}`}>
                <button type="button" aria-label="How the scenario estimate is computed" className="text-ink-3 hover:text-ink">
                  <Info className="size-3.5" />
                </button>
              </Tip>
            </span>
          )}
        </span>
      }
    >
      <span className="flex flex-wrap items-baseline gap-x-2">
        {flagged}
        <span className="text-[13px] font-medium tracking-normal text-ink-3">of {plural(totalCalls, 'call')} flagged</span>
      </span>
    </StatTile>
  )
}
