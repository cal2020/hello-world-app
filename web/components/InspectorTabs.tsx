import { useQuery } from '@tanstack/react-query';
import { Bot, CheckCircle2, CircleDashed, FolderOpen, GitCommitHorizontal, Lock, Plus, RotateCcw, ShieldAlert, ShieldCheck, Split, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChangeInspect, OverlapPair, TaskView } from '../../shared/api';
import type { Held } from '../../shared/engine-types';
import { describeResource, validateResourceInput } from '../../shared/resource';
import { api } from '../lib/api';
import { ago, duration, short } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { CommandList } from './ApproveDialog';
import { DiffView } from './DiffView';
import { Button, Callout, CopyButton, cx, Field, inputClass, Mono, SectionTitle, Skeleton, Spinner } from './ui/primitives';

export function useChange(repoId: string, changeId: string | undefined) {
  return useQuery({ queryKey: ['change', repoId, changeId], queryFn: () => api.change(repoId, changeId!), enabled: !!changeId, staleTime: 3000 });
}

function ResourceList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-[13px] text-faint">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((r) => (
        <li key={r}>
          <Mono title={r}>{describeResource(r)}</Mono>
        </li>
      ))}
    </ul>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

export function OverviewTab({ task }: { task: TaskView }) {
  const { repoId, run } = useWorkbench();
  const [notes, setNotes] = useState(task.notes);
  useEffect(() => setNotes(task.notes), [task.id, task.notes]);
  const change = task.primaryChange;
  return (
    <div className="space-y-6">
      {task.source === 'switchyard' ? (
        <div>
          <SectionTitle>Notes</SectionTitle>
          <label htmlFor="task-notes" className="sr-only">
            Task notes
          </label>
          <textarea
            id="task-notes"
            className={cx(inputClass, 'min-h-[76px] resize-y text-[13px]')}
            placeholder="Context for whoever picks this up. Stored by Switchyard only."
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if (notes !== task.notes) void run('Save notes', () => api.updateTask(repoId!, task.id, { notes }), { success: () => 'Notes saved.' });
            }}
          />
        </div>
      ) : (
        <Callout tone="info" title="Started outside Switchyard">
          Zit shows this work under session <code className="font-mono">{task.id.replace(/^ext:/, '')}</code>, probably from <code className="font-mono">git zit run</code>. Everything here comes from the engine;
          notes are not available.
        </Callout>
      )}

      {task.workspaces.map((ws) => (
        <div key={ws.id}>
          <SectionTitle aside={<span className="text-[11px] text-faint">opened {ago(ws.created * 1000)}</span>}>Workspace {ws.id}</SectionTitle>
          <div className="space-y-3 rounded-xl border border-line bg-panel-2/40 p-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="size-4 shrink-0 text-dim" aria-hidden />
              <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={ws.path}>
                {ws.path}
              </code>
              <CopyButton text={ws.path} label="Copy workspace path" />
            </div>
            <p className="text-xs leading-relaxed text-dim">
              Work here with any editor or agent, e.g. <code className="font-mono text-ink">cd {ws.path.length > 40 ? '…' + ws.path.slice(-38) : ws.path}</code>. Switchyard does not run commands in it.
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
              <dt className="text-dim">Based on</dt>
              <dd className="font-mono">{short(ws.base)}</dd>
              <dt className="text-dim">Edits</dt>
              <dd>{ws.dirty ? <span className="text-sky-600 dark:text-sky-300">unrecorded edits</span> : 'none since last record'}</dd>
              <dt className="text-dim">Agent process</dt>
              <dd className="flex items-center gap-1.5">
                {ws.alive === null ? 'none (manual)' : ws.alive ? <><Bot className="size-3.5 text-sky-500" aria-hidden /> running (pid {ws.pid})</> : `exited (pid ${ws.pid})`}
              </dd>
              {ws.merge_parent && (
                <>
                  <dt className="text-dim">Retry of</dt>
                  <dd className="font-mono">{short(ws.merge_parent)}</dd>
                </>
              )}
            </dl>
            <div>
              <div className="mb-1.5 text-xs font-medium text-dim">Writing now (live, from Zit)</div>
              <ResourceList items={ws.writes} empty="No edits detected." />
            </div>
          </div>
        </div>
      ))}

      {change && (
        <div>
          <SectionTitle aside={<span className="text-[11px] text-faint">recorded {ago(change.time * 1000)}</span>}>Pending change</SectionTitle>
          <div className="space-y-3 rounded-xl border border-line bg-panel-2/40 p-3">
            <div className="flex items-center gap-2">
              <GitCommitHorizontal className="size-4 text-dim" aria-hidden />
              <code className="font-mono text-[12.5px]">{short(change.id, 12)}</code>
              <CopyButton text={change.id} label="Copy change id" />
              <span className="ml-auto text-xs text-dim">by {change.agent}</span>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-dim">Author’s account</div>
              {change.summary ? <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{change.summary}</p> : <p className="text-[13px] text-faint">No reason was given when it was recorded.</p>}
            </div>
            {change.usage && (
              <p className="text-xs text-dim">
                Reported by the agent: {change.usage.input_tokens.toLocaleString()} input / {change.usage.output_tokens.toLocaleString()} output tokens
                {change.usage.cost_usd !== null && ` · $${change.usage.cost_usd.toFixed(4)}`}
              </p>
            )}
            {task.pending.length > 1 && <p className="text-xs text-dim">{task.pending.length - 1} earlier recorded change(s) are included in this one.</p>}
          </div>
        </div>
      )}

      <div>
        <SectionTitle>Footprint</SectionTitle>
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-xs font-medium text-dim">Writes (workspaces and pending changes)</div>
            <ResourceList items={task.footprint.writes} empty="Nothing written yet." />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-dim">Claims</div>
            <ResourceList items={task.footprint.claims} empty="No claims." />
          </div>
        </div>
      </div>

      {task.accepted.length > 0 && (
        <div>
          <SectionTitle>Accepted</SectionTitle>
          <ul className="space-y-1">
            {task.accepted.map((id) => (
              <li key={id} className="flex items-center gap-2 text-[13px]">
                <CheckCircle2 className="size-4 text-emerald-500" aria-hidden /> <code className="font-mono">{short(id, 12)}</code> is part of current
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Diff ───────────────────────────────────────────────────────────────────

export function DiffTab({ task }: { task: TaskView }) {
  const { repoId } = useWorkbench();
  const dirtyWs = task.workspaces.find((w) => w.dirty);
  const [source, setSource] = useState<'change' | 'live'>(task.primaryChange ? 'change' : 'live');
  useEffect(() => setSource(task.primaryChange && !dirtyWs ? 'change' : dirtyWs ? 'live' : 'change'), [task.id]);
  const change = useChange(repoId!, source === 'change' ? task.primaryChange?.id : undefined);
  const ws = task.primaryWorkspace;
  const live = useQuery({
    queryKey: ['wsdiff', repoId, ws?.id],
    queryFn: () => api.workspaceDiff(repoId!, ws!.id),
    enabled: source === 'live' && !!ws,
    refetchInterval: 4000,
  });
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Diff source" className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5 text-[12.5px]">
        {(
          [
            ['change', 'Recorded change', !!task.primaryChange],
            ['live', 'Live workspace edits', !!ws],
          ] as const
        ).map(([id, label, enabled]) => (
          <button
            key={id}
            role="radio"
            aria-checked={source === id}
            disabled={!enabled}
            onClick={() => setSource(id)}
            className={cx('rounded-md px-3 py-1.5 transition disabled:opacity-40', source === id ? 'bg-panel text-ink shadow-sm ring-1 ring-line' : 'text-dim hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      {source === 'change' &&
        (!task.primaryChange ? (
          <p className="text-sm text-dim">Nothing recorded yet. Record the workspace to create a change.</p>
        ) : change.isLoading ? (
          <Skeleton className="h-40" />
        ) : change.error ? (
          <Callout tone="danger">{(change.error as Error).message}</Callout>
        ) : change.data ? (
          <>
            <p className="text-xs text-dim">
              Change <span className="font-mono">{short(change.data.detail.id)}</span> against its parent <span className="font-mono">{short(change.data.detail.parents[0])}</span>.
            </p>
            <DiffView diff={change.data.diff} truncated={change.data.diffTruncated} />
          </>
        ) : null)}
      {source === 'live' &&
        (!ws ? (
          <p className="text-sm text-dim">No open workspace.</p>
        ) : live.isLoading ? (
          <Skeleton className="h-40" />
        ) : live.error ? (
          <Callout tone="danger">{(live.error as Error).message}</Callout>
        ) : live.data ? (
          <>
            <p className="text-xs text-dim">
              Unrecorded edits in workspace <span className="font-mono">{ws.id}</span> against its base <span className="font-mono">{short(ws.base)}</span>. Refreshes every few seconds.
            </p>
            {live.data.untracked.length > 0 && (
              <Callout tone="info" title="New files (included when you record)">
                <ul className="mt-1 font-mono text-[12px]">
                  {live.data.untracked.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <DiffView diff={live.data.diff} truncated={live.data.truncated} />
          </>
        ) : null)}
    </div>
  );
}

// ── Checks ─────────────────────────────────────────────────────────────────

function EvidenceCard({ e }: { e: ChangeInspect['evidence'][number] }) {
  const [open, setOpen] = useState(e.evidence ? !e.evidence.passed : false);
  if (!e.evidence) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[13px]">
        <CircleDashed className="size-4 text-faint" aria-hidden />
        <span className="font-medium">{e.check}</span>
        <span className="ml-auto text-xs text-faint">no evidence yet</span>
      </div>
    );
  }
  const ev = e.evidence;
  return (
    <div className={cx('overflow-hidden rounded-xl border', ev.passed ? 'border-emerald-500/25' : 'border-rose-500/30')}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={cx('flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px]', ev.passed ? 'bg-emerald-500/6' : 'bg-rose-500/8')}>
        {ev.passed ? <CheckCircle2 className="size-4 text-emerald-500" aria-hidden /> : <XCircle className="size-4 text-rose-500" aria-hidden />}
        <span className="font-medium">{e.check}</span>
        <span className="text-xs text-dim">{ev.passed ? 'passed' : `failed · exit ${ev.exit_code}`}</span>
        <span className="ml-auto text-xs text-faint">
          {duration(ev.duration_ms)} · {ago(ev.at * 1000)}
        </span>
      </button>
      {open && (
        <div className="border-t border-line">
          {(ev.outputTruncated || ev.outputRedacted) && (
            <p className="px-3 pt-2 text-[11px] text-faint">
              {ev.outputTruncated && 'Showing the tail of the output. '}
              {ev.outputRedacted && 'Values that look like secrets were masked.'}
            </p>
          )}
          <pre className="scroll-thin max-h-80 overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim">{ev.output || '(no output)'}</pre>
        </div>
      )}
    </div>
  );
}

export function ChecksTab({ task, onRunChecks }: { task: TaskView; onRunChecks: (rerun: boolean) => void }) {
  const { repoId, jobs } = useWorkbench();
  const change = useChange(repoId!, task.primaryChange?.id);
  const history = useQuery({ queryKey: ['checks', repoId], queryFn: () => api.checks(repoId!) });
  if (!task.primaryChange) {
    return (
      <Callout tone="info" title="Nothing to check yet">
        Checks run on recorded changes, in an isolated view of the change’s state. Record the workspace first.
      </Callout>
    );
  }
  const running = jobs.some((j) => j.state === 'running' && j.changeId === task.primaryChange!.id);
  const runs = (history.data ?? []).filter((r) => r.changeId === task.primaryChange!.id);
  const d = change.data;
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle
          aside={
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" disabled={!task.actions.check || running} onClick={() => onRunChecks(false)} icon={<ShieldCheck className="size-3.5" />}>
                Run checks
              </Button>
              <Button size="sm" variant="ghost" disabled={!task.actions.check || running} onClick={() => onRunChecks(true)} icon={<RotateCcw className="size-3.5" />}>
                Re-run all
              </Button>
            </div>
          }
        >
          Evidence for this change
        </SectionTitle>
        {change.isLoading ? (
          <Skeleton className="h-20" />
        ) : d && d.evidence.length === 0 ? (
          <p className="text-[13px] text-dim">This change’s zit.toml declares no checks.</p>
        ) : (
          <div className="space-y-2">{d?.evidence.map((e) => <EvidenceCard key={e.check} e={e} />)}</div>
        )}
        <p className="mt-2 text-xs text-faint">Evidence is Zit’s, stored per check and input content; identical inputs reuse an earlier result.</p>
      </div>

      {d && (
        <div>
          <SectionTitle>Commands that run</SectionTitle>
          {d.configError ? (
            <Callout tone="danger">{d.configError}</Callout>
          ) : (
            <div className="space-y-3">
              <p className="text-[12.5px] text-dim">
                <b className="text-ink">Run checks</b> runs the change’s own checks. <b className="text-ink">Accept</b> also runs current’s checks on the composed result, so a change cannot weaken the gate it is judged by.
              </p>
              {d.acceptCommands.length > 0 ? (
                <>
                  <CommandList commands={d.acceptCommands} />
                  <p className="flex items-center gap-1.5 text-xs text-dim">
                    {d.acceptCommands.every((c) => c.approved) ? (
                      <>
                        <ShieldCheck className="size-3.5 text-emerald-500" aria-hidden /> All approved for this repository.
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="size-3.5 text-amber-500" aria-hidden /> {d.acceptCommands.filter((c) => !c.approved).length} not approved yet — you will be asked before anything runs.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-dim">No commands declared.</p>
              )}
            </div>
          )}
        </div>
      )}

      <div>
        <SectionTitle>History for this change</SectionTitle>
        {runs.length === 0 ? (
          <p className="text-[13px] text-faint">No runs from Switchyard yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-panel-2/50 px-3 py-2 text-[12.5px]">
                <span className="font-medium capitalize">{r.kind}</span>
                <RunStatus status={r.status} />
                <span className="text-dim">{r.verdicts.map((v) => `${v.passed ? '✓' : '✗'} ${v.check}${v.cached ? ' (reused)' : ''}`).join(' · ')}</span>
                <span className="ml-auto text-faint">{ago(r.startedAt)}</span>
                {r.message && <p className="w-full text-xs text-dim">{r.message}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function RunStatus({ status }: { status: string }) {
  const tone =
    status === 'passed' || status === 'accepted'
      ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300'
      : status === 'running'
        ? 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300'
        : status === 'cancelled'
          ? 'bg-panel-3 text-dim ring-line'
          : 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300';
  return <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1', tone)}>{status === 'running' ? <span className="inline-flex items-center gap-1"><Spinner className="size-3" /> running</span> : status}</span>;
}

// ── Claims & overlaps ──────────────────────────────────────────────────────

export function ClaimsTab({ task, overlaps, nameOf }: { task: TaskView; overlaps: OverlapPair[]; nameOf: (id: string) => string }) {
  const { repoId, run } = useWorkbench();
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [refused, setRefused] = useState<Held[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ws = task.primaryWorkspace;
  const problem = draft.trim() ? validateResourceInput(draft) : null;
  const mine = overlaps.filter((o) => o.a === task.id || o.b === task.id);

  const add = () => {
    const v = draft.trim();
    if (!v || validateResourceInput(v)) return;
    if (!items.includes(v)) setItems([...items, v]);
    setDraft('');
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Claim before editing</SectionTitle>
        {!ws ? (
          <p className="text-[13px] text-dim">Claims belong to an open workspace. This task has none.</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const list = draft.trim() && !problem ? [...new Set([...items, draft.trim()])] : items;
              if (list.length === 0) return;
              setBusy(true);
              setRefused(null);
              const r = await run('Claim', () => api.claim(repoId!, ws.id, list));
              setBusy(false);
              if (r?.claim === 'granted') {
                setItems([]);
                setDraft('');
              } else if (r?.claim === 'refused') setRefused(r.held);
            }}
          >
            <Field
              id="claim-input"
              label="File or symbol"
              error={problem}
              hint={
                <>
                  <code className="font-mono">src/lib.rs</code> (whole file), <code className="font-mono">src/lib.rs#price</code> (one symbol), <code className="font-mono">src/lib.rs#</code> (module-level code). All or nothing; Zit refuses
                  what other unaccepted work holds.
                </>
              }
            >
              <div className="flex gap-2">
                <input
                  id="claim-input"
                  className={cx(inputClass, 'font-mono text-[13px]')}
                  value={draft}
                  aria-invalid={!!problem}
                  aria-describedby={problem ? 'claim-input-error' : 'claim-input-hint'}
                  placeholder="src/pricing.js#tax"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === ',' ) {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <Button type="button" variant="secondary" onClick={add} disabled={!draft.trim() || !!problem} aria-label="Add to claim list" icon={<Plus className="size-4" />} />
              </div>
            </Field>
            {items.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Resources to claim">
                {items.map((r) => (
                  <li key={r} className="inline-flex items-center gap-1 rounded-md bg-panel-2 py-0.5 pr-1 pl-2 font-mono text-[12px] ring-1 ring-line">
                    {r}
                    <button type="button" aria-label={`Remove ${r}`} onClick={() => setItems(items.filter((x) => x !== r))} className="rounded p-0.5 text-faint hover:text-ink">
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={items.length === 0 && (!draft.trim() || !!problem)} icon={<Lock className="size-3.5" />}>
              Claim through Zit
            </Button>
            {refused && (
              <Callout tone="warn" title="Zit refused the claim — nothing was claimed">
                <ul className="mt-1 space-y-1">
                  {refused.map((h, i) => (
                    <li key={i}>
                      <code className="font-mono">{h.resource}</code> is {h.by.kind === 'workspace' ? `claimed by ${h.by.agent} (workspace ${h.by.id})` : `already written by ${h.by.agent} (change ${short(h.by.id)}, not accepted yet)`}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
          </form>
        )}
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-dim">Held now</div>
          <ResourceList items={task.footprint.claims} empty="No claims." />
          {task.footprint.claims.length > 0 && <p className="mt-1.5 text-xs text-faint">Claims lapse when the workspace is disposed.</p>}
        </div>
      </div>

      <div>
        <SectionTitle>Overlaps with other work</SectionTitle>
        <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
          An overlap means both sides touch the same file. It is a review signal, not a verdict: Zit composes edits to different symbols, and only <b className="text-ink">accept</b> decides. Engine verdicts are listed separately.
        </p>
        {mine.length === 0 ? (
          <p className="text-[13px] text-faint">No overlaps with other unaccepted work.</p>
        ) : (
          <ul className="space-y-2">
            {mine.map((o) => {
              const other = o.a === task.id ? o.b : o.a;
              const flip = o.a !== task.id;
              return (
                <li key={`${o.a}-${o.b}`} className="rounded-xl border border-line bg-panel-2/40 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[13px]">
                    <Split className={cx('size-4', o.level === 'resource' ? 'text-orange-500' : 'text-amber-500')} aria-hidden />
                    <span className="font-medium">{nameOf(other)}</span>
                    <span className="text-xs text-dim">{o.level === 'resource' ? 'same symbol or whole file' : 'same file, different symbols'}</span>
                  </div>
                  <ul className="space-y-1 text-[12px]">
                    {o.shared.map((s, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-1.5 font-mono">
                        <span>{flip ? s.b : s.a}</span>
                        <span className="text-faint">↔</span>
                        <span>{flip ? s.a : s.b}</span>
                      </li>
                    ))}
                  </ul>
                  {o.engineVerdict.length > 0 && (
                    <div className="mt-2 border-t border-line pt-2 text-xs text-orange-700 dark:text-orange-300">
                      {o.engineVerdict.map((v, i) => (
                        <div key={i}>
                          Zit: {nameOf(v.task)}’s change is {v.reason === 'stale' ? 'stale' : 'in text conflict'} ({v.detail.join(', ')})
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
