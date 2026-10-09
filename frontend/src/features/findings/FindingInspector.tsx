import { ExternalLink, EyeOff, Layers, RotateCcw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { errorMessage } from '../../api/client'
import { useDismissFinding, useFindingDetail } from '../../api/hooks'
import type { Finding } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { Money, SpendValue } from '../../components/ui/money'
import { ShowMoreList } from '../../components/ui/show-more'
import { Skeleton } from '../../components/ui/skeleton'
import { Textarea } from '../../components/ui/textarea'
import { costWord } from '../../lib/cost-basis'
import { formatRelative, plural } from '../../lib/format'
import { CategoryIcon, ConfidenceBadge } from './FindingsPanel'
import { FindingEvidence, NotProofNote } from './FindingEvidence'

export function InspectorSection({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function DismissForm({ finding }: { finding: Finding }) {
  const [note, setNote] = useState('')
  const mutation = useDismissFinding()
  if (finding.dismissed) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[13px]">
          <p className="flex items-center gap-1.5 font-medium">
            <EyeOff className="size-4 text-ink-3" /> Dismissed
            {finding.dismissed_at && <span className="font-normal text-ink-3">{formatRelative(finding.dismissed_at)}</span>}
          </p>
          <p className="mt-1 text-ink-2">{finding.dismissal_note ?? <span className="italic text-ink-3">No note</span>}</p>
        </div>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate(
              { id: finding.id, dismissed: false },
              {
                onSuccess: () => toast.success('Finding restored to the open list'),
                onError: (error) => toast.error(errorMessage(error)),
              },
            )
          }
        >
          <RotateCcw /> Restore finding
        </Button>
      </div>
    )
  }
  return (
    <form
      className="space-y-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate(
          { id: finding.id, dismissed: true, note: note.trim() || null },
          {
            onSuccess: () => {
              setNote('')
              toast.success('Finding dismissed', { description: 'Saved locally. It stays listed under “Dismissed”.' })
            },
            onError: (error) => toast.error(errorMessage(error)),
          },
        )
      }}
    >
      <label htmlFor={`note-${finding.id}`} className="block text-[13px] text-ink-2">
        Not worth acting on? Dismiss it with a note for your future self. Notes are stored locally and included in reports.
      </label>
      <Textarea
        id={`note-${finding.id}`}
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="e.g. Intentional retry after a provider timeout"
      />
      <Button type="submit" size="sm" disabled={mutation.isPending}>
        <EyeOff /> {mutation.isPending ? 'Saving…' : 'Dismiss finding'}
      </Button>
    </form>
  )
}

