import { Bot, FileCode2, Info, Lock, Plus, Split, Terminal } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import type { Job, Lane, OverlapPair, TaskView } from '../../shared/api';
import { ago, filesOf, plural, short } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { LANE_STYLE } from './lanes';
import { Avatar, Button, cx, Tip } from './ui/primitives';

const COLUMNS: Lane[] = ['editing', 'waiting', 'check-failed', 'conflict', 'accepted'];

const HINTS: Record<Lane, string> = {
  editing: 'A workspace is open. Edits there are not part of any change until recorded.',
  waiting: 'Recorded and composable with current. Waiting for checks or for you to accept.',
  'check-failed': 'A declared check failed on the change. It is kept intact and cannot be accepted.',
  conflict: 'Zit refused to compose it with current (stale or text conflict). Retry rebuilds it on current.',
  accepted: 'Landed: part of the current state.',
  error: 'Zit could not evaluate this change.',
  closed: 'No open workspace and nothing pending.',
};

export function substatus(t: TaskView): string {
  const ws = t.primaryWorkspace;
  switch (t.lane) {
    case 'editing':
      if (ws?.merge_parent) return 'Retry — resolve and record';
      if (ws?.alive) return 'Agent running';
      return t.workspaces.some((w) => w.dirty) ? 'Unrecorded edits' : 'No edits yet';
    case 'waiting':
      return t.primaryChange?.status === 'verified' ? 'Verified · ready to accept' : 'Recorded · needs checks';
    case 'check-failed':
      return t.primaryChange && 'detail' in t.primaryChange ? `Failed: ${(t.primaryChange.detail as string[]).join(', ')}` : 'Check failed';
    case 'conflict':
      return t.primaryChange && 'reason' in t.primaryChange && t.primaryChange.reason === 'stale' ? 'Stale against current' : 'Text conflict';
    case 'accepted':
      return t.workspaces.length ? 'Accepted · workspace still open' : 'Landed';
    default:
      return '';
  }
}

function overlapsOf(id: string, overlaps: OverlapPair[]) {
  return overlaps.filter((o) => o.a === id || o.b === id);
}

