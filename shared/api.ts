// Contracts between the Switchyard adapter and its web UI.

import type { ChangeRow, Detail, Evidence, Oid, Overview, ResourceText, WorkspaceRow } from './engine-types';

export const SESSION_PREFIX = 'switchyard:';

/** What the board shows a task as. Each is a separate, plain-language state. */
export type Lane = 'editing' | 'waiting' | 'check-failed' | 'conflict' | 'accepted' | 'error' | 'closed';

export const LANES: Array<{ id: Lane; label: string; hint: string }> = [
  { id: 'editing', label: 'Editing', hint: 'A workspace is open; edits are not recorded yet.' },
  { id: 'waiting', label: 'Waiting', hint: 'Recorded and waiting for checks or acceptance.' },
  { id: 'check-failed', label: 'Check failed', hint: 'A declared check failed on the change. It is kept intact.' },
  { id: 'conflict', label: 'Conflict', hint: 'Zit refused to compose it with current: stale or text conflict.' },
  { id: 'accepted', label: 'Accepted', hint: 'Part of the current state.' },
];

/** Annotation kept by Switchyard. Everything else about a task comes from Zit. */
export interface Task {
  id: string;
  repoId: string;
  title: string;
  owner: string;
  notes: string;
  createdAt: number;
  /** Changes this task recorded, as Zit reported them (used to find accepted ones). */
  changeIds: Oid[];
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  demo: boolean;
}

export type TaskSource = 'switchyard' | 'external';

export interface TaskActions {
  record: boolean;
  claim: boolean;
  check: boolean;
  accept: boolean;
  retry: boolean;
  discard: boolean;
  dispose: boolean;
}

export interface TaskView {
  /** Task id, or `ext:<key>` for engine work started outside Switchyard (e.g. `git zit run`). */
  id: string;
  source: TaskSource;
  title: string;
  owner: string;
  notes: string;
  createdAt: number;
  lane: Lane;
  /** One sentence on why it is in this lane. */
  why: string;
  workspaces: WorkspaceRow[];
  /** Unaccepted changes, newest first. */
  pending: ChangeRow[];
  /** Accepted change ids. */
  accepted: Oid[];
  /** The change actions apply to: the newest pending one. */
  primaryChange: ChangeRow | null;
  primaryWorkspace: WorkspaceRow | null;
  /** Everything it writes or holds: live writes, claims, pending changes' writes. */
  footprint: { writes: ResourceText[]; claims: ResourceText[] };
  actions: TaskActions;
}

export type OverlapLevel = 'resource' | 'file';

export interface OverlapPair {
  a: string;
  b: string;
  /** `resource`: both touch the same symbol or whole file. `file`: same file, different symbols. */
  level: OverlapLevel;
  shared: Array<{ a: ResourceText; b: ResourceText; level: OverlapLevel }>;
  /** Whether Zit itself has refused either side (stale/conflict) — a fact, unlike the overlap. */
  engineVerdict: Array<{ task: string; reason: 'stale' | 'conflict'; detail: string[] }>;
}

export interface MainlineEntry {
  id: Oid;
  subject: string;
  agent: string;
  time: number;
  /** Composed by Zit onto a moved current (a merge or linear compose). */
  composed: boolean;
}

export interface EngineInfo {
  found: boolean;
  bin: string | null;
  version: string | null;
  supported: boolean;
  gitVersion: string | null;
  zitHome: string;
  copyOnWrite: { supported: boolean; detail: string };
  problem: string | null;
}

export interface Operation {
  id: string;
  repoId: string;
  kind: 'materialise' | 'claim' | 'record' | 'check' | 'accept' | 'retry' | 'discard' | 'dispose' | 'init';
  target: string;
  label: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'pending' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  message: string | null;
  /** Shown for interrupted operations. */
  recovery: string | null;
  dismissed: boolean;
}

export interface ApprovedCommand {
  repoId: string;
  key: string;
  kind: 'check' | 'prepare' | 'derive';
  name: string;
  run: string;
  approvedAt: number;
}

export interface CheckRunVerdict {
  check: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  cached: boolean;
  output: string;
  outputTruncated: boolean;
  outputRedacted: boolean;
}

export interface CheckRun {
  id: string;
  repoId: string;
  changeId: Oid;
  taskId: string | null;
  kind: 'check' | 'accept';
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'passed' | 'failed' | 'rejected' | 'accepted' | 'cancelled' | 'error';
  verdicts: CheckRunVerdict[];
  message: string | null;
}

export interface RepoState {
  repo: Repo;
  initialised: boolean;
  /** Present when initialised. */
  overview: Overview | null;
  current: { id: Oid; intent: string; agent: string; time: number } | null;
  mainline: MainlineEntry[];
  tasks: TaskView[];
  overlaps: OverlapPair[];
  commands: { current: CommandInfo[]; configError: string | null };
  operations: Operation[];
  lockWarning: string | null;
  fetchedAt: number;
}

export interface CommandInfo {
  key: string;
  kind: 'check' | 'prepare' | 'derive';
  name: string;
  run: string;
  source: 'current' | 'change';
  approved: boolean;
}

export interface ChangeInspect {
  detail: Detail;
  diff: string;
  diffTruncated: boolean;
  /** Commands `zit check` would run (the change's own zit.toml). */
  checkCommands: CommandInfo[];
  /** Commands `zit accept` may run (current's and the change's). */
  acceptCommands: CommandInfo[];
  configError: string | null;
  evidence: Array<{ check: string; evidence: (Omit<Evidence, 'output'> & { output: string; outputTruncated: boolean; outputRedacted: boolean }) | null }>;
}

export interface WorkspaceDiff {
  workspaceId: string;
  diff: string;
  untracked: string[];
  truncated: boolean;
}

export interface Job {
  id: string;
  repoId: string;
  kind: 'check' | 'accept';
  changeId: Oid;
  startedAt: number;
  finishedAt: number | null;
  state: 'running' | 'finished' | 'cancelled' | 'failed';
  /** Commands it may run, shown while it runs. */
  commands: string[];
  run: CheckRun | null;
  error: string | null;
}

/** 428 body: the operation needs these exact commands approved first. */
export interface ApprovalRequired {
  error: 'approval-required';
  message: string;
  commands: CommandInfo[];
}

export interface ApiError {
  error: string;
  message: string;
  [k: string]: unknown;
}