export function FindingInspector({
  finding,
  onSelectCall,
  onSelectFinding,
}: {
  finding: Finding
  onSelectCall: (callId: string, runPk?: string) => void
  onSelectFinding: (id: string) => void
}) {
  const overlaps = finding.overlaps
  return (
    <div>
      <div className="px-5 pt-1 pb-4">
        <div className="flex items-center gap-2.5">
          <CategoryIcon category={finding.category} className="size-9" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-candidate-ink">{finding.category_label}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <ConfidenceBadge confidence={finding.confidence} />
              <Badge tone={finding.dismissed ? 'neutral' : 'candidate'}>{finding.dismissed ? 'Dismissed' : 'Open candidate'}</Badge>
            </div>
          </div>
        </div>
        <h2 className="mt-3 text-[17px] leading-6 font-semibold tracking-[-0.01em]">{finding.title}</h2>
        <div className="mt-2">
          <NotProofNote />
        </div>
      </div>

      <InspectorSection title="What the analyzer saw">
        <FindingEvidence evidence={finding.evidence} status={finding.evidence_status} onSelectCall={onSelectCall} />
      </InspectorSection>

      <InspectorSection
        title={`Affected calls (${finding.affected.length})`}
        aside={
          <span className="text-xs text-ink-3">
            <SpendValue spend={finding.affected_spend} className="tabular" /> {costWord(finding.affected_spend)}
          </span>
        }
      >
        <ShowMoreList
          items={finding.affected}
          className="space-y-1"
          render={(call) => (
            <li key={call.call_id}>
              <button
                type="button"
                onClick={() => onSelectCall(call.call_id, call.run_pk)}
                className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover"
              >
                <span className="w-9 text-xs text-ink-3 tabular">#{call.step ?? '—'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{call.resource_name}</span>
                  <code className="block truncate text-[11px] text-ink-3" title={call.record_id}>
                    {call.record_id}
                  </code>
                </span>
                <Money amount={call.cost.amount} currency={call.cost.currency} className="shrink-0 tabular" />
              </button>
            </li>
          )}
        />
        {finding.affected_spend.unknown_calls > 0 && (
          <p className="mt-2 text-xs text-warn-ink">
            {plural(finding.affected_spend.unknown_calls, 'call')} without a reported cost; they add nothing to amounts.
          </p>
        )}
      </InspectorSection>

      <InspectorSection title="Rule">
        <p className="text-[13px] font-medium">{finding.rule.name}</p>
        <p className="mt-1 text-[13px] leading-5 text-ink-2">{finding.rule.summary}</p>
        {finding.rule.confidence && <p className="mt-1 text-[13px] text-ink-2">Confidence: {finding.rule.confidence}</p>}
        <a
          href={finding.rule.source}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-flex items-center gap-1 text-xs text-accent-ink hover:underline"
        >
          {finding.rule.analyzer} source <ExternalLink className="size-3" />
        </a>
      </InspectorSection>

      <InspectorSection title="Analyzer rationale">
        <blockquote className="border-l-2 border-line-strong pl-3 text-[13px] leading-5 text-ink-2">{finding.rationale}</blockquote>
      </InspectorSection>

      <InspectorSection title="Limits">
        <ul className="space-y-1.5">
          {finding.limitations.map((line) => (
            <li key={line} className="flex gap-2 text-[13px] leading-5 text-ink-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn-ink" />
              {line}
            </li>
          ))}
        </ul>
      </InspectorSection>

      <InspectorSection title="Scenario estimate">
        <div className="rounded-xl border border-dashed border-candidate/70 px-3.5 py-3 text-[13px] leading-5">
          <Badge tone="estimate">Estimate · not measured</Badge>
          <p className="mt-2 text-ink-2">
            KORA Doctor v0 assumes {finding.scenario.ratio_percent}% of the {costWord(finding.affected_spend)} cost on these calls
            could be avoided:{' '}
            {finding.scenario.estimate.length ? (
              finding.scenario.estimate.map((m, i) => (
                <span key={m.currency}>
                  {i > 0 && ' + '}
                  <Money amount={m.amount} currency={m.currency} className="font-semibold text-ink" />
                </span>
              ))
            ) : (
              <span className="font-medium">nothing with a reported cost</span>
            )}
            .
          </p>
          {overlaps.length > 0 && (
            <div className="mt-2 text-xs text-ink-3">
              <p className="flex items-center gap-1">
                <Layers className="size-3.5" /> These calls are also flagged by:
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {overlaps.map((o) => (
                  <li key={o.category}>
                    <button
                      type="button"
                      onClick={() => o.finding_ids[0] && onSelectFinding(o.finding_ids[0])}
                      className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-hover"
                    >
                      {o.category_label} · {plural(o.findings, 'finding')} · {plural(o.shared_calls, 'shared call')}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5">Overlapping estimates are never added together.</p>
            </div>
          )}
        </div>
      </InspectorSection>

      <InspectorSection title="Your decision">
        <DismissForm key={finding.id} finding={finding} />
      </InspectorSection>
    </div>
  )
}

/** Loads the full finding (evidence, rule, limits) for the inspector. */
export function FindingInspectorLoader({
  findingId,
  onSelectCall,
  onSelectFinding,
}: {
  findingId: string
  onSelectCall: (callId: string, runPk?: string) => void
  onSelectFinding: (id: string) => void
}) {
  const query = useFindingDetail(findingId)
  if (query.isPending) {
    return (
      <div className="space-y-3 px-5 pt-1" aria-busy="true" aria-label="Loading evidence">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="px-5">
        <Callout tone="error" title="Couldn’t load this finding">
          {errorMessage(query.error)}
        </Callout>
      </div>
    )
  }
  return <FindingInspector finding={query.data} onSelectCall={onSelectCall} onSelectFinding={onSelectFinding} />
}
