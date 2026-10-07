// Switchyard's application layer: every user action goes through here. Engine
// state is read from Zit on each request and never cached in a way that could
// disagree with it; only immutable facts (what a recorded change wrote, that a
// change was accepted) are memoised.

import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type {
  ApprovalRequired,
  ChangeInspect,
  CheckRun,
  CheckRunVerdict,
  CommandInfo,
  EngineInfo,
  Job,
  Operation,
  Repo,
  RepoState,
  Task,
  WorkspaceDiff,
} from '../../shared/api';
import type { Detail, Oid, Overview, Verdict } from '../../shared/engine-types';
import { validateResourceInput } from '../../shared/resource';
import { computeOverlaps, deriveTasks, sessionFor, taskIdOfSession } from './board';
import { approvalKey, EMPTY_CONFIG, parseZitConfig, requiredCommands, unapproved, type DeclaredCommand, type Operation as CmdOp, type ZitConfig } from './commands';
import { probeCopyOnWrite } from './cow';
import * as git from './git';
import { KeyedMutex } from './mutex';
import { redact } from './redact';
import type { Store } from './store';
import { SUPPORTED, Zit, ZitError } from './zit';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const id = (prefix: string) => `${prefix}${randomBytes(5).toString('hex')}`;
const OID = /^[0-9a-f]{7,64}$/;
const WS_ID = /^[A-Za-z0-9]{1,64}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

const RECOVERY: Record<Operation['kind'], string> = {
  accept:
    'Zit moves current in one atomic ref update, so the change either landed or did not. Refresh: it shows as accepted or still waiting. If accept keeps failing with a lock error and no zit process is running, remove refs/zit/current.lock from the repository’s git directory.',
  check: 'No evidence is stored for an interrupted check run. Run the checks again.',
  record: 'The workspace and its edits are untouched. Record it again.',
  materialise: 'Zit removes half-made workspaces. If an unassigned workspace appears, open it from the board or dispose it.',
  retry: 'If a new workspace appeared for the task, continue in it; otherwise retry again.',
  claim: 'Claims are all-or-nothing. Refresh and claim again.',
  discard: 'Refresh: the change is either gone or still waiting. Discard again if it is still there.',
  dispose: 'Refresh: the workspace is either gone or still open. Dispose again if it is still there.',
  init: 'Run Initialise again; it is idempotent.',
};

function friendly(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof ZitError) {
    switch (e.kind) {
      case 'not-initialised':
        return new HttpError(409, 'not-initialised', 'Zit is not initialised in this repository yet. Use “Initialise Zit” to start tracking it.');
      case 'unknown-revision':
        return new HttpError(404, 'unknown-change', 'That change no longer exists in Zit (it may have been discarded). Refresh the board.');
      case 'unknown-workspace':
        return new HttpError(404, 'unknown-workspace', 'That workspace no longer exists (it may have been disposed). Refresh the board.');
      case 'timeout':
        return new HttpError(504, 'timeout', `${e.message}. Nothing was changed by Switchyard; refresh to see the engine’s state.`);
      case 'cancelled':
        return new HttpError(409, 'cancelled', 'The operation was cancelled.');
      default:
        return new HttpError(422, 'engine', `Zit refused: ${e.message}`);
    }
  }
  return new HttpError(500, 'internal', 'Something went wrong inside Switchyard. Details are in the server log.');
}

export interface ServiceOptions {
  store: Store;
  projectRoot: string;
  zitBin: string | null;
  zitHome: string;
  dataDir: string;
  allowedRoots: string[];
  env?: NodeJS.ProcessEnv;
}

interface LiveJob {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
}

export class Service {
  private readonly store: Store;
  private zit: Zit | null;
  private engine: EngineInfo | null = null;
  private readonly writesCache = new Map<string, string[]>();
  private readonly acceptedCache = new Set<string>();
  private readonly goneCache = new Set<string>();
  private readonly jobs = new Map<string, LiveJob>();
  private readonly acceptLock = new KeyedMutex();
  /** Changes with a check or accept being started or running; claimed synchronously. */
  private readonly reserved = new Set<string>();

  constructor(private readonly opts: ServiceOptions) {
    this.store = opts.store;
    this.zit = opts.zitBin ? new Zit(opts.zitBin, opts.env) : null;
  }

