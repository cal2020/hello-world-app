// Shapes of `zit --json` output, as produced by Zit 0.1.1 (src/api.rs,
// src/accept.rs, src/claim.rs, src/evidence.rs, src/workspace.rs). Verified
// against real CLI output; see docs/ARCHITECTURE.md. The engine is the
// authority for every field here — Switchyard never stores these.

export type Oid = string;

/** `path`, `path#Symbol` or `path#` (module-level code), in Zit's text form. */
export type ResourceText = string;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export interface Change {
  id: Oid;
  state: Oid;
  parents: Oid[];
  intent: string;
  summary: string | null;
  agent: string;
  session: string | null;
  reads: ResourceText[];
  /** Unix seconds. */
  time: number;
  usage: Usage | null;
}

export type ConflictKind = 'write-write' | 'read-write' | 'write-read';

export interface Staleness {
  resource: ResourceText;
  kind: ConflictKind;
  by: Oid | null;
}

/** `Invalid` in src/accept.rs, adjacently tagged as reason/detail. */
export type Invalid =
  | { reason: 'stale'; detail: Staleness[] }
  | { reason: 'conflict'; detail: string[] }
  | { reason: 'failed'; detail: string[] }
  | { reason: 'error'; detail: string };

/** `Status` in src/accept.rs, flattened into change rows. */
export type ChangeStatus =
  | { status: 'speculative' }
  | { status: 'verified' }
  | ({ status: 'invalid' } & Invalid)
  | { status: 'accepted' }
  | { status: 'current' };

export type ChangeRow = Change & ChangeStatus;

export interface Overlap {
  resource: ResourceText;
  /** The agent on the other side. */
  with: string;
  /** Its workspace id or change id. */
  holder: string;
}

export interface Workspace {
  id: string;
  base: Oid;
  base_state: Oid;
  merge_parent: Oid | null;
  intent: string;
  agent: string;
  session: string | null;
  created: number;
  pid: number | null;
  path: string;
}

export interface WorkspaceRow extends Workspace {
  dirty: boolean;
  alive: boolean | null;
  writes: ResourceText[];
  claims: ResourceText[];
  overlaps: Overlap[];
}

export interface Overview {
  current: Change;
  changes: ChangeRow[];
  workspaces: WorkspaceRow[];
}

export interface Evidence {
  check: string;
  key: string;
  state: Oid;
  passed: boolean;
  exit_code: number;
  duration_ms: number;
  output: string;
  at: number;
}

export interface Verdict {
  evidence: Evidence;
  cached: boolean;
}

export interface CheckResult {
  check: string;
  evidence: Evidence | null;
}

export type Detail = Change & ChangeStatus & { writes: ResourceText[]; evidence: CheckResult[] };

export type Holder = { kind: 'workspace'; id: string; agent: string } | { kind: 'change'; id: Oid; agent: string };

export interface Held {
  resource: ResourceText;
  by: Holder;
}

export type Claimed = { claim: 'granted' } | { claim: 'refused'; held: Held[] };

export type Outcome =
  | { outcome: 'accepted'; current: Oid; composed: boolean; verdicts: Verdict[] }
  | { outcome: 'already-accepted' }
  | ({ outcome: 'rejected' } & Invalid);

export interface Recorded {
  change: Change | null;
  writes: ResourceText[];
}
