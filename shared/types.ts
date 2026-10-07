// Contracts shared by the local service and the UI.
// Every persisted record carries a schema version so stored data can be migrated.

export const STORE_SCHEMA_VERSION = 1;

export type Severity = "error" | "warn" | "info" | "off";
export type ModuleKind = "local" | "npm" | "core" | "unresolved";

export interface Repository {
  id: string;
  name: string;
  /** Canonical absolute path (realpath) of the registered root. */
  root: string;
  registeredAt: string;
  /** Explicit opt-in: let the engine evaluate bundler configs named in detangle.toml (runs repository JavaScript). */
  allowConfigEvaluation: boolean;
}

export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  /** Dependency types reported by the engine, e.g. local, type-only, dynamic, npm. */
  types: string[];
  typeOnly: boolean;
  circular: boolean;
}

export interface Module {
  id: string;
  kind: ModuleKind;
  fanIn: number;
  fanOut: number;
  instability: number;
  cycle: number | null;
}

export interface Violation {
  /** Stable identity: rule|scope|from|to. Used for baselines. */
  key: string;
  rule: string;
  severity: Severity;
  comment: string | null;
  scope: "module" | "folder" | "group";
  from: string;
  to: string | null;
  cycle: string[];
  imports: { from: string; specifier: string; to: string }[];
  category: "cycle" | "unresolved" | "boundary" | "other";
}

export interface ScanNote {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  /** What the user can do about it. */
  hint?: string;
}

export interface SourceVersion {
  /** Commit read from .git (git itself is never executed), or null outside a repository. */
  commit: string | null;
  branch: string | null;
  /** Hash of the module/edge set the engine reported: changes whenever the import graph changes. */
  graphFingerprint: string;
}

export interface ConfigVersion {
  /** Where rules came from: the repository's detangle.toml, or the engine's built-in defaults. */
  source: "file" | "builtin";
  path: string | null;
  /** sha256 of the raw file text (null for built-in rules). */
  textHash: string | null;
  /** Hash of the parsed rule set, insensitive to comments/formatting. */
  policyHash: string;
  /** Per-rule definition hashes, keyed by rule name. */
  ruleHashes: Record<string, string>;
}

export interface ScanSummary {
  id: string;
  repositoryId: string;
  startedAt: string;
  durationMs: number;
  engineMs: { scan: number; graph: number };
  engineVersion: string;
  source: SourceVersion;
  config: ConfigVersion;
  counts: {
    modules: number;
    localModules: number;
    edges: number;
    cycles: number;
    errors: number;
    warnings: number;
    info: number;
    unresolved: number;
  };
}

export interface Scan extends ScanSummary {
  schemaVersion: number;
  modules: Module[];
  edges: ImportEdge[];
  cycles: string[][];
  violations: Violation[];
  notes: ScanNote[];
  /** Whether the engine's cycle policy ignores type-only imports. */
  cyclesIgnoreTypeOnly: boolean;
}

export interface Baseline {
  id: string;
  schemaVersion: number;
  repositoryId: string;
  name: string;
  createdAt: string;
  scanId: string;
  source: SourceVersion;
  config: ConfigVersion;
  violations: Violation[];
}

export type ComparisonStatus = "new" | "resolved" | "unchanged" | "policy-changed";

export interface ComparisonItem {
  status: ComparisonStatus;
  violation: Violation;
  reason?: string;
}

export interface BaselineComparison {
  baseline: Pick<Baseline, "id" | "name" | "createdAt" | "source" | "config">;
  scan: Pick<ScanSummary, "id" | "startedAt" | "source" | "config">;
  sameRepository: boolean;
  sameRevision: boolean;
  samePolicy: boolean;
  changedRules: string[];
  items: ComparisonItem[];
  counts: Record<ComparisonStatus, number>;
}

// ---- Rules ----------------------------------------------------------------

export type RuleTemplate = "isolate-siblings" | "forbid-path" | "no-cycles" | "no-unresolved";

/** A structured rule as edited by the visual editor. Converted to a [[forbidden]] TOML table. */
export interface RuleDraft {
  template: RuleTemplate;
  name: string;
  severity: Severity;
  comment?: string;
  /** isolate-siblings: the parent folder, e.g. "src/features". */
  parentFolder?: string;
  /** forbid-path: regexes on root-relative paths. */
  fromPath?: string;
  fromPathNot?: string;
  toPath?: string;
  toPathNot?: string;
  /** no-cycles: only cycles passing through matching modules. */
  via?: string;
  /** no-cycles: count only runtime imports (exclude type-only). */
  runtimeOnly?: boolean;
}

export interface ConfigRule {
  kind: "forbidden" | "allowed" | "required";
  index: number;
  name: string | null;
  severity: string | null;
  comment: string | null;
  /** Raw table as parsed, for display. */
  table: Record<string, unknown>;
  /** Whether the visual editor can safely rewrite this rule's text block. */
  editable: boolean;
  draft: RuleDraft | null;
  notEditableReason?: string;
}

export interface RulesState {
  path: string;
  exists: boolean;
  textHash: string | null;
  text: string;
  rules: ConfigRule[];
  /** Why the file can't be edited structurally at all, if so. */
  unsupported: string | null;
  usesBuiltinRules: boolean;
}

export interface RulePreview {
  ok: boolean;
  /** Engine error (invalid regex, unknown field, …) with the location it reported. */
  error?: string;
  proposedText: string;
  diff: string;
  baseTextHash: string | null;
  /** Actual engine results with the proposed config, compared with the current config. */
  added: Violation[];
  removed: Violation[];
  /** Same violation, different severity. */
  changed: { before: Violation; after: Violation }[];
  unchangedCount: number;
  /** Violations of the rule being edited, under the proposed config. */
  ruleViolations: Violation[];
  affectedModules: string[];
}

export interface PathExplanation {
  from: string;
  to: string;
  /** Shortest import chain, each hop with the specifier that created it. */
  hops: { from: string; to: string; specifier: string; types: string[] }[];
  found: boolean;
}

export interface ApiError {
  error: string;
  code: string;
  hint?: string;
}
