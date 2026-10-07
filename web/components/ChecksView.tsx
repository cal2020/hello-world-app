import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ShieldCheck, ShieldOff, Terminal } from 'lucide-react';
import { Fragment, useState } from 'react';
import { api } from '../lib/api';
import { ago, duration, short } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { RunStatus } from './InspectorTabs';
import { Button, Callout, cx, Panel, SectionTitle, Skeleton } from './ui/primitives';

export function ChecksView() {
  const { state, repoId, run, select } = useWorkbench();
  const history = useQuery({ queryKey: ['checks', repoId], queryFn: () => api.checks(repoId!), refetchInterval: 5000 });
  const [open, setOpen] = useState<string | null>(null);
  if (!state) return null;
  const taskName = (id: string | null) => state.tasks.find((t) => t.id === id)?.title ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
      <Panel className="h-fit p-4">
        <SectionTitle>Declared by current’s zit.toml</SectionTitle>
        {state.commands.configError ? (
          <Callout tone="danger">{state.commands.configError}</Callout>
        ) : state.commands.current.length === 0 ? (
          <p className="text-sm text-dim">
            No commands declared. Add <code className="font-mono">[[check]]</code> entries to <code className="font-mono">zit.toml</code> so accept verifies changes.
          </p>
        ) : (
          <ul className="space-y-2">
            {state.commands.current.map((c) => (
              <li key={c.key} className="rounded-xl border border-line bg-panel-2/40 p-3">
                <div className="flex items-center gap-2 text-[13px]">
                  <Terminal className="size-3.5 text-dim" aria-hidden />
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-faint">{c.kind}</span>
                  <span className={cx('ml-auto inline-flex items-center gap-1 text-xs', c.approved ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-300')}>
                    {c.approved ? <ShieldCheck className="size-3.5" aria-hidden /> : <ShieldOff className="size-3.5" aria-hidden />}
                    {c.approved ? 'approved' : 'not approved'}
                  </span>
                </div>
                <pre className="mt-2 overflow-x-auto font-mono text-[12px] whitespace-pre-wrap break-all">{c.run}</pre>
                {c.approved && (
                  <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => void run('Revoke approval', () => api.revoke(repoId!, c.key), { success: () => `Approval for “${c.name}” revoked.` })}>
                    Revoke approval
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs leading-relaxed text-faint">Changes may declare more checks in their own zit.toml; they are shown for approval before they first run.</p>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <SectionTitle>Check and accept history</SectionTitle>
          <p className="-mt-1 text-xs text-dim">Runs started from Switchyard. Output is bounded and redacted.</p>
        </div>
        {history.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (history.data ?? []).length === 0 ? (
          <p className="p-6 text-center text-sm text-dim">No runs yet. Run checks from a task’s inspector.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="bg-panel-2/50 text-left text-[11px] tracking-wider text-faint uppercase">
                <tr>
                  <th className="w-8" />
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Task</th>
                  <th className="px-3 py-2 font-semibold">Change</th>
                  <th className="px-3 py-2 font-semibold">Kind</th>
                  <th className="px-3 py-2 font-semibold">Result</th>
                  <th className="px-3 py-2 font-semibold">Checks</th>
                </tr>
              </thead>
              <tbody>
                {history.data!.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-t border-line hover:bg-panel-2/40">
                      <td className="pl-2">
                        <button aria-label={open === r.id ? 'Hide output' : 'Show output'} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="rounded p-1 text-faint hover:text-ink">
                          <ChevronRight className={cx('size-4 transition-transform', open === r.id && 'rotate-90')} />
                        </button>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-dim">{ago(r.startedAt)}</td>
                      <td className="max-w-56 truncate px-3 py-2">
                        {r.taskId && taskName(r.taskId) ? (
                          <button className="truncate hover:underline" onClick={() => select(r.taskId)}>
                            {taskName(r.taskId)}
                          </button>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px]">{short(r.changeId)}</td>
                      <td className="px-3 py-2 capitalize">{r.kind}</td>
                      <td className="px-3 py-2">
                        <RunStatus status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-dim">
                        {r.verdicts.map((v) => (
                          <span key={v.check} className={cx('mr-2', v.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                            {v.passed ? '✓' : '✗'} {v.check}
                          </span>
                        ))}
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr className="bg-panel-2/30">
                        <td colSpan={7} className="px-4 py-3">
                          {r.message && <p className="mb-2 text-[12.5px]">{r.message}</p>}
                          {r.verdicts.length === 0 && <p className="text-xs text-dim">No verdicts were reported.</p>}
                          {r.verdicts.map((v) => (
                            <div key={v.check} className="mb-3 last:mb-0">
                              <div className="mb-1 text-xs text-dim">
                                <b className="text-ink">{v.check}</b> · exit {v.exitCode} · {duration(v.durationMs)}
                                {v.cached && ' · reused earlier evidence'}
                                {v.outputRedacted && ' · secrets masked'}
                                {v.outputTruncated && ' · tail only'}
                              </div>
                              <pre className="scroll-thin max-h-64 overflow-auto rounded-lg bg-panel px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim ring-1 ring-line">{v.output || '(no output)'}</pre>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
