import type {
  Baseline,
  BaselineComparison,
  PathExplanation,
  Repository,
  RuleDraft,
  RulePreview,
  RulesState,
  Scan,
  ScanSummary,
} from "../shared/types";

export class ApiFailure extends Error {
  constructor(
    message: string,
    public code: string,
    public hint?: string,
    public status = 0,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal,
      headers: body !== undefined || method !== "GET" ? { "content-type": "application/json", "x-lattice": "1" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new ApiFailure("Cancelled.", "cancelled");
    throw new ApiFailure("The local service is not reachable.", "offline", "Start it with npm run dev (or npm start) and reload.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; hint?: string };
    throw new ApiFailure(d.error ?? `Request failed (${res.status}).`, d.code ?? "http", d.hint, res.status);
  }
  return data as T;
}

export type RepoListItem = Repository & { scanning: boolean; latestScan: ScanSummary | null };
export type BaselineItem = Omit<Baseline, "violations"> & { violationCount: number };
export type RuleEdit = { op: "add"; draft: RuleDraft } | { op: "update"; index: number; draft: RuleDraft } | { op: "delete"; index: number };

export const api = {
  repos: () => request<RepoListItem[]>("GET", "/api/repos"),
  register: (path: string, name?: string) => request<Repository>("POST", "/api/repos", { path, name }),
  updateRepo: (id: string, patch: { name?: string; allowConfigEvaluation?: boolean }) => request<Repository>("PATCH", `/api/repos/${id}`, patch),
  removeRepo: (id: string) => request<{ ok: true }>("DELETE", `/api/repos/${id}`),
  scan: (id: string, signal?: AbortSignal) => request<Scan>("POST", `/api/repos/${id}/scan`, {}, signal),
  cancelScan: (id: string) => request<{ cancelled: boolean }>("POST", `/api/repos/${id}/scan/cancel`, {}),
  latestScan: (id: string) => request<Scan | null>("GET", `/api/repos/${id}/scans/latest`),
  scans: (id: string) => request<ScanSummary[]>("GET", `/api/repos/${id}/scans`),
  getScan: (id: string) => request<Scan>("GET", `/api/scans/${id}`),
  path: (scanId: string, from: string, to: string, types = true) =>
    request<PathExplanation>("GET", `/api/scans/${scanId}/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&types=${types ? 1 : 0}`),
  rules: (id: string) => request<RulesState>("GET", `/api/repos/${id}/rules`),
  previewRule: (id: string, edit: RuleEdit, signal?: AbortSignal) => request<RulePreview>("POST", `/api/repos/${id}/rules/preview`, edit, signal),
  saveRule: (id: string, edit: RuleEdit, baseTextHash: string | null) =>
    request<{ backup: string | null; textHash: string }>("POST", `/api/repos/${id}/rules/save`, { ...edit, baseTextHash }),
  baselines: (id: string) => request<BaselineItem[]>("GET", `/api/repos/${id}/baselines`),
  createBaseline: (id: string, scanId: string, name?: string) => request<BaselineItem>("POST", `/api/repos/${id}/baselines`, { scanId, name }),
  removeBaseline: (id: string) => request<{ ok: true }>("DELETE", `/api/baselines/${id}`),
  compare: (baselineId: string, scanId: string) => request<BaselineComparison>("GET", `/api/baselines/${baselineId}/compare/${scanId}`),
  reportUrl: (scanId: string, format: "md" | "json", baselineId?: string) =>
    `/api/scans/${scanId}/report?format=${format}${baselineId ? `&baseline=${baselineId}` : ""}`,
  configExportUrl: (repoId: string) => `/api/repos/${repoId}/config/export`,
};
