import { CheckCircle2, CircleSlash, Clock, LifeBuoy, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { Button, Callout, cx, Panel, Spinner } from './ui/primitives';

export function RecoveryBanner() {
  const { state, repoId, run, setView } = useWorkbench();
  const interrupted = state?.operations.filter((o) => o.status === 'interrupted') ?? [];
  if (!state) return null;
  return (
    <>
      {state.lockWarning && (
        <Callout tone="danger" icon={<LifeBuoy className="size-4" />} title="Zit’s current ref is locked">
          {state.lockWarning}
        </Callout>
      )}
      {interrupted.length > 0 && (
        <Callout tone="warn" icon={<LifeBuoy className="size-4" />} title={`${interrupted.length} operation${interrupted.length === 1 ? ' was' : 's were'} interrupted when Switchyard stopped`}>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span>{interrupted[0]!.label}. </span>
            <Button size="sm" variant="secondary" onClick={() => setView('journal')}>
              See recovery steps
            </Button>
            <Button size="sm" variant="ghost" onClick={() => interrupted.forEach((o) => void run('Dismiss', () => api.dismiss(repoId!, o.id)))}>
              Dismiss
            </Button>
          </div>
        </Callout>
      )}
    </>
  );
}

export function JournalView() {
  const { state, repoId, run } = useWorkbench();
  if (!state) return null;
  const ops = [...state.operations].reverse();
  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-[13px] font-semibold">Operation journal</h3>
        <p className="text-xs text-dim">Each engine action is written here before it starts, so an interrupted one is visible after a restart. Completed entries are hidden.</p>
      </div>
      {ops.length === 0 ? (
        <p className="p-6 text-center text-sm text-dim">Nothing needs attention.</p>
      ) : (
        <ul className="divide-y divide-line">
          {ops.map((o) => (
            <li key={o.id} className="flex gap-3 px-4 py-3">
              <span className="mt-0.5">
                {o.status === 'pending' ? (
                  <Spinner />
                ) : o.status === 'done' ? (
                  <CheckCircle2 className="size-4 text-emerald-500" />
                ) : o.status === 'interrupted' ? (
                  <Clock className="size-4 text-amber-500" />
                ) : o.status === 'cancelled' ? (
                  <CircleSlash className="size-4 text-dim" />
                ) : (
                  <XCircle className="size-4 text-rose-500" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-medium">{o.label}</span>
                  <span className={cx('text-xs', o.status === 'failed' ? 'text-rose-600 dark:text-rose-300' : o.status === 'interrupted' ? 'text-amber-600 dark:text-amber-300' : 'text-dim')}>{o.status}</span>
                  <span className="ml-auto text-xs text-faint">{ago(o.startedAt)}</span>
                </div>
                {o.message && <p className="mt-0.5 text-[12.5px] text-dim">{o.message}</p>}
                {o.recovery && (
                  <p className="mt-1.5 rounded-lg bg-amber-500/8 px-2.5 py-1.5 text-[12.5px] text-amber-900 ring-1 ring-amber-500/20 dark:text-amber-100">
                    <b>Recovery:</b> {o.recovery}
                  </p>
                )}
              </div>
              {o.status !== 'pending' && (
                <Button size="sm" variant="ghost" onClick={() => void run('Dismiss', () => api.dismiss(repoId!, o.id))}>
                  Dismiss
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
