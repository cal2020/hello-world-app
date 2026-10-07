// Derives the board from engine state. Pure: given Zit's overview and
// Switchyard's annotations it returns task views and overlap pairs, so it is
// tested without git. Nothing here is stored; it is recomputed on every read.

import type { ChangeRow, Invalid, Oid, Overview, ResourceText, WorkspaceRow } from '../../shared/engine-types';
import { SESSION_PREFIX, type Lane, type OverlapLevel, type OverlapPair, type Task, type TaskActions, type TaskView } from '../../shared/api';
import { heldWith, parseResource } from '../../shared/resource';

export const sessionFor = (taskId: string) => `${SESSION_PREFIX}${taskId}`;
export const taskIdOfSession = (session: string | null) =>
  session?.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : null;

export interface BoardInput {
  overview: Overview;
  tasks: Task[];
  /** Change ids known to be accepted (or current). */
  accepted: ReadonlySet<Oid>;
  /** What each pending change wrote, from `zit show` (immutable per change). */
  changeWrites: ReadonlyMap<Oid, ResourceText[]>;
}

interface Group {
  key: string;
  task: Task | null;
  workspaces: WorkspaceRow[];
  pending: ChangeRow[];
}

const NO_ACTIONS: TaskActions = { record: false, claim: false, check: false, accept: false, retry: false, discard: false, dispose: false };

function invalidOf(c: ChangeRow): Invalid | null {
  return c.status === 'invalid' ? (c as ChangeRow & Invalid) : null;
}

/** Lane and reason for one group of engine objects. */
export function laneFor(workspaces: WorkspaceRow[], pending: ChangeRow[], accepted: Oid[]): { lane: Lane; why: string } {
  const dirty = workspaces.find((w) => w.dirty || w.merge_parent !== null);
  if (dirty) {
    const running = dirty.alive ? ' An agent process is running in it.' : '';
    return dirty.merge_parent
      ? { lane: 'editing', why: `Rebuilt on current by retry; resolve and record it.${running}` }
      : { lane: 'editing', why: `Workspace ${dirty.id} has edits that are not recorded yet.${running}` };
  }
  const latest = pending[0];
  if (latest) {
    const invalid = invalidOf(latest);
    if (invalid?.reason === 'failed') return { lane: 'check-failed', why: `Check ${invalid.detail.join(', ')} failed on this change. The change is kept.` };
    if (invalid?.reason === 'stale')
      return { lane: 'conflict', why: `Stale: current changed ${invalid.detail.length} resource(s) this change wrote or read. Zit refuses it until retried.` };
    if (invalid?.reason === 'conflict') return { lane: 'conflict', why: `Text does not merge with current in ${invalid.detail.join(', ')}.` };
    if (invalid?.reason === 'error') return { lane: 'error', why: `Zit cannot evaluate this change: ${invalid.detail}` };
    if (latest.status === 'verified') return { lane: 'waiting', why: 'Verified: composes with current and its checks passed. Accepting re-checks the composed state.' };
    return { lane: 'waiting', why: 'Recorded. Checks have not produced evidence for it yet.' };
  }
  if (accepted.length > 0) {
    const open = workspaces.length ? ' Its workspace is still open; dispose it when done.' : '';
    return { lane: 'accepted', why: `Its recorded change is part of the current state.${open}` };
  }
  if (workspaces.length > 0) return { lane: 'editing', why: `Workspace ${workspaces[0]!.id} is open with no edits yet.` };
  return { lane: 'closed', why: 'No open workspace and no pending change.' };
}

function actionsFor(lane: Lane, workspaces: WorkspaceRow[], latest: ChangeRow | null): TaskActions {
  const ws = workspaces[0] ?? null;
  const invalid = latest ? invalidOf(latest) : null;
  const dirty = workspaces.some((w) => w.dirty || w.merge_parent !== null);
  return {
    ...NO_ACTIONS,
    record: dirty,
    claim: ws !== null,
    dispose: ws !== null,
    // Actions on a change only when nothing newer sits unrecorded on top of it.
    check: latest !== null && !dirty && (latest.status === 'speculative' || latest.status === 'verified' || invalid?.reason === 'failed'),
    accept: latest !== null && !dirty && (latest.status === 'speculative' || latest.status === 'verified') && lane === 'waiting',
    retry: latest !== null && !dirty && (invalid?.reason === 'stale' || invalid?.reason === 'conflict'),
    discard: latest !== null,
  };
}

function uniqueSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

