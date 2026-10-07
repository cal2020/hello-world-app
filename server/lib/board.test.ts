import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/api';
import type { ChangeRow, Overview, WorkspaceRow } from '../../shared/engine-types';
import { computeOverlaps, deriveTasks, laneFor, sessionFor } from './board';

const oid = (n: number) => n.toString(16).padStart(40, '0');

function ws(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id,
    base: oid(1),
    base_state: oid(2),
    merge_parent: null,
    intent: 'x',
    agent: 'a',
    session: null,
    created: 100,
    pid: null,
    path: `/z/ws/${id}/tree`,
    dirty: false,
    alive: null,
    writes: [],
    claims: [],
    overlaps: [],
    ...over,
  };
}

function change(n: number, over: Partial<ChangeRow> & Record<string, unknown> = {}): ChangeRow {
  return {
    id: oid(n),
    state: oid(n + 1000),
    parents: [oid(1)],
    intent: 'x',
    summary: null,
    agent: 'a',
    session: null,
    reads: [],
    time: 200,
    usage: null,
    status: 'speculative',
    ...over,
  } as ChangeRow;
}

const task = (id: string, changeIds: string[] = []): Task => ({ id, repoId: 'r', title: `Task ${id}`, owner: id, notes: '', createdAt: 1, changeIds });

const overview = (workspaces: WorkspaceRow[], changes: ChangeRow[]): Overview => ({
  current: { ...change(1), status: 'current' } as unknown as Overview['current'],
  changes,
  workspaces,
});

describe('laneFor', () => {
  it('separates editing, waiting, check failed, conflict and accepted', () => {
    expect(laneFor([ws('w', { dirty: true })], [], []).lane).toBe('editing');
    expect(laneFor([ws('w')], [], []).lane).toBe('editing');
    expect(laneFor([], [change(5)], []).lane).toBe('waiting');
    expect(laneFor([], [change(5, { status: 'verified' })], []).why).toMatch(/Verified/);
    expect(laneFor([], [change(5, { status: 'invalid', reason: 'failed', detail: ['unit'] })], []).lane).toBe('check-failed');
    expect(laneFor([], [change(5, { status: 'invalid', reason: 'stale', detail: [{ resource: 'a.rs#f', kind: 'write-write', by: null }] })], []).lane).toBe('conflict');
    expect(laneFor([], [change(5, { status: 'invalid', reason: 'conflict', detail: ['a.rs'] })], []).lane).toBe('conflict');
    expect(laneFor([], [change(5, { status: 'invalid', reason: 'error', detail: 'bad toml' })], []).lane).toBe('error');
    expect(laneFor([], [], [oid(5)]).lane).toBe('accepted');
    expect(laneFor([], [], []).lane).toBe('closed');
  });

  it('unrecorded edits on top of a recorded change mean editing, not waiting', () => {
    expect(laneFor([ws('w', { dirty: true })], [change(5, { status: 'verified' })], []).lane).toBe('editing');
  });

  it('an accepted change with its clean workspace still open is accepted, not editing', () => {
    const r = laneFor([ws('w')], [], [oid(5)]);
    expect(r.lane).toBe('accepted');
    expect(r.why).toMatch(/still open/);
  });

  it('a retry workspace (merge parent) is editing even before new edits', () => {
    expect(laneFor([ws('w', { merge_parent: oid(9) })], [], []).why).toMatch(/retry/);
  });
});

