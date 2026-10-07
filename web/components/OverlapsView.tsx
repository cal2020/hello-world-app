import { Info, Split } from 'lucide-react';
import { useState } from 'react';
import type { OverlapPair, TaskView } from '../../shared/api';
import { describeResource } from '../../shared/resource';
import { useWorkbench } from '../lib/workbench';
import { LANE_STYLE } from './lanes';
import { Avatar, Callout, cx, Panel, SectionTitle } from './ui/primitives';

export function OverlapsView() {
  const { state, select } = useWorkbench();
  const [focus, setFocus] = useState<OverlapPair | null>(null);
  if (!state) return null;
  const active = state.tasks.filter((t) => t.lane !== 'accepted' && t.lane !== 'closed');
  const pair = (a: string, b: string) => state.overlaps.find((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a));
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const label = (t: TaskView) => (
    <span className="flex justify-center" title={`${t.owner} · ${t.title}`}>
      <Avatar name={t.owner} size={24} />
      <span className="sr-only">{t.owner}</span>
    </span>
  );

  return (
    <div className="space-y-4">
      <Callout tone="info" icon={<Info className="size-4" />} title="Overlap is a signal for review, not a conflict verdict">
        Cells show where two unaccepted tasks write or claim the same file. Zit composes edits to different symbols of one file, and refuses only what is stale or does not merge — that verdict appears as{' '}
        <b>Zit: stale / conflict</b>, separately from the overlap.
      </Callout>
      {active.length < 2 ? (
        <Panel className="p-8 text-center text-sm text-dim">Overlaps appear when at least two tasks are in flight.</Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Panel className="scroll-thin overflow-x-auto p-4">
            <table className="border-separate border-spacing-1.5 text-[12.5px]" aria-label="Overlap matrix">
              <thead>
                <tr>
                  <th className="sr-only">Task</th>
                  {active.map((t) => (
                    <th key={t.id} scope="col" className="w-11 max-w-11 px-0 pb-1 text-left font-medium text-dim">
                      {label(t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="max-w-44 pr-2 text-left font-medium">
                      <span className="flex items-center gap-1.5">
                        <span className={cx('size-2 shrink-0 rounded-full', LANE_STYLE[row.lane].dot)} aria-hidden />
                        <span className="truncate" title={row.title}>
                          {row.owner} <span className="font-normal text-faint">· {row.title}</span>
                        </span>
                      </span>
                    </th>
                    {active.map((col) => {
                      if (col.id === row.id)
                        return (
                          <td key={col.id} className="p-0" aria-label="same task">
                            <div className="size-11 rounded-lg bg-[repeating-linear-gradient(135deg,var(--line)_0_2px,transparent_2px_7px)]" />
                          </td>
                        );
                      const o = pair(row.id, col.id);
                      const engine = o?.engineVerdict.length ?? 0;
                      return (
                        <td key={col.id} className="p-0">
                          <button
                            disabled={!o}
                            onClick={() => o && setFocus(o)}
                            aria-label={o ? `${row.owner} and ${col.owner}: ${o.level === 'resource' ? 'same symbol' : 'same file'}, ${o.shared.length} shared` : `${row.owner} and ${col.owner}: no overlap`}
                            className={cx(
                              'relative flex size-11 items-center justify-center rounded-lg text-[11px] font-semibold ring-1 transition',
                              !o && 'bg-panel-2/30 text-faint ring-line',
                              o?.level === 'file' && 'bg-amber-500/15 text-amber-700 ring-amber-500/30 hover:bg-amber-500/25 dark:text-amber-300',
                              o?.level === 'resource' && 'bg-orange-500/25 text-orange-700 ring-orange-500/40 hover:bg-orange-500/35 dark:text-orange-200',
                              focus && o && focus === o && 'ring-2 ring-[var(--brand)]',
                            )}
                          >
                            {o ? o.shared.length : '·'}
                            {engine > 0 && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-rose-500 ring-2 ring-panel" title="Zit verdict on one side" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-dim">
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-amber-500/25 ring-1 ring-amber-500/40" /> same file, different symbols
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-orange-500/35 ring-1 ring-orange-500/50" /> same symbol or whole file
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-rose-500" /> Zit verdict (stale/conflict) on a side
              </span>
            </div>
          </Panel>
          <Panel className="p-4">
            <SectionTitle>{focus ? 'Shared resources' : 'All overlaps'}</SectionTitle>
            {(focus ? [focus] : state.overlaps).length === 0 && <p className="text-sm text-dim">No overlapping work right now.</p>}
            <ul className="space-y-3">
              {(focus ? [focus] : state.overlaps).map((o) => {
                const a = byId.get(o.a)!;
                const b = byId.get(o.b)!;
                return (
                  <li key={`${o.a}-${o.b}`} className="rounded-xl border border-line bg-panel-2/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                      <Split className={cx('size-4', o.level === 'resource' ? 'text-orange-500' : 'text-amber-500')} aria-hidden />
                      <button className="hover:underline" onClick={() => select(a.id)}>
                        {a.owner}
                      </button>
                      <span className="text-faint">↔</span>
                      <button className="hover:underline" onClick={() => select(b.id)}>
                        {b.owner}
                      </button>
                    </div>
                    <ul className="space-y-1 text-[12px]">
                      {o.shared.map((s, i) => (
                        <li key={i} className="rounded-lg bg-panel px-2.5 py-1.5 ring-1 ring-line">
                          <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-faint">
                            <span className={cx('rounded px-1 font-medium', s.level === 'resource' ? 'bg-orange-500/15 text-orange-600 dark:text-orange-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
                              {s.level === 'resource' ? 'same symbol' : 'same file'}
                            </span>
                          </div>
                          <div className="font-mono break-all">
                            <span className="text-faint">{a.owner}:</span> {describeResource(s.a)}
                          </div>
                          <div className="font-mono break-all">
                            <span className="text-faint">{b.owner}:</span> {describeResource(s.b)}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {o.engineVerdict.length > 0 ? (
                      <div className="mt-2 border-t border-line pt-2 text-xs text-rose-700 dark:text-rose-300">
                        {o.engineVerdict.map((v, i) => (
                          <div key={i}>
                            Zit: {byId.get(v.task)?.owner}’s change is {v.reason === 'stale' ? 'stale against current' : 'in text conflict with current'} ({v.detail.join(', ')}).
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 border-t border-line pt-2 text-xs text-dim">No Zit verdict against either side. Accepting one first may still make the other stale if an interface it reads changes.</p>
                    )}
                  </li>
                );
              })}
            </ul>
            {focus && (
              <button className="mt-3 text-xs text-dim hover:text-ink" onClick={() => setFocus(null)}>
                Show all overlaps
              </button>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
