import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { CircleStop, GitMerge, MoreHorizontal, PackageCheck, RotateCcw, Save, ShieldCheck, Terminal, Trash2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { TaskView } from '../../shared/api';
import { api } from '../lib/api';
import { duration, short } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { substatus } from './Board';
import { CommandList } from './ApproveDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ChecksTab, ClaimsTab, DiffTab, OverviewTab, useChange } from './InspectorTabs';
import { LANE_STYLE, LaneBadge } from './lanes';
import { Dialog } from './ui/dialog';
import { Avatar, Button, Callout, cx, Field, IconButton, inputClass, Spinner, Tip } from './ui/primitives';

function RecordDialog({ task, open, onOpenChange }: { task: TaskView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { repoId, run } = useWorkbench();
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const ws = task.workspaces.find((w) => w.dirty || w.merge_parent) ?? task.primaryWorkspace;
  if (!ws) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Save className="size-4.5 text-[var(--brand)]" />}
      title="Record workspace as a change"
      description={
        <>
          Zit snapshots workspace <span className="font-mono">{ws.id}</span> into an immutable change for review. The workspace stays open so work can continue.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<Save className="size-4" />}
            onClick={async () => {
              setBusy(true);
              const r = await run('Record', () => api.record(repoId!, ws.id, summary), {
                success: (rec) => (rec.change ? `Recorded change ${short(rec.change.id)} (${rec.writes.length} resource${rec.writes.length === 1 ? '' : 's'}).` : 'Nothing to record: the workspace matches its base.'),
              });
              setBusy(false);
              if (r) {
                setSummary('');
                onOpenChange(false);
              }
            }}
          >
            Record change
          </Button>
        </>
      }
    >
      <Field id="record-summary" label="What was done and why" hint="Stored with the change as its author’s account. Optional, but reviewers rely on it.">
        <textarea id="record-summary" autoFocus className={cx(inputClass, 'min-h-[110px] resize-y')} maxLength={8000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Switched tax() to truncation per finance; updated the rounding test." />
      </Field>
    </Dialog>
  );
}

function AcceptDialog({ task, open, onOpenChange }: { task: TaskView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { repoId, state, run, track } = useWorkbench();
  const change = task.primaryChange!;
  const inspect = useChange(repoId!, change.id);
  // The current state the person is looking at when they open this dialog.
  const reviewed = useRef(state?.current?.id ?? null);
  useEffect(() => {
    if (open) reviewed.current = state?.current?.id ?? null;
  }, [open]);
  const [busy, setBusy] = useState(false);
  const moved = reviewed.current !== null && state?.current?.id !== reviewed.current;
  const fastForward = change.parents[0] === state?.current?.id;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      icon={<GitMerge className="size-4.5 text-emerald-500" />}
      title={`Accept “${task.title}”`}
      description={
        <>
          Zit will {fastForward ? 'fast-forward current to' : 'compose onto current'} change <span className="font-mono">{short(change.id)}</span>, run the checks below on the result, and move current only if they pass. A rejection keeps the change intact.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="success"
            loading={busy}
            disabled={moved || !reviewed.current}
            icon={<PackageCheck className="size-4" />}
            onClick={async () => {
              setBusy(true);
              const job = await run('Accept', () => api.accept(repoId!, change.id, reviewed.current!), { changeId: change.id });
              setBusy(false);
              if (job) {
                track(job);
                onOpenChange(false);
              }
            }}
          >
            Accept through Zit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-dim">Reviewed against current</dt>
          <dd className="font-mono">{short(reviewed.current)}</dd>
          <dt className="text-dim">Change</dt>
          <dd className="font-mono">
            {short(change.id)} <span className="font-sans text-dim">by {change.agent}</span>
          </dd>
          <dt className="text-dim">Zit status</dt>
          <dd>{change.status === 'verified' ? 'Verified (its own checks passed)' : 'Recorded (checks run during accept)'}</dd>
        </dl>
        {moved && (
          <Callout tone="warn" title="Current moved while this was open">
            Close this dialog and review the change against the new current before accepting.
          </Callout>
        )}
        {inspect.isLoading ? (
          <Spinner />
        ) : inspect.data?.configError ? (
          <Callout tone="danger">{inspect.data.configError}</Callout>
        ) : inspect.data && inspect.data.acceptCommands.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-medium text-dim">Commands Zit may run during accept</div>
            <CommandList commands={inspect.data.acceptCommands} />
          </div>
        ) : (
          <p className="text-[13px] text-dim">No checks are declared; Zit accepts when the change composes with current.</p>
        )}
      </div>
    </Dialog>
  );
}

