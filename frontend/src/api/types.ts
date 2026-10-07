// Mirrors the JSON produced by backend/src/cost_inspector/views.py and compare.py.
// Every money amount is an exact decimal string; null means "not reported".

export type Money = { currency: string; amount: string }

export interface Spend {
  by_currency: Money[]
  known_calls: number
  unknown_calls: number
  total_calls: number
  complete: boolean
}

export type TokenField =
  | 'input_tokens'
  | 'output_tokens'
  | 'reasoning_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens'
  | 'requests'

export interface TokenStat {
  /** null when no call reported this counter (absent is not zero). */
  total: number | null
  reported_calls: number
  model_calls: number
}

export type Tokens = Record<TokenField, TokenStat>

export type Category =
  | 'duplicate_repeated'
  | 'cache_reuse'
  | 'deterministic_candidate'
  | 'smaller_model_candidate'
  | 'orchestration_overhead'

export interface Issue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  line?: number
  column?: number
  item?: number
  path?: string
  hint?: string
  lines?: number[]
}

export interface AnalyzerInfo {
  name: string
  version: string
  revision: string
  source: string
}

export interface RunSummary {
  id: string
  import_id: string
  run_id: string
  ordinal: number
  name: string | null
  display_name: string
  run_type: string | null
  outcome: string | null
  error_codes: string[]
  environments: string[]
  start_ms: number
  first_event_ms: number
  last_event_ms: number
  calls: number
  model_calls: number
  tool_calls: number
  spend: Spend
  model_spend: Spend
  tool_spend: Spend
  tokens: Tokens
  models: string[]
  tools: string[]
  reported_duration_ms: number | null
  currencies: string[]
  synthetic: boolean
  import_filename: string
  open_findings: number
  dismissed_findings: number
  flagged_calls: number
}

export interface ImportSummary {
  id: string
  filename: string
  source: 'upload' | 'demo'
  synthetic: boolean
  demo_key: string | null
  format: 'jsonl' | 'json-array' | 'json-object'
  file_sha256: string
  byte_size: number
  record_count: number
  accepted_count: number
  imported_at: string
  analyzed_at: string
  analyzer: AnalyzerInfo
  spend: Spend
  runs: RunSummary[]
  open_findings: number
  dismissed_findings: number
  notes_count: number
  warnings_count: number
}

export interface ScenarioPart {
  flagged_calls: number
  flagged_spend: Spend
  estimate: Money[]
  unknown_cost_calls: number
}

export interface Scenario {
  ratios: Record<Category, string>
  method: string
  open: ScenarioPart
  all: ScenarioPart
}

export interface ResourceRow {
  resource_type: 'model' | 'tool'
  provider: string
  name: string
  calls: number
  spend: Spend
  tokens: Tokens | null
}

export interface SignatureField {
  field: string
  value: string | number | null
}

export interface SignatureEvidence {
  kind: 'usage_signature_match'
  scope: 'run' | 'import'
  signature: SignatureField[]
  reference_record_id: string
  reference_call_id: string
  members: { record_id: string; run_id: string; role: 'reference' | 'candidate'; call_id: string }[]
  run_ids: string[]
  not_compared: string[]
  statement: string
  proof: false
}

export interface KeywordEvidence {
  kind: 'metadata_keyword'
  keyword: string
  matches: { field: string; value: string; start?: number; end?: number }[]
  combined_text: string | null
  fields_checked: string[]
  keywords_checked: string[]
  also_present: string[]
  statement: string
  proof: false
}

export interface ModelTierEvidence {
  kind: 'model_tier_and_size'
  model: string
  matched_pattern: string
  patterns_checked: string[]
  low_cost_markers: string[]
  token_total: number
  token_limit: number
  counted: { input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null }
  statement: string
  proof: false
}

export interface CallCountEvidence {
  kind: 'call_count_in_run'
  run_id: string
  model_call_count: number
  min_calls: number
  kept_calls: number
  medium_confidence_at: number
  ordering: string
  ordering_note: string | null
  sequence: {
    record_id: string
    call_id: string
    position: number
    step: number | null
    event_time: string
    flagged: boolean
  }[]
  statement: string
  proof: false
}

export type Evidence =
  | SignatureEvidence
  | KeywordEvidence
  | ModelTierEvidence
  | CallCountEvidence
  | { kind: 'unavailable' }

export interface Rule {
  name: string
  summary: string
  confidence?: string
  source: string
  analyzer: string
}

export interface AffectedCall {
  call_id: string
  record_id: string
  run_pk: string
  run_id: string
  step: number | null
  resource_name: string
  event_time: string
  cost: { amount: string | null; currency: string | null }
}

/** KORA Doctor v0.1.0 emits "medium" or "low"; kept open for future analyzer values. */
export type Confidence = 'medium' | 'low' | (string & {})

/** Light form used by lists, the timeline and the command palette. */
export interface FindingSummary {
  id: string
  import_id: string
  ordinal: number
  rank: number
  category: Category
  category_label: string
  title: string
  confidence: Confidence
  evidence_status: 'derived' | 'unavailable'
  call_ids: string[]
  reference_call_id: string | null
  run_pks: string[]
  affected_count: number
  affected_spend: Spend
  overlap_count: number
  dismissed: boolean
  dismissal_note: string | null
  dismissed_at: string | null
}

