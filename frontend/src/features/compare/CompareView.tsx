import {
  ArrowLeftRight,
  CircleHelp,
  Equal,
  EqualNot,
  FlaskConical,
  GitCompareArrows,
  History,
  Save,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { useActions } from '../../app-actions'
import { errorMessage } from '../../api/client'
import { useComparePreview, useComparisons, useDeleteComparison, useImports, useSaveComparison } from '../../api/hooks'
import type { Equivalence, SavedComparison } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { Card, CardHeader } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Money } from '../../components/ui/money'
import { RadioCards } from '../../components/ui/radio-cards'
import { Select, type SelectGroup } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { Textarea } from '../../components/ui/textarea'
import { formatPercent, formatRelative, formatSpend, plural } from '../../lib/format'
import type { UrlState } from '../../lib/url-state'
import { ExportMenu } from '../imports/ExportMenu'
import { ComparisonResultView } from './ComparisonResultView'

const EQUIVALENCE_OPTIONS: { value: Equivalence; title: string; description: string; icon: React.ReactNode }[] = [
  {
    value: 'equivalent',
    title: 'Same task and input',
    description: 'You confirm both runs did the same job on equivalent input, so a cost difference reflects your change.',
    icon: <Equal />,
  },
  {
    value: 'not_equivalent',
    title: 'Different task or input',
    description: 'The work differed. The difference is shown but not attributed to a change.',
    icon: <EqualNot />,
  },
  {
    value: 'unsure',
    title: 'Not sure',
    description: 'Show the difference without calling it a measured change.',
    icon: <CircleHelp />,
  },
]

const EQUIVALENCE_LABEL: Record<Equivalence, string> = {
  equivalent: 'Same task and input',
  not_equivalent: 'Different task or input',
  unsure: 'Not sure',
}

function SavedRow({ item, onOpen }: { item: SavedComparison; onOpen: () => void }) {
  const actions = useActions()
  const remove = useDeleteComparison()
  const headline = item.result.scopes.find((s) => s.scope === item.result.headline_scope)
  const row = headline?.rows[0]
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3.5">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium">
          {item.result.baseline.display_name} <span className="text-ink-3">→</span> {item.result.candidate.display_name}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <Badge tone={item.result.kind === 'measured_change' ? 'measured' : item.result.kind === 'observed_difference' ? 'observed' : 'warn'}>
            {item.result.kind === 'measured_change' ? 'Measured' : item.result.kind === 'observed_difference' ? 'Observed difference' : 'Not comparable'}
          </Badge>
          {row && row.delta != null && (
            <span className="text-ink-2 tabular">
              <Money amount={row.delta} currency={row.currency} signed /> {row.percent != null && `(${formatPercent(row.percent)})`}
            </span>
          )}
          <span>· {EQUIVALENCE_LABEL[item.equivalence]}</span>
          <span>· saved {formatRelative(item.created_at)}</span>
        </span>
        {item.note && <span className="mt-1 block truncate text-xs text-ink-2 italic">“{item.note}”</span>}
      </button>
      <div className="flex items-center gap-1.5">
        <ExportMenu label="Export" onExport={(format) => actions.exportComparison(item.id, format)} />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Delete saved comparison"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(item.id, {
              onSuccess: () => toast.success('Comparison deleted'),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  )
}

