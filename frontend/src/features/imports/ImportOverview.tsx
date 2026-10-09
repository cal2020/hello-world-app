import { CircleAlert, FileJson, FlaskConical, Info, SearchX, Trash2, TriangleAlert } from 'lucide-react'

import { useActions } from '../../app-actions'
import { ApiError, errorMessage } from '../../api/client'
import { useImportDetail } from '../../api/hooks'
import type { Category, FindingSummary, Issue, Meta } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { Card, CardHeader } from '../../components/ui/card'
import { CopyButton } from '../../components/ui/copy-button'
import { EmptyState } from '../../components/ui/empty-state'
import { SpendValue } from '../../components/ui/money'
import { Skeleton } from '../../components/ui/skeleton'
import { CATEGORY_ORDER, categoryMeta } from '../../lib/categories'
import { cn } from '../../lib/cn'
import { costLabel } from '../../lib/cost-basis'
import { formatBytes, formatRelative, plural } from '../../lib/format'
import { FindingsPanel } from '../findings/FindingsPanel'
import { CostParts } from '../run/CostParts'
import { ResourceBreakdown } from '../run/ResourceBreakdown'
import { CallsTile, CandidatesTile, SpendTile } from '../run/StatTiles'
import { ExportMenu } from './ExportMenu'

const FORMAT_LABEL = {
  jsonl: 'JSONL',
  'json-array': 'JSON array',
  'json-object': 'JSON object',
  'claude-code': 'Claude Code transcript',
} as const