function JobPanel({ task }: { task: TaskView }) {
  const { jobs } = useWorkbench();
  const job = jobs.find((j) => j.state === 'running' && j.changeId === task.primaryChange?.id);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job]);
  if (!job) return null;
  return (
    <div className="border-t border-line bg-panel-2/60 px-4 py-3" role="status">
      <div className="flex items-center gap-2 text-[13px]">
        <Spinner />
        <span className="font-medium">{job.kind === 'accept' ? 'Accepting through Zit' : 'Running checks'}</span>
        <span className="text-dim tabular-nums">{duration(Date.now() - job.startedAt)}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={<CircleStop className="size-3.5" />}
          onClick={() => void api.cancelJob(job.id)}
        >
          Cancel
        </Button>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-panel-3">
        <div className="progress-indeterminate h-full w-2/5 rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-2))]" />
      </div>
      <p className="mt-2 text-xs text-dim">Zit does not report per-step progress, so elapsed time is shown. Cancelling stops the process; current only moves in one atomic step.</p>
      {job.commands.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-faint">
          {job.commands.map((c) => (
            <li key={c} className="flex items-center gap-1.5 truncate">
              <Terminal className="size-3 shrink-0" aria-hidden />
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function blockedReason(task: TaskView): string {
  if (task.actions.accept) return '';
  if (task.workspaces.some((w) => w.dirty)) return 'The workspace has unrecorded edits. Record them first so the reviewed change is what lands.';
  if (!task.primaryChange) return task.lane === 'accepted' ? 'Already accepted.' : 'Nothing recorded yet.';
  if (task.lane === 'check-failed') return 'Blocked: a check failed on this change. Fix it in the workspace and record again, or re-run checks if it was flaky.';
  if (task.lane === 'conflict') return 'Blocked: Zit refuses to compose it with current. Use Retry to rebuild it on current.';
  return 'Not eligible for acceptance.';
}

export function Inspector({ task, onClose }: { task: TaskView; onClose: () => void }) {
  const { repoId, state, run, track, jobs } = useWorkbench();
  const [tab, setTab] = useState('overview');
  const [recordOpen, setRecordOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [disposeOpen, setDisposeOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [task.id]);
  const s = LANE_STYLE[task.lane];
  const nameOf = (id: string) => state?.tasks.find((t) => t.id === id)?.owner ?? id;
  const busy = jobs.some((j) => j.state === 'running' && j.changeId === task.primaryChange?.id);
  const change = task.primaryChange;
  const ws = task.primaryWorkspace;

  const runChecks = async (rerun: boolean) => {
    if (!change) return;
    const job = await run('Run checks', () => api.check(repoId!, change.id, rerun), { changeId: change.id });
    if (job) track(job);
  };

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 36 }}
      aria-label={`Task: ${task.title}`}
      className="fixed top-14 right-0 bottom-0 z-30 flex w-full flex-col border-l border-line-strong bg-panel shadow-[-24px_0_60px_-30px_rgb(0_0_0/0.45)] sm:w-[min(600px,100vw)]"
    >
      <div className="border-b border-line px-4 pt-4 pb-3 sm:px-5">
        <div className="mb-2 flex items-center gap-2">
          <LaneBadge lane={task.lane} />
          <span className={cx('truncate text-xs', s.text)}>{substatus(task)}</span>
          <IconButton label="Close (Esc)" className="ml-auto" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <h2 ref={headingRef} tabIndex={-1} className="text-lg leading-snug font-semibold tracking-tight outline-none">
          {task.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={task.owner} size={18} /> {task.owner}
          </span>
          {ws && <span className="font-mono">ws {ws.id}</span>}
          {change && <span className="font-mono">change {short(change.id)}</span>}
        </div>
        <div className={cx('mt-3 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ring-1', s.soft)}>{task.why}</div>
      </div>

      <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="Task details" className="flex gap-1 border-b border-line px-3 sm:px-4">
          {[
            ['overview', 'Overview'],
            ['diff', 'Diff'],
            ['checks', 'Checks'],
            ['claims', 'Claims & overlaps'],
          ].map(([v, label]) => (
            <Tabs.Trigger
              key={v}
              value={v!}
              className="relative px-2.5 py-2.5 text-[13px] text-dim transition hover:text-ink data-[state=active]:text-ink data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-[var(--brand)]"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <Tabs.Content value="overview">
            <OverviewTab task={task} />
          </Tabs.Content>
          <Tabs.Content value="diff">
            <DiffTab task={task} />
          </Tabs.Content>
          <Tabs.Content value="checks">
            <ChecksTab task={task} onRunChecks={(r) => void runChecks(r)} />
          </Tabs.Content>
          <Tabs.Content value="claims">
            <ClaimsTab task={task} overlaps={state?.overlaps ?? []} nameOf={nameOf} />
          </Tabs.Content>
        </div>
      </Tabs.Root>

      <JobPanel task={task} />

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel/80 px-4 py-3 sm:px-5">
        {task.actions.record && (
          <Button variant="primary" icon={<Save className="size-4" />} onClick={() => setRecordOpen(true)}>
            Record
          </Button>
        )}
        {change && (task.actions.check || task.lane === 'waiting') && (
          <Button variant="secondary" icon={<ShieldCheck className="size-4" />} disabled={!task.actions.check || busy} onClick={() => void runChecks(task.lane === 'check-failed')}>
            {task.lane === 'check-failed' ? 'Re-run checks' : 'Run checks'}
          </Button>
        )}
        {task.actions.retry && (
          <Button
            variant="primary"
            icon={<RotateCcw className="size-4" />}
            onClick={() => void run('Retry', () => api.retry(repoId!, change!.id), { success: (w) => `Opened workspace ${w.id} with the change rebuilt on current.` })}
          >
            Retry on current
          </Button>
        )}
        {task.lane !== 'accepted' && task.lane !== 'closed' && (
          <Tip label={task.actions.accept ? 'Compose with current, run checks, and land it' : blockedReason(task)}>
            <span tabIndex={task.actions.accept ? -1 : 0} className="ml-auto">
              <Button variant="success" icon={<PackageCheck className="size-4" />} disabled={!task.actions.accept || busy} onClick={() => setAcceptOpen(true)}>
                Accept
              </Button>
            </span>
          </Tip>
        )}
        {(task.actions.discard || task.actions.dispose) && (
          <Menu.Root>
            <Menu.Trigger asChild>
              <button aria-label="More actions" className={cx('inline-flex size-9 items-center justify-center rounded-lg border border-line text-dim hover:bg-panel-2 hover:text-ink', (task.lane === 'accepted' || task.lane === 'closed') && 'ml-auto')}>
                <MoreHorizontal className="size-4" />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={6} className="z-[60] min-w-56 rounded-xl border border-line-strong bg-panel p-1 shadow-2xl shadow-black/25">
                {task.actions.discard && (
                  <Menu.Item disabled={busy} onSelect={() => setDiscardOpen(true)} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-rose-600 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-rose-500/10 dark:text-rose-300">
                    <Trash2 className="size-4" /> Discard change {short(change?.id)}…
                  </Menu.Item>
                )}
                {task.actions.dispose && (
                  <Menu.Item onSelect={() => setDisposeOpen(true)} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-rose-600 outline-none data-[highlighted]:bg-rose-500/10 dark:text-rose-300">
                    <Trash2 className="size-4" /> Dispose workspace {ws?.id}…
                  </Menu.Item>
                )}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>

      {task.actions.record && <RecordDialog task={task} open={recordOpen} onOpenChange={setRecordOpen} />}
      {change && acceptOpen && <AcceptDialog task={task} open={acceptOpen} onOpenChange={setAcceptOpen} />}
      {change && (
        <ConfirmDialog
          open={discardOpen}
          onOpenChange={setDiscardOpen}
          title={`Discard change ${short(change.id)}?`}
          body={
            <>
              Zit forgets this unaccepted change. Its workspace (if open) is not affected, and current is untouched. <b className="text-ink">This cannot be undone from Switchyard.</b>
            </>
          }
          confirmText={short(change.id)}
          actionLabel="Discard change"
          onConfirm={async (typed) => void (await run('Discard', () => api.discard(repoId!, change.id, typed), { success: () => `Discarded ${short(change.id)}.` }))}
        />
      )}
      {ws && (
        <ConfirmDialog
          open={disposeOpen}
          onOpenChange={setDisposeOpen}
          title={`Dispose workspace ${ws.id}?`}
          body={
            <>
              Deletes the workspace directory <code className="font-mono text-ink">{ws.path}</code> and releases its claims. Recorded changes stay in Zit.
              {ws.dirty && (
                <div className="mt-2">
                  <Callout tone="danger">It holds unrecorded edits. They will be lost. Record first to keep them.</Callout>
                </div>
              )}
            </>
          }
          confirmText={ws.id}
          actionLabel="Dispose workspace"
          onConfirm={async (typed) => void (await run('Dispose', () => api.dispose(repoId!, ws.id, typed), { success: () => `Disposed workspace ${ws.id}.` }))}
        />
      )}
    </motion.aside>
  );
}
