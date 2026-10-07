import { Info, TriangleAlert } from 'lucide-react'
import { Fragment } from 'react'

import type {
  CallCountEvidence,
  Evidence,
  KeywordEvidence,
  ModelTierEvidence,
  SignatureEvidence,
} from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Callout } from '../../components/ui/callout'
import { ShowMoreList } from '../../components/ui/show-more'
import { cn } from '../../lib/cn'
import { formatInt } from '../../lib/format'

type SelectCall = (callId: string, runPk?: string) => void

function NotReported() {
  return <span className="text-ink-3 italic">not reported</span>
}

/** Lets a dotted field path wrap after a dot instead of mid-word. */
function FieldPath({ path }: { path: string }) {
  return path.split('.').map((part, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <>
          .<wbr />
        </>
      )}
      {part}
    </Fragment>
  ))
}

function shortRecord(id: string) {
  return id.length > 14 ? `…${id.slice(-10)}` : id
}

function SignatureView({ evidence, onSelectCall }: { evidence: SignatureEvidence; onSelectCall: SelectCall }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-2">
        {evidence.members.length} model calls{' '}
        {evidence.scope === 'run' ? 'in this run' : `across ${evidence.run_ids.length} runs`} share every field of the
        analyzer’s usage signature (every value below is equal in each call):
      </p>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full table-fixed text-[12.5px]">
          <caption className="sr-only">Usage signature shared by the calls</caption>
          <tbody className="divide-y divide-line">
            {evidence.signature.map((field) => (
              <tr key={field.field}>
                <th scope="row" className="w-[58%] bg-surface-2 px-3 py-1.5 text-left font-normal break-words text-ink-3">
                  <code className="text-[11.5px]">
                    <FieldPath path={field.field} />
                  </code>
                </th>
                <td className="px-3 py-1.5 break-words">
                  {field.value == null ? (
                    <NotReported />
                  ) : (
                    <span className="mono text-[12px]">
                      {typeof field.value === 'number' ? formatInt(field.value) : field.value}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-3">Calls with this signature</p>
        <ShowMoreList
          items={evidence.members}
          className="space-y-1"
          render={(member) => (
            <li key={member.record_id}>
              <button
                type="button"
                onClick={() => onSelectCall(member.call_id)}
                className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover"
              >
                <Badge tone={member.role === 'reference' ? 'outline' : 'candidate'} className="h-5 w-[78px] justify-center">
                  {member.role === 'reference' ? 'Reference' : 'Candidate'}
                </Badge>
                <code className="truncate text-[12px]" title={member.record_id}>
                  {shortRecord(member.record_id)}
                </code>
                {evidence.scope === 'import' && (
                  <span className="ml-auto truncate text-xs text-ink-3" title={member.run_id}>
                    {member.run_id}
                  </span>
                )}
              </button>
            </li>
          )}
        />
        <p className="mt-1.5 text-xs text-ink-3">
          The first call is the reference and is not flagged; each later call is a candidate.
        </p>
      </div>
      <Callout tone="warn" title="Matching counters are not proof">
        {evidence.statement}
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {evidence.not_compared.map((line) => (
            <li key={line}>Not compared: {line}</li>
          ))}
        </ul>
      </Callout>
    </div>
  )
}

function highlight(value: string, start?: number, end?: number) {
  if (start == null || end == null) return value
  return (
    <>
      {value.slice(0, start)}
      <mark>{value.slice(start, end)}</mark>
      {value.slice(end)}
    </>
  )
}

function KeywordView({ evidence }: { evidence: KeywordEvidence }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-2">
        The keyword fragment <code className="rounded bg-hover px-1 py-0.5 text-[12px]">{evidence.keyword}</code> appears in
        this call’s metadata:
      </p>
      <ul className="space-y-1.5">
        {evidence.matches.map((match) => (
          <li key={match.field} className="rounded-xl border border-line px-3 py-2">
            <code className="text-[11.5px] text-ink-3">{match.field}</code>
            <p className="mt-0.5 text-[13px] break-words">“{highlight(match.value, match.start, match.end)}”</p>
          </li>
        ))}
        {evidence.matches.length === 0 && evidence.combined_text && (
          <li className="rounded-xl border border-line px-3 py-2">
            <code className="text-[11.5px] text-ink-3">combined run name, run type and label values</code>
            <p className="mt-0.5 text-[13px] break-words">“{evidence.combined_text}”</p>
          </li>
        )}
      </ul>
      {evidence.also_present.length > 0 && (
        <p className="text-xs text-ink-3">
          Other keyword fragments also present: {evidence.also_present.map((k) => `“${k}”`).join(', ')}.
        </p>
      )}
      <p className="text-xs text-ink-3">Fields checked: {evidence.fields_checked.join(', ')}.</p>
      <Callout tone="warn" title="Inferred from names only">
        {evidence.statement}
      </Callout>
    </div>
  )
}

function ModelTierView({ evidence }: { evidence: ModelTierEvidence }) {
  const share = Math.min(1, evidence.token_total / evidence.token_limit)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <code className="rounded-md bg-hover px-1.5 py-0.5 text-[12px]">{evidence.model}</code>
        <span className="text-ink-3">matches the high-end pattern</span>
        <code className="rounded-md bg-hover px-1.5 py-0.5 text-[12px]">{evidence.matched_pattern}</code>
      </div>
      <div>
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-ink-2">Counted tokens (input + output + reasoning)</span>
          <span className="tabular">
            <strong className="font-semibold">{formatInt(evidence.token_total)}</strong>
            <span className="text-ink-3"> / {formatInt(evidence.token_limit)} limit</span>
          </span>
        </div>
        <div
          role="meter"
          aria-label="Counted tokens relative to the analyzer's limit"
          aria-valuemin={0}
          aria-valuemax={evidence.token_limit}
          aria-valuenow={evidence.token_total}
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-candidate-soft"
        >
          <div className="h-full rounded-full bg-candidate" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[12.5px]">
        {(['input_tokens', 'output_tokens', 'reasoning_tokens'] as const).map((key) => (
          <div key={key} className="rounded-lg border border-line px-2.5 py-1.5">
            <dt className="text-xs text-ink-3">{key.replace('_tokens', '')}</dt>
            <dd className="mt-0.5 font-medium tabular">
              {evidence.counted[key] == null ? <NotReported /> : formatInt(evidence.counted[key])}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink-3">
        Excluded tiers (names containing): {evidence.low_cost_markers.join(', ')}.
      </p>
      <Callout tone="warn" title="Quality is not measured">
        {evidence.statement}
      </Callout>
    </div>
  )
}

function CallCountView({ evidence, onSelectCall }: { evidence: CallCountEvidence; onSelectCall: SelectCall }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-2">{evidence.statement}</p>
      <p className="text-xs text-ink-3">
        Flags at {evidence.min_calls}+ model calls; medium confidence at {evidence.medium_confidence_at}+. Order:{' '}
        {evidence.ordering}.
        {evidence.ordering_note && <span className="text-warn-ink"> {evidence.ordering_note}</span>}
      </p>
      <ShowMoreList
        as="ol"
        items={evidence.sequence}
        className="space-y-1"
        render={(item) => (
          <li key={item.record_id}>
            <button
              type="button"
              onClick={() => onSelectCall(item.call_id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover',
                item.flagged ? 'border-candidate/40' : 'border-line',
              )}
            >
              <span className="w-5 text-right text-ink-3 tabular">{item.position}</span>
              <code className="truncate text-[12px]" title={item.record_id}>
                {shortRecord(item.record_id)}
              </code>
              <span className="text-xs text-ink-3">step {item.step ?? '—'}</span>
              <Badge tone={item.flagged ? 'candidate' : 'neutral'} className="ml-auto h-5">
                {item.flagged ? 'Flagged' : 'Kept'}
              </Badge>
            </button>
          </li>
        )}
      />
    </div>
  )
}

export function FindingEvidence({
  evidence,
  status,
  onSelectCall,
}: {
  evidence: Evidence
  status: 'derived' | 'unavailable'
  onSelectCall: SelectCall
}) {
  if (status !== 'derived' || evidence.kind === 'unavailable') {
    return (
      <Callout tone="warn" title="Evidence unavailable">
        The evidence for this finding could not be re-derived from the analyzer at this revision, so only the analyzer’s
        own rationale is shown below. Treat the finding with extra caution.
      </Callout>
    )
  }
  switch (evidence.kind) {
    case 'usage_signature_match':
      return <SignatureView evidence={evidence} onSelectCall={onSelectCall} />
    case 'metadata_keyword':
      return <KeywordView evidence={evidence} />
    case 'model_tier_and_size':
      return <ModelTierView evidence={evidence} />
    case 'call_count_in_run':
      return <CallCountView evidence={evidence} onSelectCall={onSelectCall} />
    default:
      return (
        <p className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <Info className="size-4" /> No structured evidence for this finding type.
        </p>
      )
  }
}

export function NotProofNote() {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-ink-3">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />A heuristic flag to review — not proof that the call was
      unnecessary.
    </p>
  )
}
