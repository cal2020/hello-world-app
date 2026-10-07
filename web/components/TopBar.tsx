import * as Popover from '@radix-ui/react-popover';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Cpu, FolderGit2, HardDrive, Monitor, Moon, Plus, RefreshCw, Sun, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ago, short } from '../lib/format';
import { useTheme } from '../lib/theme';
import { useWorkbench } from '../lib/workbench';
import { Logo } from './Logo';
import { Button, cx, IconButton, Kbd, Tip } from './ui/primitives';

function RepoSwitcher({ onRegister }: { onRegister: () => void }) {
  const { repoId, setRepoId } = useWorkbench();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [open, setOpen] = useState(false);
  const current = repos.data?.find((r) => r.id === repoId);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-panel-2/70 px-2.5 text-sm transition hover:border-line-strong"
          aria-label={`Repository: ${current?.name ?? 'none selected'}. Change repository`}
        >
          <FolderGit2 className="size-4 shrink-0 text-dim" aria-hidden />
          <span className="truncate font-medium">{current?.name ?? 'Choose repository'}</span>
          {current?.demo && <span className="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-600 uppercase dark:text-amber-300">demo</span>}
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-[60] w-[min(92vw,380px)] rounded-xl border border-line-strong bg-panel p-1.5 shadow-2xl shadow-black/25">
          <div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">Repositories</div>
          <ul role="listbox" aria-label="Registered repositories" className="max-h-72 overflow-y-auto">
            {(repos.data ?? []).map((r) => (
              <li key={r.id}>
                <button
                  role="option"
                  aria-selected={r.id === repoId}
                  onClick={() => {
                    setRepoId(r.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-panel-2"
                >
                  <FolderGit2 className="size-4 shrink-0 text-dim" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="block truncate font-mono text-[11px] text-faint">{r.path}</span>
                  </span>
                  {r.id === repoId && <Check className="size-4 text-[var(--brand)]" aria-hidden />}
                </button>
              </li>
            ))}
            {repos.data?.length === 0 && <li className="px-2 py-3 text-sm text-dim">No repositories registered yet.</li>}
          </ul>
          <div className="mt-1 border-t border-line pt-1">
            <button
              onClick={() => {
                setOpen(false);
                onRegister();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-ink hover:bg-panel-2"
            >
              <Plus className="size-4" aria-hidden /> Register a repository…
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EnginePill() {
  const engine = useQuery({ queryKey: ['engine'], queryFn: () => api.engine() });
  const e = engine.data;
  if (!e) return null;
  const ok = e.found && !e.problem;
  return (
    <Tip
      side="bottom"
      label={
        <div className="space-y-1.5 py-0.5">
          <div>
            <b>Zit {e.version ?? '—'}</b> · git {e.gitVersion ?? '—'}
          </div>
          <div className="font-mono text-[11px] break-all text-dim">{e.bin}</div>
          <div>{e.copyOnWrite.detail}</div>
          {e.problem && <div className="text-amber-600 dark:text-amber-300">{e.problem}</div>}
        </div>
      }
    >
      <span
        tabIndex={0}
        className={cx(
          'hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs md:inline-flex',
          ok ? 'border-line text-dim' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        )}
      >
        {ok ? <Cpu className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
        zit {e.version ?? 'missing'}
        <span className="text-faint">·</span>
        <HardDrive className="size-3.5" aria-hidden />
        {e.copyOnWrite.supported ? 'copy-on-write' : 'plain checkouts'}
      </span>
    </Tip>
  );
}

function LiveIndicator() {
  const { lastUpdated, stateError, refresh, repoId } = useWorkbench();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!repoId) return null;
  const stale = stateError !== null;
  return (
    <div className="flex items-center gap-1">
      <span className={cx('hidden items-center gap-1.5 text-xs sm:inline-flex', stale ? 'text-rose-600 dark:text-rose-300' : 'text-dim')} aria-live="polite">
        <span className={cx('size-1.5 rounded-full', stale ? 'bg-rose-500' : 'pulse-ring bg-emerald-500')} />
        {stale ? 'Not updating' : lastUpdated ? `Live · ${ago(lastUpdated)}` : 'Connecting…'}
      </span>
      <IconButton label="Refresh now (R)" onClick={() => void refresh()}>
        <RefreshCw className="size-4" />
      </IconButton>
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;
  return (
    <IconButton label={`Theme: ${theme} (switch to ${next})`} onClick={() => setTheme(next)}>
      <Icon className="size-4" />
    </IconButton>
  );
}

export function TopBar({ onNewTask, onRegister }: { onNewTask: () => void; onRegister: () => void }) {
  const { state } = useWorkbench();
  return (
    <header className="glass sticky top-0 z-40 border-b border-line">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="hidden text-[15px] font-semibold tracking-tight lg:block">Switchyard</span>
        </div>
        <span className="hidden h-5 w-px bg-line sm:block" />
        <RepoSwitcher onRegister={onRegister} />
        {state?.current && (
          <Tip label={`Current state: ${state.current.intent} — by ${state.current.agent}`} side="bottom">
            <span tabIndex={0} className="hidden items-center gap-1.5 text-xs text-dim xl:inline-flex">
              current
              <code className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-300">{short(state.current.id)}</code>
            </span>
          </Tip>
        )}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <EnginePill />
          <LiveIndicator />
          <ThemeToggle />
          {state?.initialised && (
            <Button variant="primary" onClick={onNewTask} icon={<Plus className="size-4" />} aria-keyshortcuts="n">
              <span className="hidden sm:inline">New task</span>
              <span className="hidden opacity-70 sm:inline">
                <Kbd>N</Kbd>
              </span>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