  /** Load data and mark operations that were running when the server stopped. */
  async start(): Promise<void> {
    await this.store.load();
    const stuck = this.store.snapshot.operations.filter((o) => o.status === 'pending');
    if (stuck.length) {
      await this.store.update((d) => {
        for (const o of d.operations) {
          if (o.status !== 'pending') continue;
          o.status = 'interrupted';
          o.finishedAt = Date.now();
          o.recovery = RECOVERY[o.kind];
        }
        for (const r of d.checkRuns) if (r.status === 'running') ((r.status = 'cancelled'), (r.message = 'Interrupted: Switchyard stopped while this ran.'));
      });
    }
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  async engineInfo(refresh = false): Promise<EngineInfo> {
    if (this.engine && !refresh) return this.engine;
    const gitVersion = await git.gitVersion();
    const copyOnWrite = await probeCopyOnWrite(this.opts.zitHome, this.opts.env);
    let version: string | null = null;
    let problem: string | null = null;
    if (!this.zit) {
      problem = 'Zit was not found. Run `npm run setup:zit` to build it into .tools/, or set ZIT_BIN to its path.';
    } else {
      try {
        version = await this.zit.version();
        if (!SUPPORTED.test(version)) problem = `Zit ${version} has not been verified with Switchyard (built against 0.1.x). Output may differ.`;
      } catch (e) {
        problem = e instanceof Error ? e.message : 'Zit could not be started.';
      }
    }
    if (!git.gitSupported(gitVersion)) problem = `Zit needs git 2.38 or newer; found ${gitVersion ?? 'none'}.`;
    this.engine = {
      found: this.zit !== null && version !== null,
      bin: this.zit?.bin ?? null,
      version,
      supported: version !== null && SUPPORTED.test(version) && git.gitSupported(gitVersion),
      gitVersion,
      zitHome: this.opts.zitHome,
      copyOnWrite,
      problem,
    };
    return this.engine;
  }

  private engineOrThrow(): Zit {
    if (!this.zit) throw new HttpError(503, 'engine-missing', 'Zit is not installed. Run `npm run setup:zit`, then restart Switchyard.');
    return this.zit;
  }

  // ── Repositories ──────────────────────────────────────────────────────────

  repos(): Repo[] {
    return [...this.store.snapshot.repos];
  }

  private repo(repoId: string): Repo {
    const r = this.store.snapshot.repos.find((x) => x.id === repoId);
    if (!r) throw new HttpError(404, 'unknown-repo', 'That repository is not registered. Pick one from the list or register it.');
    return r;
  }

  async register(path: string, demo = false): Promise<Repo> {
    if (typeof path !== 'string' || !path.trim()) throw new HttpError(400, 'invalid-path', 'Enter the absolute path of a local git repository.');
    const given = path.trim();
    if (!isAbsolute(given)) throw new HttpError(400, 'invalid-path', 'Use an absolute path, for example /home/you/projects/shop.');
    let real: string;
    try {
      real = await realpath(given);
      if (!(await stat(real)).isDirectory()) throw new Error();
    } catch {
      throw new HttpError(400, 'invalid-path', `No directory exists at ${given}.`);
    }
    const inside = (root: string) => {
      const rel = relative(root, real);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    if (inside(resolve(this.opts.zitHome))) throw new HttpError(400, 'invalid-path', 'That path is inside Zit’s own storage (a workspace or cache). Register the original repository instead.');
    if (inside(resolve(this.opts.dataDir))) throw new HttpError(400, 'invalid-path', 'That path is inside Switchyard’s data directory.');
    if (this.opts.allowedRoots.length && !this.opts.allowedRoots.some((root) => inside(resolve(root)))) {
      throw new HttpError(403, 'path-not-allowed', `Only repositories under ${this.opts.allowedRoots.join(', ')} may be registered (SWITCHYARD_ALLOWED_ROOTS).`);
    }
    const info = await git.repoInfo(real);
    if (!info) throw new HttpError(400, 'not-a-repo', `${real} is not inside a git repository with a working tree.`);
    const top = await realpath(info.toplevel);
    const existing = this.store.snapshot.repos.find((r) => r.path === top);
    if (existing) return existing;
    const repo: Repo = { id: id('r'), name: basename(top), path: top, addedAt: Date.now(), demo };
    await this.store.update((d) => void d.repos.push(repo));
    return repo;
  }

  /** Forget a repository. Its files, workspaces and changes are untouched. */
  async unregister(repoId: string): Promise<void> {
    this.repo(repoId);
    await this.store.update((d) => {
      d.repos = d.repos.filter((r) => r.id !== repoId);
      d.tasks = d.tasks.filter((t) => t.repoId !== repoId);
      d.approvals = d.approvals.filter((a) => a.repoId !== repoId);
    });
  }

  async initRepo(repoId: string): Promise<void> {
    const repo = this.repo(repoId);
    await this.journal(repo, 'init', repo.path, 'Initialise Zit', async () => {
      await this.engineOrThrow().init(repo.path);
    });
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  private async journal<T>(repo: Repo, kind: Operation['kind'], target: string, label: string, fn: () => Promise<T>, describe?: (r: T) => string): Promise<T> {
    const op: Operation = {
      id: id('o'),
      repoId: repo.id,
      kind,
      target,
      label,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'pending',
      message: null,
      recovery: null,
      dismissed: false,
    };
    await this.store.update((d) => void d.operations.push(op));
    const finish = (status: Operation['status'], message: string | null) =>
      this.store.update((d) => {
        const o = d.operations.find((x) => x.id === op.id);
        if (o) Object.assign(o, { status, message, finishedAt: Date.now(), dismissed: status === 'done' });
      });
    try {
      const result = await fn();
      await finish('done', describe ? describe(result) : null);
      return result;
    } catch (e) {
      const err = friendly(e);
      await finish(err.code === 'cancelled' ? 'cancelled' : 'failed', err.message);
      throw err;
    }
  }

  async dismissOperation(repoId: string, opId: string): Promise<void> {
    await this.store.update((d) => {
      const o = d.operations.find((x) => x.id === opId && x.repoId === repoId);
      if (!o) throw new HttpError(404, 'unknown-operation', 'That journal entry no longer exists.');
      if (o.status === 'pending') throw new HttpError(409, 'still-running', 'That operation is still running.');
      o.dismissed = true;
    });
  }

  // ── Commands and approvals ────────────────────────────────────────────────

  private async config(repo: Repo, rev: string): Promise<ZitConfig> {
    return parseZitConfig(await git.fileAt(repo.path, rev, 'zit.toml'));
  }

  private approvedKeys(repoId: string): Set<string> {
    return new Set(this.store.snapshot.approvals.filter((a) => a.repoId === repoId).map((a) => a.key));
  }

  private info(repoId: string, commands: DeclaredCommand[]): CommandInfo[] {
    const approved = this.approvedKeys(repoId);
    return commands.map((c) => ({ ...c, key: approvalKey(c), approved: approved.has(approvalKey(c)) }));
  }

  /** Commands an operation would run, from the states' zit.toml. */
  private async commandsFor(repo: Repo, op: CmdOp, change?: Oid): Promise<DeclaredCommand[]> {
    let current: ZitConfig = EMPTY_CONFIG;
    let own: ZitConfig = EMPTY_CONFIG;
    try {
      if (op !== 'check') current = await this.config(repo, 'refs/zit/current');
      if (change) own = await this.config(repo, change);
    } catch (e) {
      throw new HttpError(422, 'config-invalid', `zit.toml cannot be read, so Switchyard cannot show what would run: ${(e as Error).message}`);
    }
    return requiredCommands(op, current, own);
  }

  /** Refuse to start until every command the operation may run was approved. */
  private async requireApproval(repo: Repo, op: CmdOp, change?: Oid): Promise<string[]> {
    const commands = await this.commandsFor(repo, op, change);
    const missing = unapproved(commands, this.approvedKeys(repo.id));
    if (missing.length) {
      const body: ApprovalRequired = {
        error: 'approval-required',
        message: 'Review the exact commands this will run on your machine, then approve them.',
        commands: this.info(repo.id, missing),
      };
      throw new HttpError(428, 'approval-required', body.message, { commands: body.commands });
    }
    return commands.map((c) => `${c.kind} ${c.name}: ${c.run}`);
  }

  /**
   * Approve commands by key. Only commands currently declared by the named
   * states can be approved, so a request cannot smuggle in arbitrary text.
   */
  async approve(repoId: string, keys: unknown, changeId?: unknown): Promise<CommandInfo[]> {
    const repo = this.repo(repoId);
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 50 || keys.some((k) => typeof k !== 'string')) {
      throw new HttpError(400, 'invalid-approval', 'Choose the commands to approve.');
    }
    if (changeId !== undefined && (typeof changeId !== 'string' || !OID.test(changeId))) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    const declared = [
      ...(await this.commandsFor(repo, 'accept', changeId as string | undefined)),
      ...(changeId ? await this.commandsFor(repo, 'check', changeId as string) : []),
    ];
    const byKey = new Map(declared.map((c) => [approvalKey(c), c]));
    const unknown = (keys as string[]).filter((k) => !byKey.has(k));
    if (unknown.length) throw new HttpError(409, 'commands-changed', 'The declared commands changed since you reviewed them. Review them again.');
    const already = this.approvedKeys(repoId);
    await this.store.update((d) => {
      for (const key of keys as string[]) {
        if (already.has(key)) continue;
        const c = byKey.get(key)!;
        d.approvals.push({ repoId, key, kind: c.kind, name: c.name, run: c.run, approvedAt: Date.now() });
      }
    });
    return this.info(repoId, (keys as string[]).map((k) => byKey.get(k)!));
  }

  async revokeApproval(repoId: string, key: string): Promise<void> {
    this.repo(repoId);
    await this.store.update((d) => void (d.approvals = d.approvals.filter((a) => !(a.repoId === repoId && a.key === key))));
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private async writesOf(repo: Repo, change: Oid): Promise<string[]> {
    const key = `${repo.path}\0${change}`;
    const hit = this.writesCache.get(key);
    if (hit) return hit;
    const detail = await this.engineOrThrow().show(repo.path, change);
    this.writesCache.set(key, detail.writes);
    return detail.writes;
  }

  /** Which of a task's recorded changes are accepted (final once true). */
  private async acceptedAmong(repo: Repo, ids: Oid[], pending: Set<Oid>): Promise<Set<Oid>> {
    const out = new Set<Oid>();
    await Promise.all(
      ids.map(async (cid) => {
        const key = `${repo.path}\0${cid}`;
        if (this.acceptedCache.has(key)) return void out.add(cid);
        if (pending.has(cid) || this.goneCache.has(key)) return;
        try {
          const d = await this.engineOrThrow().show(repo.path, cid);
          if (d.status === 'accepted' || d.status === 'current') {
            this.acceptedCache.add(key);
            out.add(cid);
          }
        } catch (e) {
          if (e instanceof ZitError && e.kind === 'unknown-revision') this.goneCache.add(key);
        }
      }),
    );
    return out;
  }

  async state(repoId: string): Promise<RepoState> {
    const repo = this.repo(repoId);
    const zit = this.engineOrThrow();
    const operations = this.store.snapshot.operations.filter((o) => o.repoId === repoId && !o.dismissed).slice(-20);
    const base = { repo, operations, fetchedAt: Date.now() };
    const current = await git.zitCurrent(repo.path);
    if (!current) {
      return { ...base, initialised: false, overview: null, current: null, mainline: [], tasks: [], overlaps: [], commands: { current: [], configError: null }, lockWarning: null };
    }
    let overview: Overview;
    try {
      overview = await zit.status(repo.path);
    } catch (e) {
      throw friendly(e);
    }

    // Learn change ids recorded under a task's session (also by `zit` outside Switchyard).
    const tasks = this.store.snapshot.tasks.filter((t) => t.repoId === repoId);
    const learned = new Map<string, Oid[]>();
    for (const c of overview.changes) {
      const tid = taskIdOfSession(c.session);
      const task = tid ? tasks.find((t) => t.id === tid) : undefined;
      if (task && !task.changeIds.includes(c.id)) learned.set(task.id, [...(learned.get(task.id) ?? []), c.id]);
    }
    if (learned.size) {
      await this.store.update((d) => {
        for (const t of d.tasks) if (learned.has(t.id)) t.changeIds.push(...learned.get(t.id)!);
      });
    }

    const pendingIds = new Set(overview.changes.map((c) => c.id));
    const pendingRows = overview.changes.filter((c) => c.status !== 'accepted' && c.status !== 'current');
    const [accepted, writePairs, mainline, lock, config] = await Promise.all([
      this.acceptedAmong(repo, [...new Set(this.store.snapshot.tasks.filter((t) => t.repoId === repoId).flatMap((t) => t.changeIds))], pendingIds),
      Promise.all(pendingRows.map(async (c) => [c.id, await this.writesOf(repo, c.id).catch(() => [])] as const)),
      git.mainline(repo.path),
      git.currentLock(repo.path),
      this.commandsFor(repo, 'accept')
        .then((cmds) => ({ cmds, error: null as string | null }))
        .catch((e: HttpError) => ({ cmds: [] as DeclaredCommand[], error: e.message })),
    ]);
    const views = deriveTasks({
      overview,
      tasks: this.store.snapshot.tasks.filter((t) => t.repoId === repoId),
      accepted,
      changeWrites: new Map(writePairs),
    });
    return {
      ...base,
      initialised: true,
      overview,
      current: { id: overview.current.id, intent: overview.current.intent, agent: overview.current.agent, time: overview.current.time },
      mainline,
      tasks: views,
      overlaps: computeOverlaps(views),
      commands: { current: this.info(repoId, config.cmds), configError: config.error },
      lockWarning: lock
        ? `A ref lock (${lock}) is present. If no zit process is running, an earlier operation was interrupted: remove the lock file so accept can move current again.`
        : null,
    };
  }

  async inspectChange(repoId: string, changeId: string): Promise<ChangeInspect> {
    const repo = this.repo(repoId);
    if (!OID.test(changeId)) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    let detail: Detail;
    try {
      detail = await this.engineOrThrow().show(repo.path, changeId);
    } catch (e) {
      throw friendly(e);
    }
    const { diff, truncated } = await git.changeDiff(repo.path, detail.parents[0] ?? null, detail.id);
    let checkCommands: CommandInfo[] = [];
    let acceptCommands: CommandInfo[] = [];
    let configError: string | null = null;
    try {
      checkCommands = this.info(repoId, await this.commandsFor(repo, 'check', detail.id));
      acceptCommands = this.info(repoId, await this.commandsFor(repo, 'accept', detail.id));
    } catch (e) {
      configError = (e as Error).message;
    }
    return {
      detail: { ...detail, evidence: [] },
      diff,
      diffTruncated: truncated,
      checkCommands,
      acceptCommands,
      configError,
      evidence: detail.evidence.map((r) => {
        if (!r.evidence) return { check: r.check, evidence: null };
        const b = redact(r.evidence.output);
        return { check: r.check, evidence: { ...r.evidence, output: b.text, outputTruncated: b.truncated, outputRedacted: b.redacted } };
      }),
    };
  }

  private async workspaceRow(repo: Repo, wsId: string) {
    if (!WS_ID.test(wsId)) throw new HttpError(400, 'invalid-workspace', 'Unknown workspace id.');
    const overview = await this.engineOrThrow().status(repo.path).catch((e) => Promise.reject(friendly(e)));
    const ws = overview.workspaces.find((w) => w.id === wsId);
    if (!ws) throw new HttpError(404, 'unknown-workspace', 'That workspace no longer exists (it may have been disposed). Refresh the board.');
    return ws;
  }

  async workspaceDiff(repoId: string, wsId: string): Promise<WorkspaceDiff> {
    const repo = this.repo(repoId);
    const ws = await this.workspaceRow(repo, wsId);
    const d = await git.workspaceDiff(ws.path);
    return { workspaceId: ws.id, ...d };
  }

  // ── Tasks and workspaces ──────────────────────────────────────────────────

  async createTask(repoId: string, body: { title?: unknown; owner?: unknown; notes?: unknown }): Promise<Task> {
    const repo = this.repo(repoId);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (!title || title.length > 200 || /[\r\n\0]/.test(title)) throw new HttpError(400, 'invalid-title', 'Give the task a one-line title (up to 200 characters).');
    if (!OWNER.test(owner)) throw new HttpError(400, 'invalid-owner', 'Owner must start with a letter or digit and use letters, digits, spaces, “.”, “_” or “-” (up to 40).');
    if (notes.length > 4000) throw new HttpError(400, 'invalid-notes', 'Notes can be up to 4,000 characters.');
    await this.requireApproval(repo, 'materialise');
    const task: Task = { id: id('t'), repoId, title, owner, notes, createdAt: Date.now(), changeIds: [] };
    await this.journal(repo, 'materialise', task.id, `Open workspace for “${title}”`, () =>
      this.engineOrThrow().materialise(repo.path, { intent: title, agent: owner, session: sessionFor(task.id) }),
      (ws) => `Workspace ${ws.id} at ${ws.path}`,
    );
    await this.store.update((d) => void d.tasks.push(task));
    return task;
  }

  async updateTask(repoId: string, taskId: string, body: { title?: unknown; owner?: unknown; notes?: unknown }): Promise<Task> {
    this.repo(repoId);
    return this.store.update((d) => {
      const t = d.tasks.find((x) => x.id === taskId && x.repoId === repoId);
      if (!t) throw new HttpError(404, 'unknown-task', 'That task no longer exists.');
      if (body.notes !== undefined) {
        if (typeof body.notes !== 'string' || body.notes.length > 4000) throw new HttpError(400, 'invalid-notes', 'Notes can be up to 4,000 characters.');
        t.notes = body.notes;
      }
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || /[\r\n\0]/.test(body.title))
          throw new HttpError(400, 'invalid-title', 'Give the task a one-line title (up to 200 characters).');
        t.title = body.title.trim();
      }
      if (body.owner !== undefined) {
        if (typeof body.owner !== 'string' || !OWNER.test(body.owner.trim())) throw new HttpError(400, 'invalid-owner', 'Owner must start with a letter or digit (up to 40 characters).');
        t.owner = body.owner.trim();
      }
      return { ...t };
    });
  }

  async claim(repoId: string, wsId: string, resources: unknown) {
    const repo = this.repo(repoId);
    if (!Array.isArray(resources) || resources.length === 0 || resources.length > 50) throw new HttpError(400, 'invalid-resources', 'List one to fifty resources to claim.');
    const list = resources.map((r) => (typeof r === 'string' ? r.trim() : ''));
    for (const r of list) {
      const problem = validateResourceInput(r);
      if (problem) throw new HttpError(400, 'invalid-resource', `${r || '(empty)'}: ${problem}`);
    }
    const ws = await this.workspaceRow(repo, wsId);
    return this.journal(repo, 'claim', ws.id, `Claim ${list.join(', ')}`, () => this.engineOrThrow().claim(repo.path, ws.id, list), (c) =>
      c.claim === 'granted' ? 'Granted' : `Refused: ${c.held.length} resource(s) already held`,
    );
  }

  async record(repoId: string, wsId: string, summary: unknown) {
    const repo = this.repo(repoId);
    const text = typeof summary === 'string' ? summary.trim() : '';
    if (text.length > 8000) throw new HttpError(400, 'invalid-summary', 'The summary can be up to 8,000 characters.');
    const ws = await this.workspaceRow(repo, wsId);
    const recorded = await this.journal(repo, 'record', ws.id, `Record workspace ${ws.id}`, () => this.engineOrThrow().record(repo.path, ws.id, text), (r) =>
      r.change ? `Change ${r.change.id.slice(0, 8)} wrote ${r.writes.length} resource(s)` : 'Nothing to record',
    );
    const tid = taskIdOfSession(ws.session);
    if (recorded.change && tid) {
      const cid = recorded.change.id;
      await this.store.update((d) => {
        const t = d.tasks.find((x) => x.id === tid);
        if (t && !t.changeIds.includes(cid)) t.changeIds.push(cid);
      });
    }
    return recorded;
  }

  async dispose(repoId: string, wsId: string, confirm: unknown) {
    const repo = this.repo(repoId);
    const ws = await this.workspaceRow(repo, wsId);
    if (confirm !== ws.id) throw new HttpError(400, 'confirmation-required', `Type the workspace id (${ws.id}) to confirm. Unrecorded edits in it will be deleted.`);
    return this.journal(repo, 'dispose', ws.id, `Dispose workspace ${ws.id}`, () => this.engineOrThrow().dispose(repo.path, ws.id), () =>
      ws.dirty ? 'Disposed (it held unrecorded edits)' : 'Disposed',
    );
  }

  async discard(repoId: string, changeId: string, confirm: unknown) {
    const repo = this.repo(repoId);
    if (!OID.test(changeId)) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    const short = changeId.slice(0, 8);
    if (confirm !== short) throw new HttpError(400, 'confirmation-required', `Type the change id (${short}) to confirm discarding it.`);
    if (this.isBusy(changeId)) throw new HttpError(409, 'busy', 'A check or accept is running on this change. Wait for it or cancel it first.');
    return this.journal(repo, 'discard', changeId, `Discard change ${short}`, () => this.engineOrThrow().discard(repo.path, changeId));
  }

  async retry(repoId: string, changeId: string) {
    const repo = this.repo(repoId);
    if (!OID.test(changeId)) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    await this.requireApproval(repo, 'retry');
    return this.journal(repo, 'retry', changeId, `Retry ${changeId.slice(0, 8)} on current`, () => this.engineOrThrow().retry(repo.path, changeId), (ws) =>
      `New workspace ${ws.id} holds the change on current`,
    );
  }

  // ── Checks and acceptance (jobs) ──────────────────────────────────────────

  private isBusy(changeId: string): boolean {
    return [...this.jobs.values()].some((j) => j.job.changeId === changeId && j.job.state === 'running');
  }

  job(jobId: string): Job {
    const j = this.jobs.get(jobId);
    if (!j) throw new HttpError(404, 'unknown-job', 'That job is not known (jobs are kept until Switchyard restarts).');
    return j.job;
  }

  activeJobs(repoId: string): Job[] {
    return [...this.jobs.values()].map((j) => j.job).filter((j) => j.repoId === repoId && j.state === 'running');
  }

  cancelJob(jobId: string): Job {
    const j = this.jobs.get(jobId);
    if (!j) throw new HttpError(404, 'unknown-job', 'That job is not known.');
    if (j.job.state === 'running') j.controller.abort();
    return j.job;
  }

  checkHistory(repoId: string): CheckRun[] {
    return this.store.snapshot.checkRuns.filter((r) => r.repoId === repoId).slice(-100).reverse();
  }

  private verdicts(vs: Verdict[]): CheckRunVerdict[] {
    return vs.map((v) => {
      const b = redact(v.evidence.output);
      return {
        check: v.evidence.check,
        passed: v.evidence.passed,
        exitCode: v.evidence.exit_code,
        durationMs: v.evidence.duration_ms,
        cached: v.cached,
        output: b.text,
        outputTruncated: b.truncated,
        outputRedacted: b.redacted,
      };
    });
  }

  private async taskOfChange(repo: Repo, changeId: Oid): Promise<string | null> {
    const d = await this.engineOrThrow().show(repo.path, changeId).catch(() => null);
    return taskIdOfSession(d?.session ?? null);
  }

  private launch(repo: Repo, kind: Job['kind'], changeId: Oid, commands: string[], work: (signal: AbortSignal, run: CheckRun) => Promise<void>): Job {
    const controller = new AbortController();
    const run: CheckRun = { id: id('c'), repoId: repo.id, changeId, taskId: null, kind, startedAt: Date.now(), finishedAt: null, status: 'running', verdicts: [], message: null };
    const job: Job = { id: id('j'), repoId: repo.id, kind, changeId, startedAt: Date.now(), finishedAt: null, state: 'running', commands, run, error: null };
    const live: LiveJob = { job, controller, done: Promise.resolve() };
    this.jobs.set(job.id, live);
    const persist = (fn: Parameters<Store['update']>[0]) =>
      this.store.update(fn).catch((e) => console.error(`[switchyard] could not save check history: ${(e as Error).message}`));
    live.done = (async () => {
      run.taskId = await this.taskOfChange(repo, changeId);
      await persist((d) => void d.checkRuns.push({ ...run }));
      try {
        await work(controller.signal, run);
        job.state = 'finished';
      } catch (e) {
        const err = friendly(e);
        job.state = err.code === 'cancelled' ? 'cancelled' : 'failed';
        job.error = err.message;
        run.status = err.code === 'cancelled' ? 'cancelled' : 'error';
        run.message = err.code === 'cancelled' ? 'Cancelled. The change and current are unchanged.' : err.message;
      } finally {
        run.finishedAt = job.finishedAt = Date.now();
        this.reserved.delete(changeId);
        await persist((d) => {
          const i = d.checkRuns.findIndex((r) => r.id === run.id);
          if (i >= 0) d.checkRuns[i] = { ...run };
        });
        // Keep finished jobs for a while so a reload can still show their result.
        setTimeout(() => this.jobs.delete(job.id), 30 * 60_000).unref();
      }
    })();
    return job;
  }

  /** Wait for running jobs to finish (used on shutdown and by tests). */
  async drain(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  /**
   * Claim a change for one check or accept, synchronously, before any await:
   * two clicks that arrive together cannot both start a job.
   */
  private reserve(changeId: string): () => void {
    const running = [...this.jobs.values()].find((j) => j.job.changeId === changeId && j.job.state === 'running');
    if (running || this.reserved.has(changeId)) {
      throw new HttpError(409, 'busy', `A ${running?.job.kind ?? 'check or accept'} is already running on this change.`, running ? { jobId: running.job.id } : {});
    }
    this.reserved.add(changeId);
    return () => this.reserved.delete(changeId);
  }

  async startCheck(repoId: string, changeId: string, rerun: unknown): Promise<Job> {
    const repo = this.repo(repoId);
    if (!OID.test(changeId)) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    const release = this.reserve(changeId);
    let detail: Detail;
    let commands: string[];
    try {
      detail = await this.engineOrThrow().show(repo.path, changeId).catch((e) => Promise.reject(friendly(e)));
      if (detail.id !== changeId) throw new HttpError(400, 'invalid-change', 'Use the full change id.');
      commands = await this.requireApproval(repo, 'check', detail.id);
    } catch (e) {
      release();
      throw e;
    }
    return this.launch(repo, 'check', detail.id, commands, async (signal, run) => {
      await this.journal(repo, 'check', detail.id, `Run checks on ${detail.id.slice(0, 8)}`, async () => {
        const verdicts = await this.engineOrThrow().check(repo.path, detail.id, rerun === true, signal);
        run.verdicts = this.verdicts(verdicts);
        const failed = verdicts.filter((v) => !v.evidence.passed).map((v) => v.evidence.check);
        run.status = failed.length ? 'failed' : 'passed';
        run.message = verdicts.length === 0 ? 'No checks are declared in this change’s zit.toml.' : failed.length ? `Failed: ${failed.join(', ')}` : 'All checks passed.';
        return run.message;
      }, (m) => m);
    });
  }

  /**
   * Accept a change through Zit. `expectedCurrent` is the current state the
   * person reviewed against: if current has moved since, the review is stale
   * and the request is refused, so one click can never land a candidate the
   * person did not see. Accepts in one repository run one at a time; Zit's own
   * atomic ref update is the final guard against a double landing.
   */
  async startAccept(repoId: string, changeId: string, expectedCurrent: unknown): Promise<Job> {
    const repo = this.repo(repoId);
    if (!OID.test(changeId)) throw new HttpError(400, 'invalid-change', 'Unknown change id.');
    if (typeof expectedCurrent !== 'string' || !OID.test(expectedCurrent)) {
      throw new HttpError(400, 'expected-current-required', 'Refresh the board before accepting: the request did not say which current state was reviewed.');
    }
    const release = this.reserve(changeId);

    const gate = async () => {
      const current = await git.zitCurrent(repo.path);
      if (current !== expectedCurrent) {
        throw new HttpError(409, 'stale-review', 'Current moved since you reviewed this change. The board was refreshed; review it against the new current, then accept again.', { current });
      }
      const detail = await this.engineOrThrow().show(repo.path, changeId).catch((e) => Promise.reject(friendly(e)));
      if (detail.status === 'accepted' || detail.status === 'current') throw new HttpError(409, 'already-accepted', 'This change is already part of current.');
      if (detail.status === 'invalid') throw new HttpError(409, 'not-eligible', `Zit reports this change as ${detail.reason}; it cannot be accepted as it is.`);
      return detail;
    };
    let detail: Detail;
    let commands: string[];
    try {
      detail = await gate();
      if (detail.id !== changeId) throw new HttpError(400, 'invalid-change', 'Use the full change id.');
      commands = await this.requireApproval(repo, 'accept', detail.id);
    } catch (e) {
      release();
      throw e;
    }
    const job = this.launch(repo, 'accept', detail.id, commands, (signal, run) =>
      this.acceptLock.run(repo.id, async () => {
        // Re-check under the lock: another accept may have landed while this one queued.
        await gate();
        await this.requireApproval(repo, 'accept', detail.id);
        await this.journal(repo, 'accept', detail.id, `Accept ${detail.id.slice(0, 8)} “${detail.intent}”`, async () => {
          const outcome = await this.engineOrThrow().accept(repo.path, detail.id, signal);
          if (outcome.outcome === 'accepted') {
            run.verdicts = this.verdicts(outcome.verdicts);
            run.status = 'accepted';
            run.message = `Accepted: current is now ${outcome.current.slice(0, 8)} (${outcome.composed ? 'composed onto current' : 'fast-forward'}).`;
            this.acceptedCache.add(`${repo.path}\0${detail.id}`);
          } else if (outcome.outcome === 'already-accepted') {
            run.status = 'accepted';
            run.message = 'Already accepted; nothing changed.';
          } else {
            run.status = 'rejected';
            const why =
              outcome.reason === 'failed'
                ? `checks failed: ${outcome.detail.join(', ')}`
                : outcome.reason === 'conflict'
                  ? `text conflict in ${outcome.detail.join(', ')}`
                  : outcome.reason === 'stale'
                    ? `stale against current (${outcome.detail.map((s) => s.resource).join(', ')})`
                    : outcome.detail;
            run.message = `Rejected by Zit: ${why}. The change is kept intact.`;
          }
          return run.message;
        }, (m) => m);
      }),
    );
    return job;
  }
}
