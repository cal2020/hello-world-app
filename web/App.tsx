import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, LayoutGrid, ListChecks, ScrollText, Split } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ChecksView } from './components/ChecksView';
import { Inspector } from './components/Inspector';
import { JournalView, RecoveryBanner } from './components/JournalView';
import { MainlineRail } from './components/MainlineRail';
import { NewTaskDialog } from './components/NewTaskDialog';
import { EngineMissing, NotInitialised, RegisterRepoDialog, Welcome } from './components/Onboarding';
import { OverlapsView } from './components/OverlapsView';
import { TopBar } from './components/TopBar';
import { Board } from './components/Board';
import { Callout, cx, Kbd, Skeleton } from './components/ui/primitives';
import { api } from './lib/api';
import { useWorkbench, type View } from './lib/workbench';

const VIEWS: Array<{ id: View; label: string; icon: typeof LayoutGrid; key: string }> = [
  { id: 'board', label: 'Board', icon: LayoutGrid, key: '1' },
  { id: 'overlaps', label: 'Overlaps', icon: Split, key: '2' },
  { id: 'checks', label: 'Checks', icon: ListChecks, key: '3' },
  { id: 'journal', label: 'Journal', icon: ScrollText, key: '4' },
];

function ViewTabs() {
  const { view, setView, state } = useWorkbench();
  const badge: Partial<Record<View, number>> = {
    overlaps: state?.overlaps.length ?? 0,
    journal: state?.operations.filter((o) => o.status !== 'done').length ?? 0,
  };
  return (
    <nav aria-label="Views" className="flex items-center gap-1 overflow-x-auto rounded-xl border border-line bg-panel p-1">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          onClick={() => setView(v.id)}
          aria-current={view === v.id ? 'page' : undefined}
          aria-keyshortcuts={v.key}
          className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] whitespace-nowrap transition', view === v.id ? 'bg-panel-3 font-medium text-ink' : 'text-dim hover:text-ink')}
        >
          <v.icon className="size-4" aria-hidden />
          {v.label}
          {badge[v.id] ? <span className="rounded-full bg-[var(--glow)] px-1.5 text-[11px] font-semibold text-[var(--brand)] tabular-nums">{badge[v.id]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const wb = useWorkbench();
  const { repoId, state, stateError, stateLoading, view, setView, selected, select, refresh } = wb;
  const [newTask, setNewTask] = useState(false);
  const [register, setRegister] = useState(false);
  const engine = useQuery({ queryKey: ['engine'], queryFn: () => api.engine() });
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });

  // Choose the only (or first) repository when none is selected.
  useEffect(() => {
    if (!repoId && repos.data && repos.data.length > 0) wb.setRepoId(repos.data[0]!.id);
  }, [repoId, repos.data]);

  // Keyboard: N new task, 1–4 views, R refresh, Esc close inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, [contenteditable], [role="dialog"]')) return;
      if (e.key === 'Escape' && selected) select(null);
      else if (e.key === 'n' && state?.initialised) {
        e.preventDefault();
        setNewTask(true);
      } else if (e.key === 'r') void refresh();
      else {
        const v = VIEWS.find((x) => x.key === e.key);
        if (v && state?.initialised) setView(v.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, select, state?.initialised, setView, refresh]);

  const task = state?.tasks.find((t) => t.id === selected) ?? null;
  // A task that was on the board and then disappeared closes its inspector. A
  // just-created one may not be in the state yet, so it must be seen first.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (task) seen.current = task.id;
    else if (selected && state && seen.current === selected) select(null);
  }, [selected, state, task, select]);

  let body: React.ReactNode;
  if (engine.data && !engine.data.found) body = <EngineMissing problem={engine.data.problem ?? 'Zit was not found.'} />;
  else if (repos.data && repos.data.length === 0) body = <Welcome onRegister={() => setRegister(true)} />;
  else if (!repoId || stateLoading)
    body = (
      <div className="space-y-4 p-5">
        <Skeleton className="h-28" />
        <div className="grid grid-cols-5 gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      </div>
    );
  else if (stateError && !state)
    body = (
      <div className="mx-auto max-w-xl py-16">
        <Callout tone="danger" title="Could not read this repository">
          {stateError.message}
        </Callout>
      </div>
    );
  else if (state && !state.initialised) body = <NotInitialised />;
  else if (state)
    body = (
      <div className={cx('space-y-4 px-3 py-4 transition-[padding] sm:px-5 sm:py-5', task && '2xl:pr-[616px]')}>
        <RecoveryBanner />
        {stateError && (
          <Callout tone="warn" title="Showing the last known state">
            {stateError.message}
          </Callout>
        )}
        <MainlineRail state={state} />
        <div className="flex flex-wrap items-center gap-3">
          <ViewTabs />
          <p className="hidden text-xs text-faint lg:flex lg:items-center lg:gap-1.5">
            <Kbd>N</Kbd> new task <Kbd>1</Kbd>–<Kbd>4</Kbd> views <Kbd>R</Kbd> refresh <Kbd>Esc</Kbd> close
          </p>
          {state.repo.demo && (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
              <ClipboardCheck className="size-3.5" /> Synthetic demo data
            </span>
          )}
        </div>
        {view === 'board' && <Board onNewTask={() => setNewTask(true)} />}
        {view === 'overlaps' && <OverlapsView />}
        {view === 'checks' && <ChecksView />}
        {view === 'journal' && <JournalView />}
      </div>
    );

  return (
    <div className="backdrop-aurora min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2">
        Skip to content
      </a>
      <TopBar onNewTask={() => setNewTask(true)} onRegister={() => setRegister(true)} />
      <main id="main">{body}</main>
      <AnimatePresence>{task && <Inspector key="inspector" task={task} onClose={() => select(null)} />}</AnimatePresence>
      {state?.initialised && <NewTaskDialog open={newTask} onOpenChange={setNewTask} />}
      <RegisterRepoDialog open={register} onOpenChange={setRegister} />
    </div>
  );
}
