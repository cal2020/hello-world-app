import { Bot, Equal, Info, Scale, TrendingDown, TrendingUp, TriangleAlert, Wrench } from 'lucide-react'

import type { ComparisonResult, ComparisonScope, IntDelta, ScopeRow, TokenDelta } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Callout } from '../../components/ui/callout'
import { Card, CardHeader } from '../../components/ui/card'
import { Money, SpendValue } from '../../components/ui/money'
import { cn } from '../../lib/cn'
import { formatInt, formatPercent, formatSignedInt, geometryValue } from '../../lib/format'

const KIND = {
  measured_change: { label: 'Measured change', tone: 'measured' as const },
  observed_difference: { label: 'Observed difference', tone: 'observed' as const },
  not_comparable: { label: 'Not comparable', tone: 'warn' as const },
}

function direction(row: ScopeRow) {
  if (row.delta == null) return { Icon: Scale, tone: 'text-ink-3', word: 'unknown' }
  if (row.delta.startsWith('-')) return { Icon: TrendingDown, tone: 'text-good-ink', word: 'lower' }
  if (row.delta === '0') return { Icon: Equal, tone: 'text-ink-2', word: 'unchanged' }
  return { Icon: TrendingUp, tone: 'text-bad-ink', word: 'higher' }
}

/** Before → after on one shared scale: baseline in the light shade, candidate in the dark shade of one hue. */
function Dumbbell({ row }: { row: ScopeRow }) {
  const base = geometryValue(row.baseline)
  const cand = geometryValue(row.candidate)
  const max = Math.max(base, cand) || 1
  const left = (Math.min(base, cand) / max) * 100
  const right = (Math.max(base, cand) / max) * 100
  return (
    <div className="mt-5" aria-hidden>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-px bg-grid" />
        <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-line-strong" style={{ left: `${left}%`, width: `${right - left}%` }} />
        <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-baseline-shade ring-2 ring-surface" style={{ left: `${(base / max) * 100}%` }} />
        <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-model ring-2 ring-surface" style={{ left: `${(cand / max) * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3 tabular">
        <span>0</span>
        <span>{row.currency}</span>
      </div>
    </div>
  )
}