export function deriveTasks(input: BoardInput): TaskView[] {
  const { overview, tasks, accepted, changeWrites } = input;
  const groups = new Map<string, Group>();
  const known = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) groups.set(t.id, { key: t.id, task: t, workspaces: [], pending: [] });

  const groupFor = (session: string | null, fallback: string): Group => {
    const taskId = taskIdOfSession(session);
    const key = taskId && known.has(taskId) ? taskId : `ext:${session ?? fallback}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, task: null, workspaces: [], pending: [] }));
    return g;
  };

  // External workspaces without a session own the changes recorded from them
  // (a recorded workspace's base is its newest change).
  const byBase = new Map<Oid, Group>();
  for (const ws of overview.workspaces) {
    const g = groupFor(ws.session, `ws:${ws.id}`);
    g.workspaces.push(ws);
    byBase.set(ws.base, g);
  }
  for (const c of overview.changes) {
    if (c.status === 'accepted' || c.status === 'current') continue;
    const viaSession = taskIdOfSession(c.session) !== null || c.session !== null;
    const g = viaSession ? groupFor(c.session, `ch:${c.id}`) : (byBase.get(c.id) ?? groupFor(null, `ch:${c.id}`));
    g.pending.push(c);
  }

  const views: TaskView[] = [];
  for (const g of groups.values()) {
    g.pending.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
    g.workspaces.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    const acceptedIds = (g.task?.changeIds ?? []).filter((id) => accepted.has(id));
    const { lane, why } = laneFor(g.workspaces, g.pending, acceptedIds);
    const latest = g.pending[0] ?? null;
    const first = g.workspaces[0] ?? null;
    const writes = uniqueSorted([...g.workspaces.flatMap((w) => w.writes), ...g.pending.flatMap((c) => changeWrites.get(c.id) ?? [])]);
    const claims = uniqueSorted(g.workspaces.flatMap((w) => w.claims));
    const external = g.task === null;
    views.push({
      id: g.key,
      source: external ? 'external' : 'switchyard',
      title: g.task?.title ?? latest?.intent ?? first?.intent ?? '(no intent)',
      owner: g.task?.owner ?? latest?.agent ?? first?.agent ?? 'unknown',
      notes: g.task?.notes ?? '',
      createdAt: g.task?.createdAt ?? (first?.created ?? latest?.time ?? 0) * 1000,
      lane,
      why,
      workspaces: g.workspaces,
      pending: g.pending,
      accepted: acceptedIds,
      primaryChange: latest,
      primaryWorkspace: first,
      footprint: { writes, claims },
      actions: actionsFor(lane, g.workspaces, latest),
    });
  }
  return views.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/**
 * Pairs of unaccepted tasks that touch the same files. This is a textual
 * signal for review, not a conflict verdict: Zit composes edits to different
 * symbols of one file, and only its accept decides. Engine verdicts on either
 * side are attached separately so the UI can show both without mixing them.
 */
export function computeOverlaps(views: TaskView[]): OverlapPair[] {
  const active = views.filter((v) => v.lane !== 'accepted' && v.lane !== 'closed');
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      const mine = [...a.footprint.writes, ...a.footprint.claims];
      const theirs = [...b.footprint.writes, ...b.footprint.claims];
      const shared: OverlapPair['shared'] = [];
      const seen = new Set<string>();
      for (const x of mine) {
        const rx = parseResource(x);
        for (const y of theirs) {
          const ry = parseResource(y);
          if (rx.path !== ry.path) continue;
          const level: OverlapLevel = heldWith(rx, ry) ? 'resource' : 'file';
          const key = `${x}\0${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          shared.push({ a: x, b: y, level });
        }
      }
      if (shared.length === 0) continue;
      // Keep the strongest evidence: drop same-file rows for paths that also overlap exactly.
      const strongPaths = new Set(shared.filter((s) => s.level === 'resource').map((s) => parseResource(s.a).path));
      const kept = shared.filter((s) => s.level === 'resource' || !strongPaths.has(parseResource(s.a).path));
      const verdict = (v: TaskView) => {
        const inv = v.primaryChange ? invalidOf(v.primaryChange) : null;
        if (inv?.reason === 'stale') return [{ task: v.id, reason: 'stale' as const, detail: inv.detail.map((s) => s.resource) }];
        if (inv?.reason === 'conflict') return [{ task: v.id, reason: 'conflict' as const, detail: inv.detail }];
        return [];
      };
      pairs.push({
        a: a.id,
        b: b.id,
        level: kept.some((s) => s.level === 'resource') ? 'resource' : 'file',
        shared: kept,
        engineVerdict: [...verdict(a), ...verdict(b)],
      });
    }
  }
  return pairs;
}
