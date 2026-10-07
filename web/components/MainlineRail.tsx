import { GitCommitHorizontal, GitMerge } from 'lucide-react';
import { motion } from 'motion/react';
import type { Lane, RepoState, TaskView } from '../../shared/api';
import { ago, short } from '../lib/format';
import { useWorkbench } from '../lib/workbench';
import { substatus } from './Board';
import { LANE_STYLE } from './lanes';
import { Avatar, cx, Tip } from './ui/primitives';

const SHOWN: Lane[] = ['editing', 'waiting', 'check-failed', 'conflict', 'accepted'];
const STROKE: Record<Lane, string> = {
  editing: '#0ea5e9',
  waiting: '#f59e0b',
  'check-failed': '#f43f5e',
  conflict: '#f97316',
  accepted: '#10b981',
  error: '#d946ef',
  closed: '#71717a',
};
const ORDER: Lane[] = ['waiting', 'check-failed', 'conflict', 'error', 'editing'];

const H = 136;
const MID = H / 2;
const STEP = 38;
const FAN_GAP = 84;
const FAN_STEP = 62;
const MAX_FAN = 10;

/**
 * The accepted line (left) and the work in flight branching off it (right):
 * a railway switchyard. Recorded changes draw solid tracks; open workspaces
 * with nothing recorded yet draw dashed ones.
 */
function Track({ state }: { state: RepoState }) {
  const { select, selected } = useWorkbench();
  const entries = [...state.mainline].slice(0, 12).reverse();
  const flight = state.tasks
    .filter((t) => t.lane !== 'accepted' && t.lane !== 'closed')
    .sort((a, b) => ORDER.indexOf(a.lane) - ORDER.indexOf(b.lane) || b.createdAt - a.createdAt)
    .slice(0, MAX_FAN);
  const xc = 18 + Math.max(0, entries.length - 1) * STEP;
  const pos = (j: number) => ({ x: xc + FAN_GAP + j * FAN_STEP, y: MID + (j % 2 === 0 ? -30 : 30), up: j % 2 === 0 });
  const width = Math.max(xc + 40, flight.length ? pos(flight.length - 1).x + 40 : 0);

  const node = (t: TaskView, j: number) => {
    const p = pos(j);
    return (
      <Tip
        key={t.id}
        label={
          <div className="space-y-0.5">
            <div className="font-medium">{t.title}</div>
            <div className="text-dim">
              {t.owner} · {LANE_STYLE[t.lane].label} — {substatus(t)}
            </div>
          </div>
        }
      >
        <motion.button
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.15 + j * 0.04, type: 'spring', stiffness: 400, damping: 25 }}
          onClick={() => select(selected === t.id ? null : t.id)}
          aria-label={`${t.title}: ${t.owner}, ${LANE_STYLE[t.lane].label}`}
          className={cx('absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full p-[3px] transition hover:scale-110', selected === t.id && 'scale-110')}
          style={{ left: p.x, top: p.y, background: STROKE[t.lane], boxShadow: selected === t.id ? `0 0 0 4px var(--panel), 0 0 0 6px ${STROKE[t.lane]}` : `0 0 18px -2px ${STROKE[t.lane]}` }}
        >
          <Avatar name={t.owner} size={24} />
          <span
            aria-hidden
            className={cx('pointer-events-none absolute left-1/2 -translate-x-1/2 text-[10.5px] font-medium whitespace-nowrap', p.up ? 'bottom-full mb-1' : 'top-full mt-1')}
            style={{ color: STROKE[t.lane] }}
          >
            {t.owner}
          </span>
        </motion.button>
      </Tip>
    );
  };

  return (
    <div className="scroll-thin relative overflow-x-auto">
      <div className="relative" style={{ width, height: H }}>
        <svg width={width} height={H} className="absolute inset-0" aria-hidden>
          <defs>
            <linearGradient id="mainline-g" x1="0" x2="1">
              <stop offset="0" stopColor="var(--line-strong)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--brand)" />
            </linearGradient>
          </defs>
          <line x1={0} y1={MID} x2={xc} y2={MID} stroke="url(#mainline-g)" strokeWidth={3} strokeLinecap="round" />
          {flight.map((t, j) => {
            const p = pos(j);
            const recorded = t.pending.length > 0 && !t.workspaces.some((w) => w.dirty);
            return (
              <motion.path
                key={t.id}
                d={`M ${xc} ${MID} C ${xc + 44} ${MID}, ${p.x - 52} ${p.y}, ${p.x - 15} ${p.y}`}
                fill="none"
                stroke={STROKE[t.lane]}
                strokeOpacity={0.75}
                strokeWidth={2}
                strokeDasharray={recorded ? undefined : '4 5'}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: j * 0.04, ease: 'easeOut' }}
              />
            );
          })}
        </svg>
        <ol aria-label="Accepted history, oldest to newest">
          {entries.map((e, i) => {
            const isCurrent = i === entries.length - 1;
            const x = 18 + i * STEP;
            return (
              <li key={e.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: x, top: MID }}>
                <Tip
                  label={
                    <div className="space-y-0.5">
                      <div className="font-medium">
                        {isCurrent && 'Current · '}
                        {e.subject}
                      </div>
                      <div className="text-dim">
                        {e.agent} · {ago(e.time * 1000)} · <span className="font-mono">{short(e.id)}</span>
                      </div>
                      {e.composed && <div className="text-dim">Composed by Zit onto a moved current</div>}
                    </div>
                  }
                >
                  <span
                    tabIndex={0}
                    aria-label={`${isCurrent ? 'Current: ' : ''}${e.subject} by ${e.agent}`}
                    className={cx(
                      'relative z-10 flex items-center justify-center rounded-full ring-4 ring-panel',
                      isCurrent ? 'pulse-ring size-8 bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] text-white' : 'size-5 bg-panel-3 text-dim',
                    )}
                  >
                    {e.composed ? <GitMerge className={isCurrent ? 'size-4' : 'size-3'} /> : <GitCommitHorizontal className={isCurrent ? 'size-4' : 'size-3'} />}
                  </span>
                </Tip>
              </li>
            );
          })}
        </ol>
        {flight.map(node)}
      </div>
    </div>
  );
}