function Headline({ result, scope }: { result: ComparisonResult; scope: ComparisonScope | undefined }) {
  const kind = KIND[result.kind]
  const row = scope?.rows[0]
  return (
    <Card className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-glow opacity-60" />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kind.tone} className="h-6 px-2.5 text-xs">
            {kind.label}
          </Badge>
          {scope && <Badge tone="outline">{scope.label}</Badge>}
          {result.baseline.synthetic || result.candidate.synthetic ? <Badge tone="accent">Synthetic runs</Badge> : null}
        </div>
        {scope && row ? (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
              {scope.rows.map((r) => {
                const d = direction(r)
                return (
                  <div key={r.currency}>
                    <p className={cn('flex items-center gap-2 text-[44px] leading-none font-semibold tracking-[-0.04em]', d.tone)}>
                      <d.Icon className="size-8" aria-label={d.word} />
                      <Money amount={r.delta} currency={r.currency} signed />
                    </p>
                    <p className="mt-2 text-[15px] text-ink-2">
                      {r.percent != null ? (
                        <span className="font-semibold text-ink">{formatPercent(r.percent)}</span>
                      ) : (
                        <span className="text-ink-3">{r.percent_note ?? '—'}</span>
                      )}{' '}
                      <span className="text-ink-3">
                        · <Money amount={r.baseline} currency={r.currency} /> → <Money amount={r.candidate} currency={r.currency} />
                      </span>
                    </p>
                  </div>
                )
              })}
            </div>
            {scope.rows.length === 1 && (
              <div className="max-w-xl">
                <Dumbbell row={row} />
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-baseline-shade" /> Baseline · {result.baseline.display_name}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-model" /> Candidate · {result.candidate.display_name}
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="mt-4 text-[15px] text-ink-2">
            Neither scope has complete, comparable costs in both runs, so no change can be measured. See the reasons below.
          </p>
        )}
        <div className="mt-5 space-y-1.5 text-[13px] text-ink-2">
          {result.notes.map((note) => (
            <p key={note} className="flex gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-3" /> {note}
            </p>
          ))}
          <p className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" /> {result.quality.note}
          </p>
        </div>
      </div>
    </Card>
  )
}

function ScopeTable({ scopes }: { scopes: ComparisonScope[] }) {
  return (
    <Card aria-labelledby="scopes-title">
      <CardHeader
        titleId="scopes-title"
        title="Cost by scope"
        description="A scope is comparable only when every call in it reports a cost in both runs."
      />
      <div className="relative overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[620px] border-t border-line text-[13px]">
          <thead className="bg-surface-2 text-left text-xs text-ink-3">
            <tr>
              <th scope="col" className="px-5 py-2 font-medium">Scope</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Baseline</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Candidate</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Change</th>
              <th scope="col" className="px-5 py-2 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {scopes.flatMap((scope) => [
              ...scope.rows.map((row, index) => (
                <tr key={`${scope.scope}-${row.currency}`}>
                  <td className="px-5 py-2.5">
                    {index === 0 && (
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{scope.label}</span>
                        <Badge tone={scope.comparable ? 'good' : 'warn'}>{scope.comparable ? 'Comparable' : 'Not comparable'}</Badge>
                      </span>
                    )}
                    {scope.rows.length > 1 && <span className="text-xs text-ink-3">{row.currency}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular">
                    <Money amount={row.baseline} currency={row.currency} />
                    {scope.baseline_spend.unknown_calls > 0 && <span className="block text-xs text-warn-ink">+{scope.baseline_spend.unknown_calls} unknown</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular">
                    <Money amount={row.candidate} currency={row.currency} />
                    {scope.candidate_spend.unknown_calls > 0 && <span className="block text-xs text-warn-ink">+{scope.candidate_spend.unknown_calls} unknown</span>}
                  </td>
                  <td className={cn('px-3 py-2.5 text-right font-medium tabular', direction(row).tone)}>
                    {row.delta == null ? <span className="text-ink-3">—</span> : <Money amount={row.delta} currency={row.currency} signed />}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular">
                    {row.percent != null ? formatPercent(row.percent) : <span className="text-xs text-ink-3">{row.delta == null ? '—' : 'undefined'}</span>}
                  </td>
                </tr>
              )),
              scope.rows.length === 0 ? (
                <tr key={`${scope.scope}-empty`}>
                  <td className="px-5 py-2.5 font-medium">{scope.label}</td>
                  <td colSpan={4} className="px-3 py-2.5 text-ink-3">No reported cost in either run</td>
                </tr>
              ) : null,
              scope.reasons.length > 0 || scope.notes.length > 0 ? (
                <tr key={`${scope.scope}-why`}>
                  <td colSpan={5} className="bg-surface-2 px-5 py-2 text-xs text-ink-2">
                    {[...scope.reasons, ...scope.notes].join(' ')}
                  </td>
                </tr>
              ) : null,
            ])}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ResourcePairs({ result }: { result: ComparisonResult }) {
  const amounts = result.by_model.flatMap((row) => [
    geometryValue(row.baseline.spend.by_currency[0]?.amount),
    geometryValue(row.candidate.spend.by_currency[0]?.amount),
  ])
  const max = Math.max(...amounts, 0) || 1
  return (
    <Card aria-labelledby="pairs-title">
      <CardHeader
        titleId="pairs-title"
        title="By model and tool"
        description="Baseline (light) and candidate (dark) observed cost per resource."
        actions={
          <div className="flex gap-3 text-xs text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-[3px] bg-baseline-shade" /> Baseline
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-[3px] bg-model" /> Candidate
            </span>
          </div>
        }
      />
      <ul className="divide-y divide-line border-t border-line">
        {result.by_model.map((row) => {
          const Icon = row.resource_type === 'model' ? Bot : Wrench
          const b = row.baseline.spend.by_currency[0]
          const c = row.candidate.spend.by_currency[0]
          return (
            <li key={`${row.resource_type}:${row.provider}:${row.name}`} className="grid gap-x-4 gap-y-2 px-5 py-3 @xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7.5rem]">
              <span className="flex min-w-0 items-center gap-2 text-[13px]">
                <Icon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate font-medium">{row.name}</span>
              </span>
              <span className="space-y-1.5 self-center" aria-hidden>
                <span className="block h-2 rounded-[3px] bg-baseline-shade" style={{ width: `${(geometryValue(b?.amount) / max) * 100}%` }} />
                <span className="block h-2 rounded-[3px] bg-model" style={{ width: `${(geometryValue(c?.amount) / max) * 100}%` }} />
              </span>
              <span className="text-right text-xs leading-5 tabular">
                <span className="block text-ink-3">
                  {row.baseline.calls} → {row.candidate.calls} calls
                </span>
                <span className="block">
                  <SpendValue spend={row.baseline.spend} /> → <SpendValue spend={row.candidate.spend} />
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function DeltaRow({ label, delta, note }: { label: string; delta: IntDelta | TokenDelta; note?: string }) {
  return (
    <tr>
      <th scope="row" className="px-5 py-2 text-left font-normal text-ink-2">
        {label}
        {note && <span className="block text-xs text-ink-3">{note}</span>}
      </th>
      <td className="px-3 py-2 text-right tabular">{delta.baseline == null ? <span className="text-ink-3">not reported</span> : formatInt(delta.baseline)}</td>
      <td className="px-3 py-2 text-right tabular">{delta.candidate == null ? <span className="text-ink-3">not reported</span> : formatInt(delta.candidate)}</td>
      <td className="px-5 py-2 text-right font-medium tabular">{formatSignedInt(delta.delta)}</td>
    </tr>
  )
}

function UsageTable({ result }: { result: ComparisonResult }) {
  const tokens = result.usage.tokens
  const tokenRows = (Object.keys(tokens) as (keyof typeof tokens)[]).filter(
    (key) => tokens[key].baseline != null || tokens[key].candidate != null,
  )
  return (
    <Card aria-labelledby="usage-title">
      <CardHeader titleId="usage-title" title="Usage, candidates and outcome" description="Token changes appear only when every model call in both runs reported the counter." />
      <div className="relative overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[520px] border-t border-line text-[13px]">
          <thead className="bg-surface-2 text-xs text-ink-3">
            <tr>
              <th scope="col" className="px-5 py-2 text-left font-medium">Measure</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Baseline</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Candidate</th>
              <th scope="col" className="px-5 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <DeltaRow label="Calls" delta={result.usage.calls} />
            <DeltaRow label="Model calls" delta={result.usage.model_calls} />
            <DeltaRow label="Tool calls" delta={result.usage.tool_calls} />
            {tokenRows.map((key) => (
              <DeltaRow
                key={key}
                label={key.replace(/_/g, ' ')}
                delta={tokens[key]}
                note={`reported by ${tokens[key].baseline_reported} → ${tokens[key].candidate_reported} model calls`}
              />
            ))}
            <DeltaRow
              label="Open candidates"
              delta={{
                baseline: result.findings.baseline_open,
                candidate: result.findings.candidate_open,
                delta: result.findings.candidate_open - result.findings.baseline_open,
              }}
              note="Heuristic flags, not waste"
            />
            <tr>
              <th scope="row" className="px-5 py-2 text-left font-normal text-ink-2">
                Outcome
                <span className="block text-xs text-ink-3">run.outcome from the harness; not a quality measure</span>
              </th>
              <td className="px-3 py-2 text-right">{result.outcomes.baseline ?? <span className="text-ink-3">not reported</span>}</td>
              <td className="px-3 py-2 text-right">{result.outcomes.candidate ?? <span className="text-ink-3">not reported</span>}</td>
              <td className="px-5 py-2 text-right text-ink-3">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function ComparisonResultView({ result }: { result: ComparisonResult }) {
  const headline = result.scopes.find((s) => s.scope === result.headline_scope)
  return (
    <div className="space-y-5">
      <Headline result={result} scope={headline} />
      {result.kind === 'not_comparable' && (
        <Callout tone="warn" title="Why this is not comparable">
          {result.scopes.flatMap((s) => s.reasons).join(' ')}
        </Callout>
      )}
      <ScopeTable scopes={result.scopes} />
      <ResourcePairs result={result} />
      <UsageTable result={result} />
    </div>
  )
}
