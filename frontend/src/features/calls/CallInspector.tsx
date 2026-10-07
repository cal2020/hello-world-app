import { ArrowLeft, Bot, CircleAlert, Wrench } from 'lucide-react'

import type { CallRecord, FindingSummary } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Callout } from '../../components/ui/callout'
import { CopyButton } from '../../components/ui/copy-button'
import { Money } from '../../components/ui/money'
import { categoryMeta } from '../../lib/categories'
import { formatDateTime, formatDuration, formatInt, formatOffset } from '../../lib/format'
import { InspectorSection } from '../findings/FindingInspector'

const LLM_FIELDS = [
  ['input_tokens', 'Input tokens'],
  ['output_tokens', 'Output tokens'],
  ['reasoning_tokens', 'Reasoning tokens'],
  ['cache_read_tokens', 'Cache-read tokens'],
  ['cache_write_tokens', 'Cache-write tokens'],
  ['requests', 'Requests'],
] as const

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px]" title={full}>
        {children}
      </dd>
    </div>
  )
}

function Value({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === '') return <span className="text-ink-3 italic">not reported</span>
  return <>{typeof value === 'number' ? formatInt(value) : value}</>
}

export function CallInspector({
  call,
  runStartMs,
  findings,
  onSelectFinding,
  onBack,
}: {
  call: CallRecord
  runStartMs: number | null
  findings: FindingSummary[]
  onSelectFinding: (id: string) => void
  onBack?: () => void
}) {
  const Icon = call.is_model ? Bot : Wrench
  const related = findings.filter((f) => call.findings.some((cf) => cf.id === f.id))
  const extraCounters = Object.entries(call.usage).filter(
    ([key]) => !LLM_FIELDS.some(([field]) => field === key) && !(call.usage_kind === 'tool' && key === 'type'),
  )
  const costDetail = call.cost.detail
  return (
    <div>
      <div className="px-5 pt-1 pb-4">
        {onBack && (
          <Button size="sm" variant="ghost" className="-ml-2 mb-2" onClick={onBack}>
            <ArrowLeft /> Back to finding
          </Button>
        )}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2">
            <Icon className={call.is_model ? 'size-4 text-model' : 'size-4 text-tool'} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{call.resource.name}</h2>
            <p className="truncate text-[13px] text-ink-3">
              {call.resource.provider} · {call.resource.operation}
              {call.resource.modality && ` · ${call.resource.modality}`}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2.5">
          <code className="min-w-0 flex-1 truncate text-[12px] text-ink-2" title={call.record_id}>
            {call.record_id}
          </code>
          <CopyButton value={call.record_id} label="record ID" />
        </div>
      </div>

      <InspectorSection title="Cost">
        {call.cost.amount == null ? (
          <Callout tone="warn" title="Unknown cost">
            This record has no <code>cost.total_cost</code>. It is excluded from every total and never counted as zero.
          </Callout>
        ) : (
          <>
            <p className="text-2xl font-semibold tracking-[-0.02em]">
              <Money amount={call.cost.amount} currency={call.cost.currency} />
            </p>
            <p className="mt-0.5 text-xs text-ink-3">Reported cost.total_cost (net of discounts)</p>
            {costDetail && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {Object.entries(costDetail).flatMap(([key, value]) =>
                  value && typeof value === 'object'
                    ? Object.entries(value as Record<string, unknown>).map(([sub, subValue]) => (
                        <Field key={`${key}.${sub}`} label={`${key}.${sub}`}>
                          {typeof subValue === 'string' && /^-?\d/.test(subValue) && call.cost.currency ? (
                            <Money amount={subValue} currency={call.cost.currency} className="tabular" />
                          ) : (
                            String(subValue)
                          )}
                        </Field>
                      ))
                    : [
                        <Field key={key} label={key}>
                          {typeof value === 'string' && key !== 'discount_percent' && call.cost.currency ? (
                            <Money amount={value} currency={call.cost.currency} className="tabular" />
                          ) : (
                            String(value)
                          )}
                        </Field>,
                      ],
                )}
              </dl>
            )}
          </>
        )}
      </InspectorSection>

      <InspectorSection title={call.is_model ? 'Usage' : 'Tool usage'}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {call.is_model &&
            LLM_FIELDS.map(([key, label]) => (
              <Field key={key} label={label}>
                <span className="tabular">
                  <Value value={call.usage[key]} />
                </span>
              </Field>
            ))}
          {!call.is_model && (
            <Field label="Type">
              <Value value={call.usage.type} />
            </Field>
          )}
          {extraCounters.map(([key, value]) => (
            <Field key={key} label={key}>
              <span className="tabular">
                <Value value={value} />
              </span>
            </Field>
          ))}
        </dl>
      </InspectorSection>

      <InspectorSection title="Timing">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Field label="Event time (local)">{formatDateTime(call.event_ms)}</Field>
          <Field label="Duration">{call.duration_ms != null ? formatDuration(call.duration_ms) : <Value value={null} />}</Field>
          <Field label="Ends at (run offset)">{runStartMs != null ? formatOffset(call.event_ms - runStartMs) : '—'}</Field>
          <Field label="Raw timing.event_time" full={call.event_time}>
            <code className="text-[12px]">{call.event_time}</code>
          </Field>
        </dl>
      </InspectorSection>

      <InspectorSection title="Run and span">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Field label="run_id" full={call.run_id}>
            <code className="text-[12px]">{call.run_id}</code>
          </Field>
          <Field label="span_id">
            <code className="text-[12px]">{call.span_id}</code>
          </Field>
          <Field label="parent_span_id">
            {call.parent_span_id ? <code className="text-[12px]">{call.parent_span_id}</code> : <Value value={null} />}
          </Field>
          <Field label="step">
            <Value value={call.step} />
          </Field>
          <Field label="run_type">
            <Value value={call.run_type} />
          </Field>
          <Field label="outcome">
            <Value value={call.outcome} />
          </Field>
          {(call.error_code || call.error_reason) && (
            <Field label="error">
              <span className="text-bad-ink">
                {call.error_code} {call.error_reason && `— ${call.error_reason}`}
              </span>
            </Field>
          )}
          <Field label="environment">
            {call.environment ?? (
              <span className="inline-flex items-center gap-1 text-warn-ink">
                <CircleAlert className="size-3.5" /> missing
              </span>
            )}
          </Field>
        </dl>
      </InspectorSection>

      {Object.keys(call.labels).length > 0 && (
        <InspectorSection title="Labels">
          <ul className="flex flex-wrap gap-1.5">
            {Object.entries(call.labels).map(([key, value]) => (
              <li key={key}>
                <Badge tone="outline" className="h-auto max-w-full py-1 whitespace-normal">
                  <span className="text-ink-3">{key}:</span> <span className="break-all text-ink">{value}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}

      <InspectorSection title="Provenance">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Field label="Source line">
            {call.line} <span className="text-ink-3">(record {call.item})</span>
          </Field>
          <Field label="AUDR spec_version">{call.spec_version}</Field>
          <Field label="Emitter">
            {call.emitter.component} · {call.emitter.name} {call.emitter.version}
          </Field>
          <Field label="Record SHA-256">
            <code className="text-[12px]" title={call.content_sha256}>
              {call.content_sha256.slice(0, 16)}…
            </code>
          </Field>
          {call.corrects && (
            <Field label="Corrects">
              <code className="text-[12px]">{call.corrects}</code>
            </Field>
          )}
        </dl>
      </InspectorSection>

      <InspectorSection title={`Findings on this call (${related.length})`}>
        {related.length === 0 ? (
          <p className="text-[13px] text-ink-3">No finding flags this call.</p>
        ) : (
          <ul className="space-y-1">
            {related.map((finding) => {
              const meta = categoryMeta(finding.category)
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    onClick={() => onSelectFinding(finding.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left text-[13px] hover:bg-hover"
                  >
                    <meta.icon aria-hidden className="size-4 shrink-0 text-candidate-ink" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-ink-3">{finding.category_label}</span>
                      <span className="block truncate">{finding.title}</span>
                    </span>
                    {finding.dismissed && <Badge>Dismissed</Badge>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </InspectorSection>
    </div>
  )
}