export function MainlineRail({ state }: { state: RepoState }) {
  const counts = Object.fromEntries(SHOWN.map((l) => [l, state.tasks.filter((t) => t.lane === l).length])) as Record<Lane, number>;
  const inFlight = state.tasks.filter((t) => t.lane !== 'accepted' && t.lane !== 'closed').length;

  return (
    <section aria-label="Mainline" className="relative overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_12rem_at_30%_0%,var(--glow),transparent_70%)]" />
      <div className="relative grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-semibold tracking-tight">Mainline</h2>
            <p className="min-w-0 truncate text-[13px] text-dim">
              current <span className="font-mono text-ink">{short(state.current?.id)}</span> · “{state.current?.intent}”
            </p>
          </div>
          <p className="mt-0.5 text-xs text-faint">
            {inFlight === 0 ? 'Nothing in flight.' : `${inFlight} task${inFlight === 1 ? '' : 's'} in flight — solid tracks are recorded changes, dashed ones are open workspaces.`}
          </p>
          <div className="mt-1">
            <Track state={state} />
          </div>
        </div>
        <dl className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {SHOWN.map((l) => {
            const s = LANE_STYLE[l];
            return (
              <div key={l} className={cx('rounded-xl px-2 py-2 ring-1 sm:min-w-[88px] sm:px-2.5', counts[l] ? s.soft : 'bg-panel-2/60 ring-line')}>
                <dt className={cx('flex items-center gap-1 text-[11px] font-medium', counts[l] ? s.text : 'text-faint')}>
                  {s.icon('size-3.5 shrink-0')}
                  <span className="sr-only sm:not-sr-only sm:truncate">{s.label}</span>
                </dt>
                <dd className="mt-0.5 text-xl font-semibold tabular-nums">{counts[l]}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