describe('deriveTasks', () => {
  it('groups engine objects by Switchyard session and keeps external work visible', () => {
    const t1 = task('t1');
    const views = deriveTasks({
      overview: overview(
        [ws('w1', { session: sessionFor('t1'), dirty: true, writes: ['a.js#f'] }), ws('w2', { session: 'claude-123', agent: 'claude', intent: 'Agent run' })],
        [change(7, { session: sessionFor('t1') }), change(8, { session: null, agent: 'ci' })],
      ),
      tasks: [t1],
      accepted: new Set(),
      changeWrites: new Map([[oid(7), ['b.js']]]),
    });
    const mine = views.find((v) => v.id === 't1')!;
    expect(mine.source).toBe('switchyard');
    expect(mine.workspaces.map((w) => w.id)).toEqual(['w1']);
    expect(mine.pending.map((c) => c.id)).toEqual([oid(7)]);
    expect(mine.footprint.writes).toEqual(['a.js#f', 'b.js']);
    const external = views.filter((v) => v.source === 'external');
    expect(external.map((v) => v.id).sort()).toEqual([`ext:ch:${oid(8)}`, 'ext:claude-123']);
    expect(external.find((v) => v.id === 'ext:claude-123')!.title).toBe('Agent run');
  });

  it('enables accept only for an eligible, fully recorded change', () => {
    const base = { tasks: [task('t')], accepted: new Set<string>(), changeWrites: new Map() };
    const s = sessionFor('t');
    const verified = deriveTasks({ ...base, overview: overview([], [change(5, { session: s, status: 'verified' })]) })[0]!;
    expect(verified.actions).toMatchObject({ accept: true, check: true, discard: true, record: false });
    const failed = deriveTasks({ ...base, overview: overview([], [change(5, { session: s, status: 'invalid', reason: 'failed', detail: ['unit'] })]) })[0]!;
    expect(failed.actions).toMatchObject({ accept: false, check: true, retry: false });
    const stale = deriveTasks({ ...base, overview: overview([], [change(5, { session: s, status: 'invalid', reason: 'conflict', detail: ['a'] })]) })[0]!;
    expect(stale.actions).toMatchObject({ accept: false, retry: true });
    const dirty = deriveTasks({ ...base, overview: overview([ws('w', { session: s, dirty: true })], [change(5, { session: s, status: 'verified' })]) })[0]!;
    expect(dirty.actions).toMatchObject({ accept: false, check: false, record: true, dispose: true });
  });

  it('shows a task as accepted from its recorded change ids', () => {
    const v = deriveTasks({ overview: overview([], []), tasks: [task('t', [oid(5)])], accepted: new Set([oid(5)]), changeWrites: new Map() })[0]!;
    expect(v.lane).toBe('accepted');
    expect(v.accepted).toEqual([oid(5)]);
  });
});

describe('computeOverlaps', () => {
  const s = (id: string) => sessionFor(id);
  const build = (aWrites: string[], bWrites: string[], extra: Partial<ChangeRow> & Record<string, unknown> = {}) =>
    deriveTasks({
      overview: overview([], [change(5, { session: s('a'), time: 1 }), change(6, { session: s('b'), time: 2, ...extra })]),
      tasks: [task('a'), task('b')],
      accepted: new Set(),
      changeWrites: new Map([
        [oid(5), aWrites],
        [oid(6), bWrites],
      ]),
    });

  it('same file, different symbols is a file-level signal without an engine verdict', () => {
    const [pair] = computeOverlaps(build(['src/p.js#tax'], ['src/p.js#formatTotal']));
    expect(pair!.level).toBe('file');
    expect(pair!.shared).toEqual([{ a: 'src/p.js#tax', b: 'src/p.js#formatTotal', level: 'file' }]);
    expect(pair!.engineVerdict).toEqual([]);
  });

  it('same symbol, or a whole file against a symbol, is resource-level', () => {
    expect(computeOverlaps(build(['src/p.js#tax'], ['src/p.js#tax']))[0]!.level).toBe('resource');
    expect(computeOverlaps(build(['src/p.js'], ['src/p.js#tax']))[0]!.level).toBe('resource');
  });

  it('different files do not overlap', () => {
    expect(computeOverlaps(build(['src/a.js'], ['src/b.js']))).toEqual([]);
  });

  it('attaches Zit verdicts separately from the textual overlap', () => {
    const [pair] = computeOverlaps(build(['src/p.js#tax'], ['src/p.js#tax'], { status: 'invalid', reason: 'conflict', detail: ['src/p.js'] }));
    expect(pair!.engineVerdict).toEqual([{ task: 'b', reason: 'conflict', detail: ['src/p.js'] }]);
  });

  it('ignores accepted and closed tasks', () => {
    const views = deriveTasks({
      overview: overview([], [change(6, { session: s('b'), time: 2 })]),
      tasks: [task('a', [oid(5)]), task('b')],
      accepted: new Set([oid(5)]),
      changeWrites: new Map([[oid(6), ['src/p.js']]]),
    });
    expect(computeOverlaps(views)).toEqual([]);
  });
});
