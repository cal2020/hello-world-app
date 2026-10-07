import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { CommandInfo, Job } from '../../shared/api';
import { ApproveDialog } from '../components/ApproveDialog';
import { api, ApiError, type RepoStateWithJobs } from './api';

export type View = 'board' | 'overlaps' | 'checks' | 'journal';

interface PendingApproval {
  commands: CommandInfo[];
  changeId?: string;
  retry: () => Promise<unknown>;
  label: string;
}

interface Workbench {
  repoId: string | null;
  setRepoId: (id: string | null) => void;
  state: RepoStateWithJobs | undefined;
  stateError: ApiError | null;
  stateLoading: boolean;
  lastUpdated: number;
  refresh: () => Promise<void>;
  selected: string | null;
  select: (taskId: string | null) => void;
  view: View;
  setView: (v: View) => void;
  /** Run an action; on "approval required" show the exact commands, then retry once approved. */
  run: <T>(label: string, fn: () => Promise<T>, opts?: { changeId?: string; success?: (r: T) => string | null }) => Promise<T | undefined>;
  jobs: Job[];
  track: (job: Job) => void;
}

const Ctx = createContext<Workbench | null>(null);

export const useWorkbench = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkbench outside provider');
  return v;
};

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: preference is not remembered */
  }
};

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [repoId, setRepoIdRaw] = useState<string | null>(() => read('switchyard.repo'));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setViewRaw] = useState<View>(() => (read('switchyard.view') as View) || 'board');
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const visible = useVisible();

  const setRepoId = useCallback((id: string | null) => {
    setRepoIdRaw(id);
    setSelected(null);
    write('switchyard.repo', id);
  }, []);
  const setView = useCallback((v: View) => {
    setViewRaw(v);
    write('switchyard.view', v);
  }, []);

  const q = useQuery({
    queryKey: ['state', repoId],
    queryFn: () => api.state(repoId!),
    enabled: repoId !== null,
    refetchInterval: visible ? 2500 : false,
    retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status === 404),
  });

  // A repository that was unregistered elsewhere: forget it.
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === 'unknown-repo') setRepoId(null);
  }, [q.error, setRepoId]);

  // Pick up jobs started before a reload so their progress stays visible.
  useEffect(() => {
    const running = q.data?.jobs ?? [];
    if (running.length === 0) return;
    setJobs((js) => [...js, ...running.filter((r) => !js.some((j) => j.id === r.id))]);
  }, [q.data?.jobs]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['state', repoId] });
    await qc.invalidateQueries({ queryKey: ['change'] });
    await qc.invalidateQueries({ queryKey: ['wsdiff'] });
    await qc.invalidateQueries({ queryKey: ['checks', repoId] });
  }, [qc, repoId]);

  const run = useCallback<Workbench['run']>(
    async (label, fn, opts = {}) => {
      try {
        const r = await fn();
        const msg = opts.success?.(r);
        if (msg) toast.success(msg);
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.approval) {
          setApproval({ commands: e.approval.commands, changeId: opts.changeId, label, retry: () => run(label, fn, opts) });
          return undefined;
        }
        if (e instanceof ApiError && (e.code === 'stale-review' || e.code === 'already-accepted')) {
          toast.warning(e.message);
        } else {
          toast.error(e instanceof Error ? e.message : `${label} failed.`);
        }
        return undefined;
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  const track = useCallback((job: Job) => setJobs((js) => [...js.filter((j) => j.id !== job.id), job]), []);

  // Poll tracked jobs until they finish, then report and refresh.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    const running = jobs.filter((j) => j.state === 'running');
    if (running.length === 0) return;
    const t = setInterval(async () => {
      const updated = await Promise.all(running.map((j) => api.job(j.id).catch(() => ({ ...j, state: 'failed' as const, error: 'Lost track of this job (the server may have restarted).' }))));
      setJobs((js) => js.map((j) => updated.find((u) => u.id === j.id) ?? j));
      for (const u of updated) {
        if (u.state === 'running' || reported.current.has(u.id)) continue;
        reported.current.add(u.id);
        const status = u.run?.status;
        const msg = u.run?.message ?? u.error ?? 'Finished.';
        if (status === 'accepted' || status === 'passed') toast.success(msg);
        else if (u.state === 'cancelled') toast.message(msg);
        else toast.error(msg);
        void refresh();
      }
    }, 700);
    return () => clearInterval(t);
  }, [jobs, refresh]);

  const value = useMemo<Workbench>(
    () => ({
      repoId,
      setRepoId,
      state: q.data,
      stateError: q.error instanceof ApiError ? q.error : q.error ? new ApiError(0, 'error', String(q.error), {}) : null,
      stateLoading: q.isLoading,
      lastUpdated: q.dataUpdatedAt,
      refresh,
      selected,
      select: setSelected,
      view,
      setView,
      run,
      jobs,
      track,
    }),
    [repoId, setRepoId, q.data, q.error, q.isLoading, q.dataUpdatedAt, refresh, selected, view, setView, run, jobs, track],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {approval && repoId && (
        <ApproveDialog
          repoId={repoId}
          commands={approval.commands}
          changeId={approval.changeId}
          label={approval.label}
          onClose={() => setApproval(null)}
          onApproved={async () => {
            const retry = approval.retry;
            setApproval(null);
            await retry();
          }}
        />
      )}
    </Ctx.Provider>
  );
}
