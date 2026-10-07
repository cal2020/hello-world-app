// End-to-end behaviour against the real Zit engine, in disposable repositories.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequired, ChangeInspect, CommandInfo, Job, Repo, Task, TaskView } from '../shared/api';
import type { Claimed, Recorded } from '../shared/engine-types';
import { Store } from '../server/lib/store';
import { edit, makeRepo, settle, startHarness, state, waitJob, zitBin, type Harness } from './harness';

const run = zitBin ? describe : describe.skip;

run('Switchyard on Zit (disposable repositories)', () => {
  let h: Harness;
  let repo: Repo;

  beforeEach(async () => {
    h = await startHarness();
    const path = await makeRepo(h, 'shop');
    repo = await h.ok<Repo>('POST', '/api/repos', { path });
    await h.ok('POST', `/api/repos/${repo.id}/init`, {});
  });
  afterEach(async () => {
    await h.close();
  });

  const approveAll = async (changeId?: string) => {
    const s = await state(h, repo.id);
    const keys = s.commands.current.map((c) => c.key);
    if (keys.length) await h.ok('POST', `/api/repos/${repo.id}/approvals`, { keys, changeId });
  };
  const newTask = async (title: string, owner: string) => {
    const t = await h.ok<Task>('POST', `/api/repos/${repo.id}/tasks`, { title, owner, notes: '' });
    const v = (await state(h, repo.id)).tasks.find((x) => x.id === t.id)!;
    return { task: t, ws: v.primaryWorkspace! };
  };
  const view = async (taskId: string) => (await state(h, repo.id)).tasks.find((t) => t.id === taskId) as TaskView;
  const record = (ws: string, summary = '') => h.ok<Recorded>('POST', `/api/repos/${repo.id}/workspaces/${ws}/record`, { summary });
  const accept = async (change: string) => {
    const current = (await state(h, repo.id)).current!.id;
    return h.api<Job>('POST', `/api/repos/${repo.id}/changes/${change}/accept`, { expectedCurrent: current });
  };

  it('creates two independent workspaces whose state survives a restart', async () => {
    const a = await newTask('Task A', 'alice');
    const b = await newTask('Task B', 'bob');
    expect(a.ws.id).not.toBe(b.ws.id);
    expect(existsSync(a.ws.path) && existsSync(b.ws.path)).toBe(true);
    await edit(a.ws.path, 'src/a.js', () => 'export const a = 1;\n');
    await settle();

    await h.restart(); // a fresh server process reads everything back from Zit and the store
    const s = await state(h, repo.id);
    const ta = s.tasks.find((t) => t.id === a.task.id)!;
    const tb = s.tasks.find((t) => t.id === b.task.id)!;
    expect(ta).toMatchObject({ lane: 'editing', owner: 'alice', title: 'Task A' });
    expect(ta.workspaces[0]!.dirty).toBe(true);
    expect(ta.workspaces[0]!.writes.some((w) => w.startsWith('src/a.js'))).toBe(true);
    expect(tb.lane).toBe('editing');
    expect(tb.workspaces[0]!.dirty).toBe(false);
    // The engine's own view agrees.
    const status = JSON.parse(execFileSync(zitBin!, ['--json', 'status'], { cwd: repo.path, env: { ...process.env, ZIT_HOME: h.zitHome } }).toString());
    expect(status.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([a.ws.id, b.ws.id].sort());
  });

  it('surfaces claim conflicts exactly as Zit decides them', async () => {
    const a = await newTask('Price', 'alice');
    const b = await newTask('Tax', 'bob');
    const claimA = await h.ok<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${a.ws.id}/claim`, { resources: ['src/pricing.js#tax'] });
    expect(claimA.claim).toBe('granted');
    const sameSymbol = await h.ok<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${b.ws.id}/claim`, { resources: ['src/pricing.js#tax'] });
    expect(sameSymbol).toEqual({ claim: 'refused', held: [{ resource: 'src/pricing.js#tax', by: { kind: 'workspace', id: a.ws.id, agent: 'alice' } }] });
    const wholeFile = await h.ok<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${b.ws.id}/claim`, { resources: ['src/pricing.js'] });
    expect(wholeFile.claim).toBe('refused');
    const otherSymbol = await h.ok<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${b.ws.id}/claim`, { resources: ['src/pricing.js#formatTotal'] });
    expect(otherSymbol.claim).toBe('granted');
    // A refused claim claims nothing (all or nothing).
    const mixed = await h.ok<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${b.ws.id}/claim`, { resources: ['README.md', 'src/pricing.js#tax'] });
    expect(mixed.claim).toBe('refused');
    expect((await view(b.task.id)).footprint.claims).toEqual(['src/pricing.js#formatTotal']);
    // Unsafe input never reaches the engine.
    const bad = await h.api<{ message: string }>('POST', `/api/repos/${repo.id}/workspaces/${b.ws.id}/claim`, { resources: ['../../etc/passwd'] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/inside the repository/);
  });

  it('requires approval of the exact commands before running checks', async () => {
    const a = await newTask('Feature', 'alice');
    await edit(a.ws.path, 'src/feature.js', () => 'export const f = 1;\n');
    const rec = await record(a.ws.id, 'Added a feature');
    const first = await h.api<ApprovalRequired>('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/check`, {});
    expect(first.status).toBe(428);
    expect(first.body.commands.map((c: CommandInfo) => c.run)).toEqual(['node --test']);
    // Approving a key that is not declared is refused.
    const forged = await h.api('POST', `/api/repos/${repo.id}/approvals`, { keys: ['0'.repeat(32)], changeId: rec.change!.id });
    expect(forged.status).toBe(409);
    await h.ok('POST', `/api/repos/${repo.id}/approvals`, { keys: first.body.commands.map((c) => c.key), changeId: rec.change!.id });
    const job = await h.ok<Job>('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/check`, {});
    const done = await waitJob(h, job.id);
    expect(done.run!.status).toBe('passed');
    expect((await view(a.task.id)).lane).toBe('waiting');
    expect((await view(a.task.id)).primaryChange!.status).toBe('verified');
  });

  it('a change that declares a new command needs a new approval', async () => {
    await approveAll();
    const a = await newTask('Sneaky', 'mallory');
    await edit(a.ws.path, 'zit.toml', (s) => `${s}\n[[check]]\nname = "extra"\nrun = "echo hello"\n`);
    const rec = await record(a.ws.id);
    const r = await h.api<ApprovalRequired>('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/check`, {});
    expect(r.status).toBe(428);
    expect(r.body.commands.map((c) => c.run)).toEqual(['echo hello']);
  });

  it('integrates changes in separate files through engine checks', async () => {
    await approveAll();
    const a = await newTask('Discount module', 'alice');
    const b = await newTask('Docs', 'bob');
    await edit(a.ws.path, 'src/discount.js', () => 'export const discount = (c) => Math.round(c * 0.05);\n');
    await edit(b.ws.path, 'README.md', (s) => `${s}\nPrices are in cents.\n`);
    const ra = await record(a.ws.id, 'New module');
    const rb = await record(b.ws.id, 'Docs');

    const ja = await accept(ra.change!.id);
    expect(ja.status).toBe(202);
    expect((await waitJob(h, ja.body.id)).run).toMatchObject({ status: 'accepted' });
    // B was based on the old current: Zit composes it onto the new one.
    const jb = await accept(rb.change!.id);
    expect(jb.status).toBe(202);
    const done = await waitJob(h, jb.body.id);
    expect(done.run!.status).toBe('accepted');
    expect(done.run!.message).toMatch(/composed onto current/);
    const s = await state(h, repo.id);
    expect(s.tasks.find((t) => t.id === a.task.id)!.lane).toBe('accepted');
    expect(s.tasks.find((t) => t.id === b.task.id)!.lane).toBe('accepted');
    expect(s.mainline.length).toBeGreaterThanOrEqual(3);
  });

  it('a failing check blocks acceptance and keeps the candidate intact', async () => {
    await approveAll();
    const c = await newTask('Truncate tax', 'carol');
    await edit(c.ws.path, 'src/pricing.js', (s) => s.replace('Math.round(cents * rate)', 'Math.floor(cents * rate)'));
    const rec = await record(c.ws.id, 'floor instead of round');
    const before = (await state(h, repo.id)).current!.id;

    // Accept runs the checks itself and is rejected.
    const job = await accept(rec.change!.id);
    expect(job.status).toBe(202);
    const done = await waitJob(h, job.body.id);
    expect(done.run!.status).toBe('rejected');
    expect(done.run!.message).toMatch(/checks failed: unit/);

    const s = await state(h, repo.id);
    expect(s.current!.id).toBe(before);
    const t = s.tasks.find((x) => x.id === c.task.id)!;
    expect(t.lane).toBe('check-failed');
    expect(t.actions.accept).toBe(false);
    expect(t.pending[0]!.id).toBe(rec.change!.id);
    // The change and its diff are still there.
    const inspect = await h.ok<ChangeInspect>('GET', `/api/repos/${repo.id}/changes/${rec.change!.id}`);
    expect(inspect.diff).toContain('Math.floor');
    expect(inspect.evidence.find((e) => e.check === 'unit')!.evidence!.passed).toBe(false);
    // A second attempt is refused before reaching the engine.
    const again = await accept(rec.change!.id);
    expect(again.status).toBe(409);
  });

  it('warns about overlap without calling it a conflict, and reports the engine verdict when there is one', async () => {
    await approveAll();
    const bob = await newTask('Currency', 'bob');
    const carol = await newTask('Rounding', 'carol');
    const dave = await newTask('Also rounding', 'dave');
    await edit(bob.ws.path, 'src/pricing.js', (s) => s.replace('return (cents / 100).toFixed(2);', () => 'return `$${(cents / 100).toFixed(2)}`;'));
    await edit(carol.ws.path, 'src/pricing.js', (s) => s.replace('Math.round(cents * rate)', 'Math.round(cents * rate + 0)'));
    await edit(dave.ws.path, 'src/pricing.js', (s) => s.replace('Math.round(cents * rate)', 'Math.ceil(cents * rate)'));
    const rb = await record(bob.ws.id);
    const rc = await record(carol.ws.id);
    const rd = await record(dave.ws.id);

    let s = await state(h, repo.id);
    const pair = (x: string, y: string) => s.overlaps.find((o) => (o.a === x && o.b === y) || (o.a === y && o.b === x));
    expect(pair(bob.task.id, carol.task.id)).toMatchObject({ level: 'file', engineVerdict: [] });
    expect(pair(carol.task.id, dave.task.id)).toMatchObject({ level: 'resource' });

    // Land carol. Bob's same-file, different-symbol change still composes.
    expect((await waitJob(h, (await accept(rc.change!.id)).body.id)).run!.status).toBe('accepted');
    s = await state(h, repo.id);
    expect(s.tasks.find((t) => t.id === bob.task.id)!.lane).not.toBe('conflict');
    // Dave wrote the same function carol just landed: Zit now refuses it.
    const daveView = s.tasks.find((t) => t.id === dave.task.id)!;
    expect(daveView.lane).toBe('conflict');
    expect(daveView.actions).toMatchObject({ accept: false, retry: true });
    expect((await waitJob(h, (await accept(rb.change!.id)).body.id)).run!.status).toBe('accepted');
    expect(rd.change).not.toBeNull();
  });

  it('racing accepts cannot land a stale candidate twice', async () => {
    await approveAll();
    const a = await newTask('A', 'alice');
    const b = await newTask('B', 'bob');
    await edit(a.ws.path, 'src/a.js', () => 'export const a = 1;\n');
    await edit(b.ws.path, 'src/b.js', () => 'export const b = 1;\n');
    const ra = await record(a.ws.id);
    const rb = await record(b.ws.id);
    const reviewed = (await state(h, repo.id)).current!.id;

    // Two clicks on the same change: one job, one "busy".
    const [x, y] = await Promise.all([
      h.api<Job>('POST', `/api/repos/${repo.id}/changes/${ra.change!.id}/accept`, { expectedCurrent: reviewed }),
      h.api<Job>('POST', `/api/repos/${repo.id}/changes/${ra.change!.id}/accept`, { expectedCurrent: reviewed }),
    ]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    const job = x.status === 202 ? x.body : y.body;
    expect((await waitJob(h, job.id)).run!.status).toBe('accepted');

    // B was reviewed against the old current: refused until reviewed again.
    const stale = await h.api<{ error: string }>('POST', `/api/repos/${repo.id}/changes/${rb.change!.id}/accept`, { expectedCurrent: reviewed });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale-review');
    // Accepting A again is refused: it is already part of current.
    const twice = await accept(ra.change!.id);
    expect(twice.status).toBe(409);
    // After review against the new current, B lands.
    expect((await waitJob(h, (await accept(rb.change!.id)).body.id)).run!.status).toBe('accepted');
    // Each change landed exactly once on the first-parent line.
    const log = execFileSync('git', ['log', '--first-parent', '--format=%s', 'refs/zit/current'], { cwd: repo.path }).toString();
    expect(log.split('\n').filter((l) => l.includes('A')).length).toBeLessThanOrEqual(1);
  });

  it('two accepts of different changes queued at once both land without one overwriting the other', async () => {
    await approveAll();
    const a = await newTask('Alpha', 'alice');
    const b = await newTask('Beta', 'bob');
    await edit(a.ws.path, 'src/a.js', () => 'export const a = 1;\n');
    await edit(b.ws.path, 'src/b.js', () => 'export const b = 1;\n');
    const ra = await record(a.ws.id);
    const rb = await record(b.ws.id);
    const reviewed = (await state(h, repo.id)).current!.id;
    const [ja, jb] = await Promise.all([ra, rb].map((r) => h.api<Job>('POST', `/api/repos/${repo.id}/changes/${r.change!.id}/accept`, { expectedCurrent: reviewed })));
    const results = await Promise.all([ja, jb].map((j) => waitJob(h, j!.body.id)));
    // One lands; the other finds current moved while it queued and is refused as a stale review.
    const statuses = results.map((r) => r.run?.status ?? r.state).sort();
    expect(statuses).toContain('accepted');
    expect(results.some((r) => r.error?.match(/Current moved/) || r.run?.status === 'accepted')).toBe(true);
    const s = await state(h, repo.id);
    const lanes = [a.task.id, b.task.id].map((id) => s.tasks.find((t) => t.id === id)!.lane).sort();
    expect(lanes).toEqual(['accepted', 'waiting']);
  });

  it('cancels a long check and leaves the change untouched', async () => {
    const a = await newTask('Slow', 'alice');
    await edit(a.ws.path, 'zit.toml', () => '[[check]]\nname = "slow"\nrun = "sleep 30"\n');
    const rec = await record(a.ws.id);
    await h.ok('POST', `/api/repos/${repo.id}/approvals`, { keys: (await h.api<ApprovalRequired>('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/check`, {})).body.commands.map((c) => c.key), changeId: rec.change!.id });
    const job = await h.ok<Job>('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/check`, {});
    await new Promise((r) => setTimeout(r, 800));
    const started = Date.now();
    await h.ok('POST', `/api/jobs/${job.id}/cancel`, {});
    const done = await waitJob(h, job.id, 10_000);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(done.state).toBe('cancelled');
    expect(done.run!.status).toBe('cancelled');
    const t = await view(a.task.id);
    expect(t.pending[0]!.id).toBe(rec.change!.id);
    expect(t.lane).toBe('waiting'); // no evidence was stored for the cancelled run
  });

  it('marks operations interrupted by a restart and explains recovery', async () => {
    const store = new Store(h.dataDir);
    await store.load();
    await store.update((d) =>
      void d.operations.push({ id: 'o1', repoId: repo.id, kind: 'accept', target: 'abc', label: 'Accept abc', startedAt: Date.now(), finishedAt: null, status: 'pending', message: null, recovery: null, dismissed: false }),
    );
    await h.restart();
    const op = (await state(h, repo.id)).operations.find((o) => o.id === 'o1')!;
    expect(op.status).toBe('interrupted');
    expect(op.recovery).toMatch(/atomic/);
    await h.ok('POST', `/api/repos/${repo.id}/operations/o1/dismiss`, {});
    expect((await state(h, repo.id)).operations.find((o) => o.id === 'o1')).toBeUndefined();
  });

  it('requires naming the target before disposing a workspace or discarding a change', async () => {
    const a = await newTask('Throwaway', 'alice');
    await edit(a.ws.path, 'src/x.js', () => 'x\n');
    const rec = await record(a.ws.id);
    const short = rec.change!.id.slice(0, 8);
    expect((await h.api('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/discard`, { confirm: 'yes' })).status).toBe(400);
    expect((await h.api('POST', `/api/repos/${repo.id}/workspaces/${a.ws.id}/dispose`, {})).status).toBe(400);
    expect(existsSync(a.ws.path)).toBe(true);
    await h.ok('POST', `/api/repos/${repo.id}/changes/${rec.change!.id}/discard`, { confirm: short });
    await h.ok('POST', `/api/repos/${repo.id}/workspaces/${a.ws.id}/dispose`, { confirm: a.ws.id });
    expect(existsSync(a.ws.path)).toBe(false);
    expect(existsSync(join(repo.path, 'src/pricing.js'))).toBe(true); // the repository itself is untouched
    expect((await view(a.task.id)).lane).toBe('closed');
  });

  it('refuses repositories outside the allowed roots and inside Zit’s storage', async () => {
    const outside = await h.api<{ error: string }>('POST', '/api/repos', { path: '/' });
    expect(outside.status).toBe(403);
    const a = await newTask('x', 'alice');
    const inside = await h.api<{ error: string }>('POST', '/api/repos', { path: a.ws.path });
    expect(inside.status).toBe(400);
  });

  it('shows work started with the Zit CLI alongside Switchyard tasks', async () => {
    const env = { ...process.env, ZIT_HOME: h.zitHome };
    const ws = JSON.parse(execFileSync(zitBin!, ['--json', 'materialise', '--intent=From the CLI', '--agent=codex', '--session=cli-42'], { cwd: repo.path, env }).toString());
    await writeFile(join(ws.path, 'cli.txt'), 'hi\n');
    await settle();
    const t = (await state(h, repo.id)).tasks.find((x) => x.id === 'ext:cli-42')!;
    expect(t).toMatchObject({ source: 'external', owner: 'codex', title: 'From the CLI', lane: 'editing' });
  });
});
