import { ArrowDownWideNarrow, ChevronRight, EyeOff, Layers, SearchCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { FindingSummary } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardHeader } from '../../components/ui/card'
import {
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from '../../components/ui/dropdown'
import { EmptyState } from '../../components/ui/empty-state'
import { SpendValue } from '../../components/ui/money'
import { categoryMeta } from '../../lib/categories'
import { cn } from '../../lib/cn'
import { geometryValue, plural } from '../../lib/format'
import { readStorage, writeStorage } from '../../lib/storage'

type SortKey = 'rank' | 'spend' | 'calls'
const SORT_LABELS: Record<SortKey, string> = {
  rank: 'Analyzer rank (confidence, then calls)',
  spend: 'Observed spend on affected calls',
  calls: 'Number of affected calls',
}
const PAGE = 60

export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const { icon: Icon } = categoryMeta(category)
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg bg-candidate-soft text-candidate-ink [&_svg]:size-4',
        className,
      )}
    >
      <Icon />
    </span>
  )
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const medium = confidence === 'medium'
  return (
    <Badge tone="outline" title={`${confidence} confidence (heuristic strength, not certainty)`}>
      <span aria-hidden className="flex items-end gap-px">
        <span className="h-1.5 w-[3px] rounded-[1px] bg-current" />
        <span className={cn('h-2.5 w-[3px] rounded-[1px]', medium ? 'bg-current' : 'bg-current/25')} />
        <span className="h-3.5 w-[3px] rounded-[1px] bg-current/25" />
      </span>
      {medium ? 'Medium' : confidence === 'low' ? 'Low' : confidence}
    </Badge>
  )
}

function FindingRow({ finding, selected, onSelect }: { finding: FindingSummary; selected: boolean; onSelect: () => void }) {
  const meta = categoryMeta(finding.category)
  const overlaps = finding.overlap_count
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'group flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors',
          selected ? 'bg-accent-soft ring-1 ring-accent/40' : 'hover:bg-hover',
          finding.dismissed && 'opacity-70',
        )}
      >
        <CategoryIcon category={finding.category} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium text-candidate-ink">{finding.category_label ?? meta.label}</span>
            <ConfidenceBadge confidence={finding.confidence} />
            {finding.dismissed && (
              <Badge tone="neutral">
                <EyeOff /> Dismissed
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-[14px] leading-5 font-medium">{finding.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-3">
            <span>{plural(finding.affected_count, 'call')}</span>
            <span aria-hidden>·</span>
            <span>
              <SpendValue spend={finding.affected_spend} className="text-ink-2 tabular" /> observed on them
            </span>
            {finding.affected_spend.unknown_calls > 0 && (
              <span className="text-warn-ink">({finding.affected_spend.unknown_calls} unknown)</span>
            )}
            {overlaps > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Layers className="size-3" /> overlaps {plural(overlaps, 'other finding')}
                </span>
              </>
            )}
          </span>
          {finding.dismissed && finding.dismissal_note && (
            <span className="mt-1.5 block truncate text-[12.5px] text-ink-2 italic">“{finding.dismissal_note}”</span>
          )}
        </span>
        <ChevronRight aria-hidden className="mt-2 size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </li>
  )
}

export function FindingsPanel({
  findings,
  selectedId,
  onSelect,
  description,
}: {
  findings: FindingSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  description?: string
}) {
  const [sort, setSortState] = useState<SortKey>(() => {
    const saved = readStorage('aci.findingSort')
    return saved === 'spend' || saved === 'calls' ? saved : 'rank'
  })
  const [limit, setLimit] = useState(PAGE)
  const setSort = (value: SortKey) => {
    writeStorage('aci.findingSort', value)
    setSortState(value)
  }
  const sorted = useMemo(() => {
    const list = [...findings]
    if (sort === 'spend') {
      list.sort(
        (a, b) =>
          geometryValue(b.affected_spend.by_currency[0]?.amount) - geometryValue(a.affected_spend.by_currency[0]?.amount) ||
          a.rank - b.rank,
      )
    } else if (sort === 'calls') {
      list.sort((a, b) => b.affected_count - a.affected_count || a.rank - b.rank)
    } else {
      list.sort((a, b) => a.rank - b.rank)
    }
    return list
  }, [findings, sort])
  const open = sorted.filter((f) => !f.dismissed)
  const dismissed = sorted.filter((f) => f.dismissed)
  const selectedDismissed = dismissed.some((f) => f.id === selectedId)

  return (
    <Card aria-labelledby="findings-title">
      <CardHeader
        titleId="findings-title"
        title={
          <span className="inline-flex items-center gap-2">
            Optimization candidates
            <Badge tone={open.length ? 'candidate' : 'neutral'}>{open.length} open</Badge>
          </span>
        }
        description={
          description ??
          'Heuristic flags from KORA Doctor. Each one is a call worth reviewing, with its evidence and limits — not proof of waste.'
        }
        actions={
          <DropdownMenu>
            <DropdownTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={`Sort findings: ${SORT_LABELS[sort]}`}>
                <ArrowDownWideNarrow /> Sort
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownLabel>Sort by</DropdownLabel>
              <DropdownRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <DropdownRadioItem key={key} value={key}>
                    {SORT_LABELS[key]}
                  </DropdownRadioItem>
                ))}
              </DropdownRadioGroup>
            </DropdownContent>
          </DropdownMenu>
        }
      />
      <div className="px-2 pb-2">
        {open.length === 0 ? (
          <EmptyState icon={<SearchCheck />} title={dismissed.length ? 'Every candidate is dismissed' : 'No candidates flagged'}>
            {dismissed.length
              ? 'Dismissed findings stay listed below with your notes.'
              : 'KORA Doctor’s heuristics found nothing to flag here. That is not a guarantee that every call was needed.'}
          </EmptyState>
        ) : (
          <ul className="space-y-0.5">
            {open.slice(0, limit).map((finding) => (
              <FindingRow key={finding.id} finding={finding} selected={finding.id === selectedId} onSelect={() => onSelect(finding.id)} />
            ))}
          </ul>
        )}
        {open.length > limit && (
          <div className="py-2 text-center">
            <Button size="sm" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, open.length - limit)} more of {open.length}
            </Button>
          </div>
        )}
        {dismissed.length > 0 && (
          <details className="group mt-1 border-t border-line" open={selectedDismissed || undefined}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Dismissed ({dismissed.length})
            </summary>
            <ul className="space-y-0.5 pb-1">
              {dismissed.map((finding) => (
                <FindingRow key={finding.id} finding={finding} selected={finding.id === selectedId} onSelect={() => onSelect(finding.id)} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  )
}