/** Shows a hint, turning web addresses into links. */
function HintText({ text }: { text: string }) {
  return (
    <span className="block text-xs text-ink-3">
      {text.split(/(https:\/\/\S+)/).map((part, index) =>
        part.startsWith('https://') ? (
          <a key={index} href={part} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </span>
  )
}

function NoteRow({ note }: { note: Issue }) {
  const Icon = note.severity === 'warning' ? TriangleAlert : note.severity === 'error' ? CircleAlert : Info
  return (
    <li className="flex gap-2.5 px-5 py-2.5 text-[13px]">
      <Icon
        aria-label={note.severity}
        className={cn('mt-0.5 size-4 shrink-0', note.severity === 'warning' ? 'text-warn-ink' : 'text-ink-3')}
      />
      <span className="min-w-0">
        <span className="text-ink">{note.message}</span>
        {note.hint && <HintText text={note.hint} />}
        {note.lines && note.lines.length > 0 && (
          <span className="block text-xs text-ink-3">Lines {note.lines.slice(0, 20).join(', ')}{note.lines.length > 20 ? '…' : ''}</span>
        )}
      </span>
    </li>
  )
}

function CategoryBars({ counts, total }: { counts: Record<Category, number>; total: number }) {
  const max = Math.max(1, ...Object.values(counts))
  return (
    <Card aria-labelledby="categories-title">
      <CardHeader
        titleId="categories-title"
        title="Flagged calls by heuristic"
        description="Distinct calls each heuristic flagged. One call can be flagged by several heuristics, so these do not add up."
      />
      <ul className="space-y-2.5 px-5 pb-5">
        {CATEGORY_ORDER.map((category) => {
          const meta = categoryMeta(category)
          const count = counts[category] ?? 0
          return (
            <li key={category} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_3.5rem] items-center gap-3 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <meta.icon aria-hidden className="size-4 shrink-0 text-candidate-ink" />
                <span className="truncate">{meta.label}</span>
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-hover" aria-hidden>
                <span className="block h-full rounded-full bg-candidate" style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <span className="text-right tabular">
                {count}
                <span className="text-xs text-ink-3">/{total}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function ImportOverview({
  importId,
  meta,
  selectedFinding,
  onSelectFinding,
  onSelectRun,
  onClearSelection,
}: {
  importId: string
  meta: Meta | undefined
  selectedFinding: FindingSummary | null
  onSelectFinding: (id: string) => void
  onSelectRun: (id: string) => void
  onClearSelection: () => void
}) {
  const actions = useActions()
  const query = useImportDetail(importId)
  if (query.isPending) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-6" aria-busy="true">
        <Skeleton className="h-8 w-80" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[132px] rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    )
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        {missing ? (
          <EmptyState icon={<SearchX />} title="This import no longer exists" action={<Button onClick={onClearSelection}>Show my runs</Button>} />
        ) : (
          <Callout tone="error" title="Couldn’t load this import" action={<Button size="sm" onClick={() => void query.refetch()}>Retry</Button>}>
            {errorMessage(query.error)}
          </Callout>
        )}
      </div>
    )
  }
  const data = query.data
  const totalCalls = data.runs.reduce((sum, run) => sum + run.calls, 0)
  const modelCalls = data.runs.reduce((sum, run) => sum + run.model_calls, 0)
  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-col-reverse gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between @2xl:gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13px] text-ink-3">
            <FileJson className="size-3.5" /> Import
          </p>
          <h1 className="mt-1.5 truncate text-[26px] leading-tight font-semibold tracking-[-0.03em]" title={data.filename}>
            {data.filename}
          </h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            {data.synthetic && (
              <Badge tone="accent">
                <FlaskConical /> Synthetic demo data
              </Badge>
            )}
            <Badge tone="outline">{FORMAT_LABEL[data.format] ?? data.format}</Badge>
            <Badge tone="outline">
              {data.accepted_count} of {plural(data.record_count, 'record')} analyzed
            </Badge>
            <Badge tone="outline">{formatBytes(data.byte_size)}</Badge>
            <span className="inline-flex items-center gap-0.5 rounded-full border border-line py-0.5 pr-0.5 pl-2.5">
              <code className="text-[11.5px]" title={data.file_sha256}>
                sha256 {data.file_sha256.slice(0, 12)}…
              </code>
              <CopyButton value={data.file_sha256} label="file SHA-256" />
            </span>
            <span>Imported {formatRelative(data.imported_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu onExport={(format) => actions.exportImport(data.id, format)} />
          <Button size="sm" variant="danger-ghost" aria-label="Delete import" onClick={() => actions.requestDeleteImport(data)}>
            <Trash2 /> <span className="hidden sm:inline">Delete import</span>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
        <SpendTile spend={data.spend} glossary={meta?.glossary.observed} estimateGlossary={meta?.glossary.estimated_cost} />
        <CallsTile
          calls={totalCalls}
          modelCalls={modelCalls}
          toolCalls={totalCalls - modelCalls}
          extra={<span className="mt-0.5 block">{plural(data.runs.length, 'run')}</span>}
        />
        <CandidatesTile
          scenario={data.scenario}
          totalCalls={totalCalls}
          openFindings={data.open_findings}
          dismissedFindings={data.dismissed_findings}
          observed={data.spend}
          glossary={meta?.glossary}
        />
      </div>

      <CostParts parts={data.cost_parts} spend={data.spend} />

      {data.notes.length > 0 && (
        <Card aria-labelledby="notes-title">
          <CardHeader titleId="notes-title" title="Import notes" description="What the importer and analyzer reported about this file." />
          <ul className="divide-y divide-line border-t border-line">
            {data.notes.map((note, index) => (
              <NoteRow key={`${note.code}-${index}`} note={note} />
            ))}
          </ul>
        </Card>
      )}

      <Card aria-labelledby="runs-title">
        <CardHeader titleId="runs-title" title="Runs" description="Each AUDR run_id in this file." />
        <div className="relative overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[640px] border-t border-line text-[13px]">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Run</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Calls</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{costLabel(data.spend)} spend</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Open candidates</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.runs.map((run) => (
                <tr key={run.id} className="cursor-pointer hover:bg-hover" onClick={() => onSelectRun(run.id)}>
                  <td className="px-5 py-2.5">
                    <button type="button" onClick={(e) => { e.stopPropagation(); onSelectRun(run.id) }} className="text-left">
                      <span className="block font-medium">{run.display_name}</span>
                      <code className="block text-xs text-ink-3">{run.run_id}</code>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular">{run.calls}</td>
                  <td className="px-3 py-2.5 text-right tabular">
                    <SpendValue spend={run.spend} />
                    {run.spend.unknown_calls > 0 && <span className="block text-xs text-warn-ink">{run.spend.unknown_calls} unknown</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular">{run.open_findings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CategoryBars counts={data.category_counts} total={totalCalls} />

      <FindingsPanel
        findings={data.findings}
        selectedId={selectedFinding?.id ?? null}
        onSelect={onSelectFinding}
        description="All findings in this file, including cross-run cache/reuse candidates. Open a run to see its timeline."
      />

      <ResourceBreakdown rows={data.by_model} />
    </div>
  )
}