export function CompareView({ url, onChange }: { url: UrlState; onChange: (patch: Partial<UrlState>) => void }) {
  const imports = useImports()
  const saved = useComparisons()
  const save = useSaveComparison()
  const [note, setNote] = useState('')
  const preview = useComparePreview(url.base, url.cand, url.eq)

  const groups: SelectGroup[] = useMemo(
    () =>
      [...(imports.data ?? [])].reverse().map((imp) => ({
        label: `${imp.filename}${imp.synthetic ? ' · synthetic' : ''}`,
        items: imp.runs.map((run) => ({
          value: run.id,
          label: run.display_name,
          hint: `${plural(run.calls, 'call')} · ${formatSpend(run.spend)}${run.spend.unknown_calls ? ` + ${run.spend.unknown_calls} unknown` : ''}`,
        })),
      })),
    [imports.data],
  )
  const runCount = groups.reduce((n, g) => n + g.items.length, 0)
  const same = url.base != null && url.base === url.cand
  const ready = Boolean(url.base && url.cand && url.eq && !same)

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 px-4 py-6 sm:px-6">
      <div>
        <p className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <GitCompareArrows className="size-3.5" /> Compare
        </p>
        <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-[-0.03em]">Measure what changed between two runs</h1>
        <p className="mt-1.5 max-w-2xl text-[14px] text-ink-2">
          Pick a baseline and a candidate, then say whether they did equivalent work. A change is reported as measured only
          when both runs have complete, comparable costs and you marked them equivalent. Output quality is never inferred.
        </p>
      </div>

      {imports.isPending ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : runCount < 2 ? (
        <Card>
          <EmptyState icon={<GitCompareArrows />} title="You need at least two runs to compare">
            Import another AUDR file, or load the synthetic demo — it includes a baseline and an after-changes run of the
            same task.
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <div className="grid items-end gap-3 p-5 @2xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="min-w-0">
              <label htmlFor="compare-base" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
                <span className="size-2.5 rounded-full bg-baseline-shade" /> Baseline (before)
              </label>
              <Select id="compare-base" label="Baseline run" value={url.base} onChange={(v) => onChange({ base: v })} groups={groups} placeholder="Choose the baseline run" />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Swap baseline and candidate"
              className="mb-1.5 justify-self-center"
              disabled={!url.base && !url.cand}
              onClick={() => onChange({ base: url.cand, cand: url.base })}
            >
              <ArrowLeftRight />
            </Button>
            <div className="min-w-0">
              <label htmlFor="compare-cand" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
                <span className="size-2.5 rounded-full bg-model" /> Candidate (after)
              </label>
              <Select id="compare-cand" label="Candidate run" value={url.cand} onChange={(v) => onChange({ cand: v })} groups={groups} placeholder="Choose the candidate run" />
            </div>
          </div>
          <div className="border-t border-line p-5">
            <p id="equivalence-label" className="text-[13px] font-medium">
              Did both runs do equivalent work? <span className="font-normal text-ink-3">Required</span>
            </p>
            <div className="mt-2.5">
              <RadioCards label="Did both runs do equivalent work?" value={url.eq} onChange={(v) => onChange({ eq: v })} options={EQUIVALENCE_OPTIONS} />
            </div>
          </div>
        </Card>
      )}

      {same && <Callout tone="warn" title="Choose two different runs">The baseline and the candidate are the same run.</Callout>}
      {!ready && !same && runCount >= 2 && (
        <p className="px-1 text-[13px] text-ink-3">
          {!url.base || !url.cand
            ? 'Choose a baseline and a candidate run to continue.'
            : 'Mark whether the runs did equivalent work to see the comparison.'}
        </p>
      )}

      {ready && preview.isPending && <Skeleton className="h-64 rounded-2xl" />}
      {ready && preview.isError && (
        <Callout tone="error" title="Couldn’t compare these runs" action={<Button size="sm" onClick={() => void preview.refetch()}>Retry</Button>}>
          {errorMessage(preview.error)}
        </Callout>
      )}
      {ready && preview.data && (
        <div className={preview.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'} aria-live="polite">
          <ComparisonResultView result={preview.data} />
          <Card className="mt-5">
            <form
              className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                if (!url.base || !url.cand || !url.eq) return
                save.mutate(
                  { baseline_run_id: url.base, candidate_run_id: url.cand, equivalence: url.eq, note: note.trim() || null },
                  {
                    onSuccess: () => {
                      setNote('')
                      toast.success('Comparison saved', { description: 'It is stored locally and included in reports.' })
                    },
                    onError: (error) => toast.error(errorMessage(error)),
                  },
                )
              }}
            >
              <div className="min-w-0 flex-1">
                <label htmlFor="comparison-note" className="mb-1.5 block text-[13px] font-medium">
                  Note <span className="font-normal text-ink-3">(optional — what changed between the runs?)</span>
                </label>
                <Textarea id="comparison-note" rows={1} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deduplicated the classification step" />
              </div>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                <Save /> {save.isPending ? 'Saving…' : 'Save comparison'}
              </Button>
            </form>
          </Card>
        </div>
      )}

      <Card aria-labelledby="saved-title">
        <CardHeader titleId="saved-title" icon={<History />} title="Saved comparisons" description="Recomputed from stored telemetry whenever they are shown." />
        {saved.isPending ? (
          <div className="px-5 pb-5">
            <Skeleton className="h-12" />
          </div>
        ) : (saved.data ?? []).length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-ink-3">No saved comparisons yet.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {(saved.data ?? []).map((item) => (
              <SavedRow
                key={item.id}
                item={item}
                onOpen={() => onChange({ base: item.result.baseline.id, cand: item.result.candidate.id, eq: item.equivalence })}
              />
            ))}
          </ul>
        )}
      </Card>

      {(preview.data?.baseline.synthetic || preview.data?.candidate.synthetic) && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-ink-3">
          <FlaskConical className="size-3.5" /> Synthetic demo runs: the result describes these documented runs only and is
          not a production savings rate.
        </p>
      )}
    </div>
  )
}