export interface OverlapGroup {
  category: Category
  category_label: string
  findings: number
  open_findings: number
  shared_calls: number
  finding_ids: string[]
}

/** Full form from GET /api/findings/{id}: evidence, rule, rationale and limits. */
export interface Finding extends FindingSummary {
  rationale: string
  evidence: Evidence
  rule: Rule
  limitations: string[]
  affected: AffectedCall[]
  run_ids: string[]
  scenario: { ratio: string; ratio_percent: string; estimate: Money[]; unknown_cost_calls: number }
  overlaps: OverlapGroup[]
}

export interface CallRecord {
  id: string
  import_id: string
  record_id: string
  run_pk: string
  run_id: string
  ordinal: number
  line: number
  item: number
  step: number | null
  span_id: string
  parent_span_id: string | null
  event_time: string
  event_ms: number
  start_ms: number | null
  duration_ms: number | null
  received_time: string | null
  emitter: { component: string; name: string; version: string }
  resource: {
    provider: string
    type: 'model' | 'tool'
    name: string
    operation: string
    modality: string | null
    region: string | null
    deployment: string | null
  }
  is_model: boolean
  usage_kind: 'llm' | 'tool'
  usage: Record<string, number | string>
  cost: {
    amount: string | null
    currency: string | null
    detail: Record<string, unknown> | null
  }
  labels: Record<string, string>
  environment: string | null
  run_name: string | null
  run_type: string | null
  outcome: string | null
  error_code: string | null
  error_reason: string | null
  corrects: string | null
  spec_version: string
  content_sha256: string
  findings: { id: string; category: Category; dismissed: boolean }[]
}

export interface ImportDetail extends ImportSummary {
  notes: Issue[]
  category_counts: Record<Category, number>
  findings: FindingSummary[]
  scenario: Scenario
  by_model: ResourceRow[]
}

export interface RunDetail {
  run: RunSummary
  import: ImportSummary
  calls: CallRecord[]
  findings: FindingSummary[]
  scenario: Scenario
  by_model: ResourceRow[]
  timeline: { start_ms: number; end_ms: number; rule: string }
}

export interface CategoryInfo {
  label: string
  plural: string
  rule: Rule
  limitations: string[]
  ratio: string
}

export interface Meta {
  app: { name: string; version: string }
  analyzer: AnalyzerInfo
  audr_spec_version: string
  limits: { max_upload_bytes: number; max_records: number }
  accepted_formats: string[]
  glossary: Record<'observed' | 'candidate' | 'scenario_estimate' | 'measured_change' | 'unknown_cost', string>
  categories: Record<Category, CategoryInfo>
  dropped_fields: string[]
  demo: { loaded: boolean }
  counts: { imports: number }
}

export type Equivalence = 'equivalent' | 'not_equivalent' | 'unsure'

export interface ScopeRow {
  currency: string
  baseline: string
  candidate: string
  delta: string | null
  percent: string | null
  percent_note: string | null
}

export interface ComparisonScope {
  scope: 'all_calls' | 'model_calls'
  label: string
  comparable: boolean
  reasons: string[]
  notes: string[]
  rows: ScopeRow[]
  baseline_spend: Spend
  candidate_spend: Spend
}

export interface IntDelta {
  baseline: number | null
  candidate: number | null
  delta: number | null
}

export interface TokenDelta extends IntDelta {
  baseline_reported: string
  candidate_reported: string
}

export interface RunRef {
  id: string
  run_id: string
  display_name: string
  import_id: string
  import_filename: string | null
  synthetic: boolean
  calls: number
  spend: Spend
}

export interface ComparisonResult {
  baseline: RunRef
  candidate: RunRef
  equivalence: Equivalence
  kind: 'measured_change' | 'observed_difference' | 'not_comparable'
  headline_scope: 'all_calls' | 'model_calls' | null
  scopes: ComparisonScope[]
  usage: {
    calls: IntDelta
    model_calls: IntDelta
    tool_calls: IntDelta
    tokens: Record<TokenField, TokenDelta>
  }
  by_model: {
    resource_type: 'model' | 'tool'
    provider: string
    name: string
    baseline: { calls: number; spend: Spend }
    candidate: { calls: number; spend: Spend }
    delta: Money[] | null
  }[]
  findings: {
    baseline_open: number
    candidate_open: number
    baseline_flagged_calls: number
    candidate_flagged_calls: number
  }
  outcomes: { baseline: string | null; candidate: string | null }
  quality: { measured: false; note: string }
  notes: string[]
}

export interface SavedComparison {
  id: string
  created_at: string
  equivalence: Equivalence
  note: string | null
  result: ComparisonResult
}

export interface ApiErrorPayload {
  code: string
  message: string
  issues?: Issue[]
  issue_count?: number
  truncated?: boolean
  records_seen?: number
  import_id?: string
  limit_bytes?: number
}

export interface DemoResult {
  imports: Record<string, string>
  created: string[]
  suggested_comparison: { baseline_run_id: string | null; candidate_run_id: string | null }
}