function TaskCard({ task, overlaps, job, selected, onSelect, nameOf }: { task: TaskView; overlaps: OverlapPair[]; job: Job | undefined; selected: boolean; onSelect: () => void; nameOf: (id: string) => string }) {
  const s = LANE_STYLE[task.lane];
  const files = filesOf(task.footprint.writes);
  const mine = overlapsOf(task.id, overlaps);
  const strong = mine.some((o) => o.level === 'resource');
  return (
    <motion.div layout layoutId={task.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
      <button
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${task.title}, ${s.label}, owner ${task.owner}. ${task.why}`}
        className={cx(
          'group relative w-full overflow-hidden rounded-xl border bg-panel p-3.5 text-left transition-all',
          'hover:-translate-y-px hover:border-line-strong hover:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)]',
          selected ? 'border-[var(--brand)] shadow-[0_0_0_3px_var(--glow)]' : 'border-line',
        )}
      >
        <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b to-transparent', s.bar)} />
        <div className="mb-1.5 flex items-center gap-2">
          <span className={cx('truncate text-[11.5px] font-medium', s.text)}>{substatus(task)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-faint">{ago(task.createdAt)}</span>
        </div>
        <div className="line-clamp-2 text-[13.5px] leading-snug font-medium text-ink">{task.title}</div>
        <div className="mt-2.5 flex items-center gap-2 text-xs text-dim">
          <Avatar name={task.owner} size={20} />
          <span className="truncate">{task.owner}</span>
          {task.source === 'external' && (
            <span className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-1.5 py-0.5 text-[10.5px] ring-1 ring-line" title="Started outside Switchyard (for example with git zit run)">
              <Terminal className="size-3" aria-hidden /> CLI
            </span>
          )}
          {task.primaryWorkspace?.alive && <Bot className="size-3.5 text-sky-500" aria-label="Agent process running" />}
          <span className="ml-auto font-mono text-[10.5px] text-faint">{task.primaryChange ? short(task.primaryChange.id, 7) : task.primaryWorkspace ? `ws ${task.primaryWorkspace.id}` : ''}</span>
        </div>
        {(files.length > 0 || task.footprint.claims.length > 0 || mine.length > 0) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 text-[11px] text-dim">
            {files.length > 0 && (
              <span className="inline-flex items-center gap-1" title={files.join('\n')}>
                <FileCode2 className="size-3.5" aria-hidden />
                {plural(files.length, 'file')}
              </span>
            )}
            {task.footprint.claims.length > 0 && (
              <span className="inline-flex items-center gap-1" title={task.footprint.claims.join('\n')}>
                <Lock className="size-3.5" aria-hidden />
                {plural(task.footprint.claims.length, 'claim')}
              </span>
            )}
            {mine.length > 0 && (
              <span
                className={cx(
                  'ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1',
                  strong ? 'bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300' : 'bg-amber-500/8 text-amber-700 ring-amber-500/20 dark:text-amber-300',
                )}
                title={`Overlaps with ${mine.map((o) => nameOf(o.a === task.id ? o.b : o.a)).join(', ')}. Textual signal only; Zit decides at accept.`}
              >
                <Split className="size-3" aria-hidden />
                {strong ? 'same symbol' : 'same file'} · {mine.map((o) => nameOf(o.a === task.id ? o.b : o.a)).join(', ')}
              </span>
            )}
          </div>
        )}
        {job && (
          <div className="mt-2.5" role="status" aria-label={`${job.kind === 'accept' ? 'Accepting' : 'Running checks'}`}>
            <div className="mb-1 text-[11px] text-dim">{job.kind === 'accept' ? 'Accepting through Zit…' : 'Running checks…'}</div>
            <div className="h-1 overflow-hidden rounded-full bg-panel-3">
              <div className="progress-indeterminate h-full w-2/5 rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-2))]" />
            </div>
          </div>
        )}
      </button>
    </motion.div>
  );
}

export function Board({ onNewTask }: { onNewTask: () => void }) {
  const { state, selected, select, jobs } = useWorkbench();
  if (!state) return null;
  const nameOf = (id: string) => state.tasks.find((t) => t.id === id)?.owner ?? id;
  const jobFor = (t: TaskView) => jobs.find((j) => j.state === 'running' && j.changeId === t.primaryChange?.id);
  const others = state.tasks.filter((t) => t.lane === 'error' || t.lane === 'closed');

  if (state.tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-panel/50 px-6 py-16 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-panel-2 ring-1 ring-line">
          <Split className="size-5 text-[var(--brand)]" />
        </div>
        <h2 className="text-base font-semibold">No sessions yet</h2>
        <p className="mt-1.5 max-w-md text-sm text-dim">
          Create a task to open an isolated Zit workspace for it. Work there with any editor or coding agent; Switchyard tracks claims, overlaps, checks and acceptance.
        </p>
        <Button variant="primary" className="mt-5" icon={<Plus className="size-4" />} onClick={onNewTask}>
          New task
        </Button>
      </div>
    );
  }

  return (
    <LayoutGroup>
      <div className="scroll-thin -mx-3 px-3 pb-2 sm:-mx-5 sm:px-5 md:overflow-x-auto">
        <div className="grid grid-cols-1 gap-3 md:min-w-[980px] md:grid-cols-5">
          {COLUMNS.map((lane) => {
            const s = LANE_STYLE[lane];
            const tasks = state.tasks.filter((t) => t.lane === lane);
            return (
              <section key={lane} aria-label={`${s.label} (${tasks.length})`} className="flex flex-col rounded-2xl md:min-h-[220px] border border-line bg-panel-2/40 p-2">
                <header className="flex items-center gap-2 px-1.5 pt-1 pb-2.5">
                  <span className={cx('flex size-6 items-center justify-center rounded-lg ring-1', s.soft, s.text)}>{s.icon('size-3.5')}</span>
                  <h3 className="text-[13px] font-semibold">{s.label}</h3>
                  <span className="rounded-full bg-panel-3 px-1.5 text-[11px] font-medium text-dim tabular-nums">{tasks.length}</span>
                  <Tip label={HINTS[lane]}>
                    <button className="ml-auto rounded p-0.5 text-faint hover:text-dim" aria-label={`About ${s.label}`}>
                      <Info className="size-3.5" />
                    </button>
                  </Tip>
                </header>
                <div className="flex flex-1 flex-col gap-2">
                  <AnimatePresence mode="popLayout">
                    {tasks.map((t) => (
                      <TaskCard key={t.id} task={t} overlaps={state.overlaps} job={jobFor(t)} selected={selected === t.id} onSelect={() => select(selected === t.id ? null : t.id)} nameOf={nameOf} />
                    ))}
                  </AnimatePresence>
                  {tasks.length === 0 && <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-faint md:py-6">Nothing here</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {others.length > 0 && (
        <section aria-label="Other" className="mt-3 rounded-2xl border border-line bg-panel-2/40 p-2">
          <h3 className="px-1.5 pt-1 pb-2 text-[13px] font-semibold">Needs attention / closed</h3>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {others.map((t) => (
              <TaskCard key={t.id} task={t} overlaps={state.overlaps} job={jobFor(t)} selected={selected === t.id} onSelect={() => select(t.id)} nameOf={nameOf} />
            ))}
          </div>
        </section>
      )}
    </LayoutGroup>
  );
}
