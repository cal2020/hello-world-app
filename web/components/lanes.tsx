import { CircleCheckBig, CircleDashed, GitMerge, Hourglass, OctagonX, PencilLine, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Lane } from '../../shared/api';
import { cx } from './ui/primitives';

export const LANE_STYLE: Record<Lane, { label: string; icon: (cls?: string) => ReactNode; text: string; soft: string; dot: string; bar: string }> = {
  editing: {
    label: 'Editing',
    icon: (c) => <PencilLine className={c} aria-hidden />,
    text: 'text-sky-600 dark:text-sky-300',
    soft: 'bg-sky-500/10 ring-sky-500/25',
    dot: 'bg-sky-500',
    bar: 'from-sky-500/70',
  },
  waiting: {
    label: 'Waiting',
    icon: (c) => <Hourglass className={c} aria-hidden />,
    text: 'text-amber-600 dark:text-amber-300',
    soft: 'bg-amber-500/10 ring-amber-500/25',
    dot: 'bg-amber-500',
    bar: 'from-amber-500/70',
  },
  'check-failed': {
    label: 'Check failed',
    icon: (c) => <OctagonX className={c} aria-hidden />,
    text: 'text-rose-600 dark:text-rose-300',
    soft: 'bg-rose-500/10 ring-rose-500/25',
    dot: 'bg-rose-500',
    bar: 'from-rose-500/70',
  },
  conflict: {
    label: 'Conflict',
    icon: (c) => <GitMerge className={c} aria-hidden />,
    text: 'text-orange-600 dark:text-orange-300',
    soft: 'bg-orange-500/10 ring-orange-500/25',
    dot: 'bg-orange-500',
    bar: 'from-orange-500/70',
  },
  accepted: {
    label: 'Accepted',
    icon: (c) => <CircleCheckBig className={c} aria-hidden />,
    text: 'text-emerald-600 dark:text-emerald-300',
    soft: 'bg-emerald-500/10 ring-emerald-500/25',
    dot: 'bg-emerald-500',
    bar: 'from-emerald-500/70',
  },
  error: {
    label: 'Engine error',
    icon: (c) => <TriangleAlert className={c} aria-hidden />,
    text: 'text-fuchsia-600 dark:text-fuchsia-300',
    soft: 'bg-fuchsia-500/10 ring-fuchsia-500/25',
    dot: 'bg-fuchsia-500',
    bar: 'from-fuchsia-500/70',
  },
  closed: {
    label: 'Closed',
    icon: (c) => <CircleDashed className={c} aria-hidden />,
    text: 'text-dim',
    soft: 'bg-panel-2 ring-line',
    dot: 'bg-faint',
    bar: 'from-zinc-500/50',
  },
};

export function LaneBadge({ lane, className }: { lane: Lane; className?: string }) {
  const s = LANE_STYLE[lane];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1', s.soft, s.text, className)}>
      {s.icon('size-3.5')}
      {s.label}
    </span>
  );
}
