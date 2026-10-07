import {
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  FileJson,
  FlaskConical,
  GitCompareArrows,
  SearchX,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useMemo } from 'react'

import { useActions } from '../../app-actions'
import { ApiError, errorMessage } from '../../api/client'
import { useRunDetail } from '../../api/hooks'
import type { FindingSummary, Meta, RunDetail } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { CopyButton } from '../../components/ui/copy-button'
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../../components/ui/dropdown'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { formatDateTime, formatDuration } from '../../lib/format'
import { FindingsPanel } from '../findings/FindingsPanel'
import { ExportMenu } from '../imports/ExportMenu'
import { CallsTable } from './CallsTable'
import { ResourceBreakdown } from './ResourceBreakdown'
import { CallsTile, CandidatesTile, SpendTile, TokensTile } from './StatTiles'
import { highlightFor } from './highlight'
import { Timeline } from './Timeline'

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null
  const tone = outcome === 'resolved' ? 'good' : outcome === 'failed' ? 'bad' : 'warn'
  const Icon = outcome === 'resolved' ? CircleCheck : outcome === 'failed' ? CircleX : TriangleAlert
  return (
    <Badge tone={tone} title="run.outcome reported by the harness (not a quality measure)">
      <Icon /> {outcome}
    </Badge>
  )
}

function RunSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading run">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-8 w-[min(520px,90%)]" />
      <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[132px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[360px] rounded-2xl" />
      <Skeleton className="h-[260px] rounded-2xl" />
    </div>
  )
}

function RunHeader({ data, onOpenImport }: { data: RunDetail; onOpenImport: (id: string) => void }) {
  const actions = useActions()
  const { run } = data
  const span = run.last_event_ms - run.start_ms
  return (
    <div className="flex flex-col-reverse gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between @2xl:gap-4">
      <div className="min-w-0 flex-1">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <button
            type="button"
            onClick={() => onOpenImport(run.import_id)}
            className="inline-flex min-w-0 items-center gap-1.5 rounded hover:text-ink"
          >
            <FileJson className="size-3.5 shrink-0" />
            <span className="truncate">{data.import.filename}</span>
          </button>
          <span aria-hidden>/</span>
          <span className="text-ink-2">Run</span>
        </nav>
        <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-[-0.03em] text-balance">{run.display_name}</h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-2.5">
            <code className="truncate text-[12px] text-ink-2">{run.run_id}</code>
            <CopyButton value={run.run_id} label="run ID" />
          </span>
          {run.synthetic && (
            <Badge tone="accent" title="Fictional, documented demo data">
              <FlaskConical /> Synthetic demo data
            </Badge>
          )}
          {run.environments.map((env) => (
            <Badge key={env} tone="outline">
              {env}
            </Badge>
          ))}
          {run.run_type && <Badge tone="outline">{run.run_type.replace('_', ' ')}</Badge>}
          <OutcomeBadge outcome={run.outcome} />
          {run.error_codes.map((code) => (
            <Badge key={code} tone="bad">
              {code}
            </Badge>
          ))}
          <span className="inline-flex items-center gap-1 text-xs text-ink-3">
            <Clock className="size-3.5" /> {formatDateTime(run.start_ms)} · {formatDuration(span)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" aria-label="Compare this run with another" onClick={() => actions.compareFrom(run.id)}>
          <GitCompareArrows /> <span className="hidden sm:inline">Compare</span>
        </Button>
        <ExportMenu onExport={(format) => actions.exportImport(run.import_id, format)} />
        <DropdownMenu>
          <DropdownTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="More run actions">
              <Ellipsis />
            </Button>
          </DropdownTrigger>
          <DropdownContent>
            <DropdownItem danger onSelect={() => actions.requestDeleteRun(run)}>
              <Trash2 /> Delete this run…
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem danger onSelect={() => actions.requestDeleteImport(data.import)}>
              <Trash2 /> Delete the whole import…
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function RunView({
  runId,
  meta,
  selectedFinding,
  selectedCallId,
  onSelectFinding,
  onSelectCall,
  onOpenImport,
  onClearSelection,
}: {
  runId: string
  meta: Meta | undefined
  selectedFinding: FindingSummary | null
  selectedCallId: string | null
  onSelectFinding: (id: string) => void
  onSelectCall: (id: string) => void
  onOpenImport: (id: string) => void
  onClearSelection: () => void
}) {
  const query = useRunDetail(runId)
  const highlight = useMemo(() => highlightFor(selectedFinding), [selectedFinding])

  if (query.isPending) return <RunSkeleton />
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        {missing ? (
          <EmptyState icon={<SearchX />} title="This run no longer exists" action={<Button onClick={onClearSelection}>Show my runs</Button>}>
            It may have been deleted, or the link points to another database.
          </EmptyState>
        ) : (
          <Callout tone="error" title="Couldn’t load this run" action={<Button size="sm" onClick={() => void query.refetch()}>Retry</Button>}>
            {errorMessage(query.error)}
          </Callout>
        )}
      </div>
    )
  }

  const data = query.data
  const { run } = data
  return (
    <div className={cn('mx-auto max-w-[1180px] space-y-5 px-4 py-6 transition-opacity sm:px-6', query.isFetching && 'opacity-80')}>
      <RunHeader data={data} onOpenImport={onOpenImport} />

      <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
        <SpendTile spend={run.spend} glossary={meta?.glossary.observed} />
        <CallsTile calls={run.calls} modelCalls={run.model_calls} toolCalls={run.tool_calls} spanMs={run.last_event_ms - run.start_ms} />
        <TokensTile tokens={run.tokens} />
        <CandidatesTile
          scenario={data.scenario}
          totalCalls={run.calls}
          openFindings={run.open_findings}
          dismissedFindings={run.dismissed_findings}
          observed={run.spend}
          glossary={meta?.glossary}
        />
      </div>

      <Timeline
        calls={data.calls}
        startMs={data.timeline.start_ms}
        endMs={data.timeline.end_ms}
        rule={data.timeline.rule}
        highlight={highlight}
        selectedCallId={selectedCallId}
        onSelectCall={onSelectCall}
      />

      <FindingsPanel findings={data.findings} selectedId={selectedFinding?.id ?? null} onSelect={onSelectFinding} />

      <ResourceBreakdown rows={data.by_model} />

      <CallsTable
        calls={data.calls}
        startMs={data.timeline.start_ms}
        selectedCallId={selectedCallId}
        onSelectCall={onSelectCall}
      />
    </div>
  )
}
