// Typed client for the workbench API. Same-origin cookies carry the session; every mutation sends the
// X-AH-Request header the server requires for cookie-authenticated writes (CSRF defence).

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  body: unknown;
  constructor(status: number, code: string, message: string, requestId?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-AH-Request": "1" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText, e?.request_id, data);
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown, h?: Record<string, string>) => request<T>("POST", p, b ?? {}, h),
  text: async (p: string) => {
    const r = await fetch(p, { credentials: "same-origin" });
    if (!r.ok) throw new ApiError(r.status, "error", r.statusText);
    return r.text();
  },
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

// ---- types (subset of the API's JSON) -------------------------------------------------------------------------
export interface Me { user_id: string; role: string; permissions: string[]; mode: string; via: string }
export interface DatasetSummary { dataset_version_id: string; benchmark: string; synthetic: boolean; examples: number; created_at: string; status: string }
export interface ManifestInfo { manifest_id: string; name: string; partition: string; role: string; official: boolean; n_items: number; digest: string; notes: string[] }
export interface ValidationCheck { check: string; status: string; count: number | null; detail?: string; severity?: string }
export interface DatasetDetail {
  dataset_version_id: string; benchmark: string; synthetic: boolean; info: Record<string, unknown>;
  counts: { examples: number; steps_total: number; max_steps: number; screenshots: number; screenshots_materialized: number };
  media_by_status: Record<string, number>;
  validation: { errors: number; warnings: number; checks: ValidationCheck[] };
  reconciliation: { checks?: { check: string; status: string; detail?: string }[]; failures?: number } | null;
  manifests: ManifestInfo[];
  membership_status: { revised_paper_partition: { status: string; detail?: string; note: string }; legacy_partition: { present: boolean; note: string } };
}
export interface ExampleRow { example_id: string; instruction: string; n_steps: number; os: string | null; application: string | null; domain: string | null; length_bin: string; media_total: number; media_materialized: number; recording_id: string }
export interface Page<T> { items: T[]; next_cursor: string | null; total?: number }
export interface ExampleDetail extends ExampleRow {
  dataset_version_id: string; instruction_id: string; has_markdown: boolean; has_json: boolean; synthetic: boolean;
  meta: { task_meta?: Record<string, unknown>; environment?: Record<string, unknown>; duration_ms?: number };
  manifests: { manifest_id: string; name: string; partition: string; official: boolean }[];
  timing: { first_us: number | null; last_us: number | null; observation_timing: string; note: string };
}
export interface StepRow {
  idx: number; step_id: number | null; action_type: string | null; action_text: string | null; action_text_full: string | null;
  action: Record<string, unknown> | null; asset_key: string | null; timestamp_us: number | null; observation_timing: string;
  thought: string | null; action_description: string | null;
  media: { status: string; width: number | null; height: number | null; thumb_url?: string; full_url?: string };
}
export interface Capability { status: string; reasons: string[]; checks: Record<string, { ok: boolean | null; [k: string]: unknown }> }
export interface JudgeConfig {
  config_id: string; model_key: string; interface: string; route: string | null; provider_model_id: string | null; id_evidence: string | null;
  sampling: Record<string, unknown>; effort: string | null; preprocessing: string | null; prompt_revision: string; paper_rows: string[];
  role: string; evidence_class: string; notes: string; model_display: string; interface_label: string; vision_input: boolean | null;
  capability: Capability;
}
export interface Plan {
  run_id: string; n_tasks: number; synthetic_data: boolean; ready_for_live_run: boolean; blocked: string[]; problems: string[];
  classification: { result_kind: string; reasons: string[]; note: string; official_selection: boolean };
  checks: Record<string, Record<string, unknown>>;
  forecast: { basis: string; assumptions: string[]; price: Record<string, unknown> | null; n_items: number; items_with_cost: number; total_cost_usd: number | null; total_input_tokens: number; per_attempt_max_usd: number | null; note: string };
  judge: Record<string, unknown>; selection: Record<string, unknown>;
}
export interface RunRow { run_id: string; status: string; config_id: string; dataset_version_id: string; result_kind: string; n_tasks: number; label: string | null; created_at: string; updated_at: string; pause_reason: string | null; trial: number }
export interface RunDetail {
  run_id: string; status: string; pause_reason: string | null; label: string | null; created_at: string; created_by: string;
  status_history: { status: string; at: string; reason?: string }[]; controls: Record<string, unknown>;
  budget: Record<string, number | null>; control_requests: Record<string, unknown>; definition: RunDefinition; plan: Plan | null;
  task_states: Record<string, number>; final_classes: Record<string, number>; n_tasks: number; finalized: number;
  coverage: { finalized_fraction: number | null; note: string };
  telemetry: Record<string, number | null>; first_started_at: string | null;
  jobs: { job_id: number; status: string; attempts: number; last_error: string | null; lease_owner: string | null }[];
  scoring_manifest_id: string | null;
}
export interface RunDefinition {
  dataset_version_id: string; synthetic_data: boolean; scoring_manifest_id: string | null; trial: number;
  selection: { source: string; manifest_id?: string; example_ids: string[]; official?: boolean };
  judge: { config_id: string; interface: string; model_display: string; provider_model_id: string | null; route: string | null; effort: string | null; harness?: { version?: string } | null };
  prompt: { prompt_id: string; sha256: string }; instructions: { prompt_id: string; paper_mode: boolean } | null;
  preprocessing: { preprocessing_id: string; paper_mode: boolean } | null; staging_mode: string;
  attempt_policy: { policy_id: string; max_attempts: number; selection_rule: string; source: string };
  execution: { timeout_s: number; isolation: string }; code: { core_digest: string; package_version: string };
  classification: { result_kind: string; reasons: string[] };
}
export interface Verdict { success: boolean | null; binary_valid: boolean; full_contract_valid: boolean; has_success_key: boolean; reasoning: string | null; confidence: string | null; mistake_type_native: string | null; mistake_type_category: string | null; problems: string[]; success_raw_type: string }
export interface Telemetry { input_tokens: number | null; output_tokens: number | null; tool_calls: number | null; images_viewed: number | null; turns: number | null; wall_time_s: number | null; cost_billed_usd: number | null; coverage: Record<string, string>; model_reported: string | null }
export interface AttemptRow {
  attempt_no: number; status: string; outcome_class: string | null; counts_toward_limit: boolean | null; started_at: string; finished_at: string | null;
  outcome: { status: string; response_text: string | null; verdict: Verdict | null; telemetry: Telemetry; error: string | null; transport_retries: unknown[]; artifacts: Record<string, { path: string; sha256: string; bytes: number }>; lineage: Record<string, unknown> } | null;
  cost: Record<string, unknown> | null; worker: string | null; notes: string[];
}
export interface Frac { numerator?: number; denominator?: number; value: number | null; display_pct: string | null; reason?: string; formula?: string }
export interface ScoreReport {
  manifest: { id: string; digest: string; n_items: number; P: number; N: number; role: string; partition: string; official: boolean; typed_negatives: number; untyped_negatives: number };
  predictions: { id: string; records: number; in_manifest_present: number; out_of_manifest_ignored: number; unknown_ids: number };
  metrics: { positive_accuracy: Frac; negative_accuracy: Frac; balanced_accuracy: Frac; raw_accuracy_secondary: Frac };
  confusion: { TP: number; FN_valid: number; TN: number; FP_valid: number; invalid_positive: Record<string, number>; invalid_negative: Record<string, number>; missing_positive: number; missing_negative: number; reconciliation: { positive: string; negative: string } };
  mistake_type_recall: Record<string, Frac>;
  validity: { present: number; binary_valid: number; full_contract_valid: number; parse_or_type_invalid: number; missing: number };
  coverage: { evaluated_with_valid_verdict: number; of: number; complete: boolean };
  warning?: string; selection_subset?: ScoreReport & { label: string }; run_id?: string; result_kind?: string; report_digest: string;
  scorer: { id: string; category_map: string; validity_rule: string };
}
export interface RefTable { table_id: string; title: string; kind: string; scope: Record<string, string>; provenance: Record<string, unknown>; columns: string[]; rows: Record<string, unknown>[] }

export function fmtPct(f?: Frac | null): string {
  if (!f || f.value === null || f.value === undefined) return "—";
  return `${(f.value * 100).toFixed(1)}%`;
}
export function fmtFrac(f?: Frac | null): string {
  if (!f || f.numerator === undefined) return "";
  return `${f.numerator}/${f.denominator}`;
}
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "unknown";
  return `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}
export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}
