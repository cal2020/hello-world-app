import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, fmtInt, fmtUsd, type DatasetDetail, type DatasetSummary, type JudgeConfig, type Plan } from "../api";
import { Banner, ErrorBox, KV, Loading, resultKindBadge, StatusBadge } from "../components/ui";

const PREPROCESSING = [
  { id: "native-512x332", label: "Native frames, 512×332 (protocol S5)" },
  { id: "mosaic-2x2-1024x664", label: "2×2 mosaic, 1024×664 (protocol S5; layout details are engineering choices)" },
  { id: "released-auto@100000", label: "Released auto-resolution, 100k token budget (released code)" },
  { id: "released-1126x730", label: "Released fixed 1126×730 (released code)" },
];

/** Same form session + same request body => same idempotency key (a double click replays, an edit does not). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

interface Form {
  dataset_version: string; manifest: string; mode: "manifest" | "smoke" | "ids"; smoke_n: number; ids: string; judge_config: string;
  provider_model_id: string; route: string; base_url: string; effort: string; instructions: string; preprocessing: string;
  staging_mode: string; trial: number; label: string; concurrency: number; budget_usd: string; max_tasks: string;
  price_input: string; price_output: string; price_source: string;
}

export function RunSetupPage() {
  const navigate = useNavigate();
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.get<{ datasets: DatasetSummary[] }>("/api/datasets") });
  const judges = useQuery({ queryKey: ["judges"], queryFn: () => api.get<{ generated_at: string; configs: JudgeConfig[] }>("/api/judges") });
  const [f, setF] = useState<Form>({
    dataset_version: "", manifest: "", mode: "smoke", smoke_n: 5, ids: "", judge_config: "", provider_model_id: "", route: "",
    base_url: "", effort: "", instructions: "rubric-extension", preprocessing: "", staging_mode: "paper-paths", trial: 1, label: "",
    concurrency: 2, budget_usd: "", max_tasks: "", price_input: "", price_output: "", price_source: "",
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planKey, setPlanKey] = useState("");
  const [idemKey] = useState(() => crypto.randomUUID());
  const dvList = datasets.data?.datasets ?? [];
  const dv = f.dataset_version || dvList.find((d) => !d.synthetic)?.dataset_version_id || dvList[0]?.dataset_version_id || "";
  const detail = useQuery({ queryKey: ["dataset", dv], enabled: !!dv, queryFn: () => api.get<DatasetDetail>(`/api/datasets/${encodeURIComponent(dv)}`) });
  const manifest = f.manifest || detail.data?.manifests.find((m) => m.partition === "full-release")?.manifest_id || "";
  const cfg = judges.data?.configs.find((c) => c.config_id === f.judge_config);

  const body = useMemo(() => {
    const config: Record<string, unknown> = {
      dataset_version: dv, judge_config: f.judge_config, trial: f.trial, staging_mode: f.staging_mode,
      label: f.label || undefined, instructions: f.instructions,
    };
    if (f.mode === "ids") config.example_ids = f.ids.split(/[\s,]+/).filter(Boolean);
    else { config.manifest = manifest; if (f.mode === "smoke") config.smoke_n = f.smoke_n; }
    for (const k of ["provider_model_id", "route", "base_url", "effort", "preprocessing"] as const) if (f[k]) config[k] = f[k];
    const b: Record<string, unknown> = { config, concurrency: f.concurrency };
    if (f.budget_usd) b.budget_usd = Number(f.budget_usd);
    if (f.max_tasks) b.max_tasks = Number(f.max_tasks);
    if (f.price_input || f.price_output) b.price_override = { input_per_mtok: Number(f.price_input), output_per_mtok: Number(f.price_output), source: f.price_source };
    return b;
  }, [f, dv, manifest]);
  const key = JSON.stringify(body);

  const planM = useMutation({
    mutationFn: () => api.post<Plan>("/api/runs/plan", body),
    onSuccess: (p) => { setPlan(p); setPlanKey(key); },
  });
  const startM = useMutation({
    mutationFn: () => api.post<{ run_id: string }>("/api/runs", body, { "Idempotency-Key": `${idemKey}:${fnv1a(key)}` }),
    onSuccess: (r) => navigate(`/runs/${r.run_id}`),
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const stale = plan && planKey !== key;

  if (datasets.isLoading || judges.isLoading) return <Loading />;
  if (datasets.isError) return <ErrorBox error={datasets.error} />;
  if (judges.isError) return <ErrorBox error={judges.error} />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Experiment setup</h1>
          <p className="muted">Every run is planned first: capability checks, input-limit diagnostics, and a cost forecast with its assumptions.</p>
        </div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); planM.mutate(); }}>
        <fieldset>
          <legend>Data and selection</legend>
          <div className="form-grid">
            <label className="field">Dataset version
              <select value={dv} onChange={(e) => { set("dataset_version", e.target.value); set("manifest", ""); }}>
                {dvList.map((d) => <option key={d.dataset_version_id} value={d.dataset_version_id}>{d.dataset_version_id}{d.synthetic ? " (synthetic)" : ""}</option>)}
              </select>
            </label>
            <label className="field">Selection
              <select value={f.mode} onChange={(e) => set("mode", e.target.value as Form["mode"])}>
                <option value="manifest">Whole manifest</option>
                <option value="smoke">Engineering smoke subset (deterministic)</option>
                <option value="ids">Explicit example ids</option>
              </select>
            </label>
            {f.mode !== "ids" ? (
              <label className="field">Manifest (governs scoring)
                <select value={manifest} onChange={(e) => set("manifest", e.target.value)}>
                  {(detail.data?.manifests ?? []).map((m) => <option key={m.manifest_id} value={m.manifest_id}>{m.name} ({m.n_items}){m.official ? "" : " · not official"}</option>)}
                </select>
              </label>
            ) : null}
            {f.mode === "smoke" ? (
              <label className="field">Smoke subset size<input type="number" min={1} value={f.smoke_n} onChange={(e) => set("smoke_n", Number(e.target.value))} /></label>
            ) : null}
            <label className="field">Trial index (repeats are separate runs)<input type="number" min={1} value={f.trial} onChange={(e) => set("trial", Number(e.target.value))} /></label>
            <label className="field">Label<input type="text" value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="optional" /></label>
          </div>
          {f.mode === "ids" ? <label className="field" style={{ marginTop: "0.75rem" }}>Example ids<textarea value={f.ids} onChange={(e) => set("ids", e.target.value)} /></label> : null}
          {f.mode === "smoke" ? <p className="subtle" style={{ marginTop: "0.5rem" }}>A smoke subset is not AH-D. It is scored against its parent manifest (unselected items count as missing) plus a separately labelled subset score. Do not tune prompts on it.</p> : null}
        </fieldset>

        <fieldset>
          <legend>Judge</legend>
          <label className="field">Registered configuration
            <select value={f.judge_config} onChange={(e) => { set("judge_config", e.target.value); setPlan(null); }} required>
              <option value="">Choose…</option>
              {(judges.data?.configs ?? []).map((c) => (
                <option key={c.config_id} value={c.config_id}>{c.model_display} · {c.interface_label}{c.preprocessing ? ` · ${c.preprocessing}` : ""}{c.role === "splitter" ? " · splitter" : ""} — {c.capability.status}</option>
              ))}
            </select>
          </label>
          {cfg ? (
            <div className="card" style={{ marginTop: "0.75rem", boxShadow: "none" }}>
              <div className="row" style={{ marginBottom: "0.5rem" }}>
                <StatusBadge status={cfg.capability.status} /><span className="badge">{cfg.evidence_class.replace(/_/g, " ")}</span>
                {cfg.vision_input === null ? <span className="badge warn">vision support unverified</span> : null}
              </div>
              <KV rows={[
                ["Model identifier", cfg.provider_model_id ? <code key="m">{cfg.provider_model_id}</code> : <span key="m" className="badge danger">not evidenced — operator must supply</span>],
                ["Evidence", cfg.id_evidence ?? "—"], ["Route", cfg.route ?? "unknown"], ["Effort", cfg.effort ?? "—"],
                ["Prompt", <code key="p">{cfg.prompt_revision}</code>],
                ["Sampling", Object.entries(cfg.sampling).map(([k, v]) => `${k}=${v ?? "unpublished"}`).join(", ")],
              ]} />
              {cfg.capability.reasons.length ? <ul className="subtle">{cfg.capability.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              {cfg.notes ? <p className="subtle">{cfg.notes}</p> : null}
            </div>
          ) : null}
          <div className="form-grid" style={{ marginTop: "0.75rem" }}>
            <label className="field">Model identifier override<input type="text" value={f.provider_model_id} onChange={(e) => set("provider_model_id", e.target.value)} placeholder={cfg?.provider_model_id ?? "required"} /></label>
            <label className="field">Route override<input type="text" value={f.route} onChange={(e) => set("route", e.target.value)} placeholder={cfg?.route ?? "required"} /></label>
            <label className="field">Self-hosted endpoint (vLLM)<input type="text" value={f.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://host/v1" /></label>
            <label className="field">Effort<input type="text" value={f.effort} onChange={(e) => set("effort", e.target.value)} placeholder={cfg?.effort ?? ""} /></label>
            {cfg?.interface === "direct" ? (
              <label className="field">Preprocessing
                <select value={f.preprocessing || cfg.preprocessing || ""} onChange={(e) => set("preprocessing", e.target.value)}>
                  {PREPROCESSING.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
            ) : cfg ? (
              <label className="field">Harness instruction file
                <select value={["rubric-extension", "none"].includes(f.instructions) ? f.instructions : "path"} onChange={(e) => set("instructions", e.target.value === "path" ? "" : e.target.value)}>
                  <option value="rubric-extension">Public rubric as AGENTS.md (extension)</option>
                  <option value="none">None (extension)</option>
                  <option value="path">Official AGENTS.md from a path (paper mode)</option>
                </select>
              </label>
            ) : null}
            {cfg && cfg.interface !== "direct" && !["rubric-extension", "none"].includes(f.instructions) ? (
              <label className="field">AGENTS.md path on the server<input type="text" value={f.instructions} onChange={(e) => set("instructions", e.target.value)} /></label>
            ) : null}
            <label className="field">Staging
              <select value={f.staging_mode} onChange={(e) => set("staging_mode", e.target.value)}>
                <option value="paper-paths">Released paths (paper)</option><option value="opaque-paths">Opaque media paths (audited remap)</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Execution and cost controls</legend>
          <div className="form-grid">
            <label className="field">Concurrency<input type="number" min={1} max={64} value={f.concurrency} onChange={(e) => set("concurrency", Number(e.target.value))} /></label>
            <label className="field">Budget (USD, required for paid routes)<input type="number" min={0} step="0.01" value={f.budget_usd} onChange={(e) => set("budget_usd", e.target.value)} /></label>
            <label className="field">Pilot: start at most N tasks<input type="number" min={1} value={f.max_tasks} onChange={(e) => set("max_tasks", e.target.value)} /></label>
          </div>
          <details style={{ marginTop: "0.75rem" }}><summary className="subtle">Operator price (only when no verified price is registered)</summary>
            <div className="form-grid" style={{ marginTop: "0.5rem" }}>
              <label className="field">USD / M input tokens<input type="number" min={0} step="0.001" value={f.price_input} onChange={(e) => set("price_input", e.target.value)} /></label>
              <label className="field">USD / M output tokens<input type="number" min={0} step="0.001" value={f.price_output} onChange={(e) => set("price_output", e.target.value)} /></label>
              <label className="field">Price source<input type="text" value={f.price_source} onChange={(e) => set("price_source", e.target.value)} placeholder="URL and retrieval date" /></label>
            </div>
          </details>
        </fieldset>
        <div className="row">
          <button type="submit" className="primary" disabled={!f.judge_config || planM.isPending}>{planM.isPending ? "Checking…" : "Validate and forecast (dry run)"}</button>
          <button type="button" disabled={!plan || !!stale || !plan.ready_for_live_run || startM.isPending} onClick={() => startM.mutate()}>
            {startM.isPending ? "Starting…" : "Start run"}
          </button>
          {stale ? <span className="subtle">Settings changed — validate again.</span> : null}
        </div>
      </form>
      {planM.isError ? <div style={{ marginTop: "1rem" }}><ErrorBox error={planM.error} /></div> : null}
      {startM.isError ? <div style={{ marginTop: "1rem" }}><ErrorBox error={startM.error} /></div> : null}
      {plan ? <PlanView plan={plan} /> : null}
    </>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  const f = plan.forecast;
  return (
    <section className="card" style={{ marginTop: "1.25rem" }} aria-label="Plan">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Plan <span className="mono subtle">{plan.run_id}</span></h2>
        <div className="row">{resultKindBadge(plan.classification.result_kind)}{plan.ready_for_live_run ? <span className="badge ok">ready</span> : <span className="badge danger">not executable</span>}</div>
      </div>
      {plan.synthetic_data ? <Banner tone="warn" title="Synthetic test fixture">Any result is test output, not a benchmark measurement.</Banner> : null}
      {plan.blocked.length ? <Banner tone="danger" title="Blocked"><ul>{plan.blocked.map((b) => <li key={b}>{b.replace(/^BLOCKED: /, "")}</li>)}</ul></Banner> : null}
      {plan.classification.reasons.length ? (
        <Banner tone="info" title="Why this is not a paper-compatible run">
          <ul>{plan.classification.reasons.map((r) => <li key={r}>{r}</li>)}</ul>{plan.classification.note}
        </Banner>
      ) : null}
      {plan.problems.filter((p) => !p.startsWith("BLOCKED")).map((p) => <Banner key={p} tone="warn" title="Note">{p}</Banner>)}
      <div className="grid grid-2">
        <div>
          <h3>Checks</h3>
          <div className="table-wrap"><table><tbody>
            {Object.entries(plan.checks).map(([k, v]) => (
              <tr key={k}><td>{k.replace(/_/g, " ")}</td>
                <td>{"ok" in v ? <StatusBadge status={v.ok === true ? "ok" : v.ok === false ? "blocked" : "unverified"} label={v.ok === true ? "ok" : v.ok === false ? "problem" : "n/a"} /> : null}</td>
                <td className="subtle">{summarizeCheck(k, v)}</td></tr>
            ))}
          </tbody></table></div>
        </div>
        <div>
          <h3>Cost forecast (estimate)</h3>
          <KV rows={[
            ["Total", f.total_cost_usd !== null ? fmtUsd(f.total_cost_usd) : `unknown (${f.items_with_cost}/${f.n_items} items priced)`],
            ["Largest single attempt", fmtUsd(f.per_attempt_max_usd)],
            ["Input tokens (est.)", fmtInt(f.total_input_tokens)],
            ["Basis", f.basis],
            ["Price", f.price ? `${(f.price as Record<string, unknown>).input_per_mtok} / ${(f.price as Record<string, unknown>).output_per_mtok} USD per M tokens (${(f.price as Record<string, unknown>).status}; ${(f.price as Record<string, unknown>).source})` : "no verified price"],
          ]} />
          <ul className="subtle">{f.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          <p className="subtle">{f.note}</p>
        </div>
      </div>
    </section>
  );
}

function summarizeCheck(k: string, v: Record<string, unknown>): string {
  if (k === "credentials") return `requires ${(v.required as string[]).join(", ") || "none"}${(v.missing as string[]).length ? ` · missing ${(v.missing as string[]).join(", ")}` : ""} (${v.checked_in})`;
  if (k === "media") return `${v.items_with_missing_screenshots} items missing ${v.missing_screenshots} screenshots`;
  if (k === "serving_limits") return `${v.items_exceeding} items exceed a known limit; unverified: ${(v.unverified as string[]).join(", ") || "none"}`;
  if (k === "harness") return `${v.interface} ${v.worker_version ?? v.version ?? "not installed"}`;
  if (k === "isolation") return `${v.backend}: ${v.detail}`;
  if (k === "budget") return String(v.detail ?? `limit $${v.limit_usd}${v.forecast_fits === false ? " (forecast exceeds it)" : ""}`);
  if (k === "cost") return JSON.stringify((v.basis as Record<string, unknown>)?.note ?? (v.basis as Record<string, unknown>)?.price_known ?? "");
  return "";
}
