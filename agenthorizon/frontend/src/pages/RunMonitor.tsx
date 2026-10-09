import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, fmtInt, fmtUsd, type AttemptRow, type RunDetail } from "../api";
import { Banner, C, ErrorBox, KV, Loading, Meter, resultKindBadge, Stat, StatusBadge, useCan } from "../components/ui";

interface TaskItem { example_id: string; state: string; final_class: string | null }
interface TaskDetail { example_id: string; attempts: AttemptRow[]; final: Record<string, unknown> | null; superseded: unknown[] }
interface Ev { seq: number; ts: string; type: string; [k: string]: unknown }

const STATE_COLORS: [string, string, string][] = [
  ["completed", "completed (valid verdict)", C.ok], ["invalid", "invalid verdict", C.warn], ["missing", "missing (no response)", C.danger],
  ["running", "running", C.info], ["pending_retry", "pending retry", C.accent], ["blocked", "blocked", "#7d3c98"],
  ["cancelled", "cancelled", C.muted], ["queued", "queued", C.neutral],
];

function useRunEvents(runId: string, onEvent: (e: Ev) => void) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // the browser reconnects and resumes from Last-Event-ID
    const handler = (m: MessageEvent) => { try { cb.current(JSON.parse(m.data)); } catch { /* ignore keepalives */ } };
    for (const t of ["run_created", "run_status", "attempt_started", "attempt_finished", "task_finalized", "cancel_requested",
      "pause_requested", "run_summary", "recovered_interrupted", "worker_error", "tasks_reopened", "final_superseded"]) es.addEventListener(t, handler);
    es.onmessage = handler;
    return () => es.close();
  }, [runId]);
  return connected;
}

function elapsed(from: string | null, to: Date): string {
  if (!from) return "—";
  const s = Math.max(0, (to.getTime() - new Date(from).getTime()) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

export function RunMonitorPage() {
  const { runId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const canWrite = useCan("runs.write");
  const canScore = useCan("scores.write");
  const canExport = useCan("exports.write");
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.get<RunDetail>(`/api/runs/${runId}`), refetchInterval: 10000 });
  const [stateFilter, setStateFilter] = useState("");
  const tasks = useQuery({ queryKey: ["run-tasks", runId, stateFilter], queryFn: () => api.get<{ items: TaskItem[] }>(`/api/runs/${runId}/tasks?limit=500${stateFilter ? `&state=${stateFilter}` : ""}`) });
  const [events, setEvents] = useState<Ev[]>([]);
  const refresh = useRef<number | null>(null);
  const connected = useRunEvents(runId, (e) => {
    setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs.slice(-400), e]));
    if (refresh.current === null) {
      refresh.current = window.setTimeout(() => {
        refresh.current = null;
        qc.invalidateQueries({ queryKey: ["run", runId] });
        qc.invalidateQueries({ queryKey: ["run-tasks", runId] });
      }, 800);
    }
  });
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const [budget, setBudget] = useState("");
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(`/api/runs/${runId}/${path}`, body ?? {}),
    onSettled: () => { qc.invalidateQueries({ queryKey: ["run", runId] }); qc.invalidateQueries({ queryKey: ["run-exports", runId] }); },
  });
  const exportsQ = useQuery({ queryKey: ["run-exports", runId], queryFn: () => api.get<{ items: { export_id: number; sha256: string; with_score: boolean; created_at: string; download_url: string }[] }>(`/api/runs/${runId}/exports`), refetchInterval: 8000 });
  const scores = useQuery({ queryKey: ["run-scores", runId], queryFn: () => api.get<{ items: { score_id: number; manifest_id: string; created_at: string; report: { metrics: { balanced_accuracy: { value: number | null } } } }[] }>(`/api/runs/${runId}/scores`), refetchInterval: 8000 });

  if (run.isLoading) return <Loading label="Loading run" />;
  if (run.isError || !run.data) return <ErrorBox error={run.error} />;
  const r = run.data;
  const d = r.definition;
  const total = r.n_tasks;
  const active = ["running", "created"].includes(r.status) || r.jobs.some((j) => ["queued", "running"].includes(j.status));
  const lastChange = r.status_history[r.status_history.length - 1]?.at;
  const endTime = active ? now : new Date(lastChange ?? Date.now());
  const selectedTask = sp.get("task");

  return (
    <>
      {d.synthetic_data ? <Banner tone="warn" title="Synthetic test fixture run">Every number on this page is test output, not a benchmark result.</Banner> : null}
      <div className="page-head">
        <div>
          <div className="subtle"><Link to="/runs">Runs</Link> / <span className="mono">{r.run_id}</span></div>
          <h1>{r.label ?? `${d.judge.model_display} · ${d.judge.interface}`}</h1>
          <div className="row"><StatusBadge status={r.status} />{resultKindBadge(d.classification.result_kind)}
            <span className="subtle">{connected ? "live" : "reconnecting…"}</span></div>
        </div>
        {canWrite ? (
          <div className="row">
            <button onClick={() => act.mutate({ path: "pause" })} disabled={!active}>Pause</button>
            <button className="danger" onClick={() => { if (confirm("Cancel this run? Running attempts stop; history is kept.")) act.mutate({ path: "cancel" }); }} disabled={!active}>Cancel</button>
            <input type="number" min={0} step="0.01" placeholder="budget USD" aria-label="Budget for resume" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 120 }} />
            <button onClick={() => act.mutate({ path: "resume", body: { budget_usd: budget ? Number(budget) : null, concurrency: (r.controls.concurrency as number) ?? 2 } })} disabled={active || r.status === "completed"}>Resume</button>
            <button onClick={() => { const why = prompt("Reason for re-opening tasks that ended without any response (audited):"); if (why) act.mutate({ path: `retry-errors?reason=${encodeURIComponent(why)}` }); }} disabled={active}>Retry errors…</button>
          </div>
        ) : null}
      </div>
      {act.isError ? <ErrorBox error={act.error} /> : null}
      {r.pause_reason ? <Banner tone={r.pause_reason.startsWith("blocked") ? "danger" : "warn"} title={r.status === "paused" ? "Paused" : "Stopped"}>{r.pause_reason}</Banner> : null}

      <div className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>Progress</h2><span className="subtle">finalized {r.finalized.toLocaleString()} of {total.toLocaleString()}</span></div>
        <div style={{ marginTop: "0.75rem" }}>
          <Meter total={total} ariaLabel="task states" segments={STATE_COLORS.map(([k, label, color]) => ({ label, value: r.task_states[k] ?? 0, color }))} />
        </div>
        <p className="subtle" style={{ marginTop: "0.75rem" }}>
          Scoring manifest: <code>{r.scoring_manifest_id ?? "none"}</code>. {r.coverage.note}.
        </p>
        <div className="grid grid-4" style={{ marginTop: "0.5rem" }}>
          <Stat value={elapsed(r.first_started_at, endTime)} label="elapsed" />
          <Stat value={fmtInt(r.telemetry.attempts)} label="attempts recorded" />
          <Stat value={`${fmtInt(r.telemetry.tokens_reported)} / ${fmtInt(r.telemetry.attempts)}`} label="attempts with token telemetry" hint="unknown usage stays unknown; it is never counted as zero" />
          <Stat value={`${fmtInt(r.telemetry.images_reported)} / ${fmtInt(r.telemetry.attempts)}`} label="attempts with image counts" />
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h3>Budget ledger</h3>
          <KV rows={[
            ["Limit", r.budget.limit_usd === null || r.budget.limit_usd === undefined ? "none (unmetered or not set)" : fmtUsd(r.budget.limit_usd)],
            ["Committed", fmtUsd(r.budget.committed_usd ?? 0)], ["Billed (reported)", fmtUsd(r.budget.spent_billed_usd ?? 0)],
            ["Estimated from tokens", fmtUsd(r.budget.spent_estimated_usd ?? 0)],
            ["Unknown-usage attempts", `${r.budget.unknown_cost_attempts ?? 0} (charged at their reservation)`],
            ["Reserved in flight", fmtUsd(r.budget.reserved_usd ?? 0)],
          ]} />
        </div>
        <div className="card">
          <h3>Live events</h3>
          <div className="log" aria-live="polite">
            {events.length === 0 ? <div className="subtle">Waiting for events…</div> : events.slice(-150).map((e) => (
              <div key={e.seq}>#{e.seq} {e.ts?.slice(11, 19)} {e.type}{e.example_id ? ` ${String(e.example_id).slice(0, 8)}` : ""}{e.attempt ? ` a${e.attempt}` : ""}{e.status ? ` → ${e.status}` : ""}{e.outcome_class ? ` (${e.outcome_class})` : ""}{e.reason ? ` · ${e.reason}` : ""}</div>
            ))}
          </div>
        </div>
      </div>

      <h2 style={{ marginTop: "1.5rem" }}>Tasks</h2>
      <div className="row" style={{ marginBottom: "0.5rem" }}>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>State
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All</option>{STATE_COLORS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      {tasks.isLoading ? <Loading /> : tasks.isError ? <ErrorBox error={tasks.error} /> : (
        <div className="table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
          <table>
            <thead><tr><th>Example</th><th>State</th><th>Final class</th><th /></tr></thead>
            <tbody>
              {(tasks.data?.items ?? []).map((t) => (
                <tr key={t.example_id} className="clickable" onClick={() => setSp({ task: t.example_id })} aria-selected={selectedTask === t.example_id}>
                  <td className="mono">{t.example_id}</td><td><StatusBadge status={t.state} /></td>
                  <td>{t.final_class ? t.final_class.replace(/_/g, " ") : "—"}</td>
                  <td><Link to={`/explore/${encodeURIComponent(d.dataset_version_id)}/${t.example_id}?run=${r.run_id}`} onClick={(e) => e.stopPropagation()}>Evidence</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedTask ? <TaskDrawer runId={r.run_id} eid={selectedTask} onClose={() => setSp({})} /> : null}

      <div className="grid grid-2" style={{ marginTop: "1.5rem" }}>
        <div className="card">
          <div className="spread"><h3 style={{ margin: 0 }}>Scores</h3>
            {canScore ? <button onClick={() => act.mutate({ path: "score", body: {} })}>Score now</button> : null}</div>
          {(scores.data?.items ?? []).length === 0 ? <p className="subtle">Not scored yet.</p> : (
            <ul>{scores.data!.items.map((s) => <li key={s.score_id}>
              <Link to={`/results?runs=${r.run_id}`}>#{s.score_id}</Link> · {s.manifest_id} · balanced accuracy {s.report.metrics.balanced_accuracy.value === null ? "undefined" : `${(s.report.metrics.balanced_accuracy.value * 100).toFixed(1)}%`} <span className="subtle">({new Date(s.created_at).toLocaleString()})</span>
            </li>)}</ul>
          )}
        </div>
        <div className="card">
          <div className="spread"><h3 style={{ margin: 0 }}>Exports</h3>
            {canExport ? <div className="row">
              <button onClick={() => act.mutate({ path: "exports", body: { with_score: false } })}>Bundle</button>
              <button onClick={() => act.mutate({ path: "exports", body: { with_score: true } })}>Bundle with score</button>
            </div> : null}</div>
          {(exportsQ.data?.items ?? []).length === 0 ? <p className="subtle">No exports yet.</p> : (
            <ul>{exportsQ.data!.items.map((x) => <li key={x.export_id}><a href={x.download_url}>export #{x.export_id}</a>{x.with_score ? " (with label-derived score)" : ""} <span className="mono subtle">{x.sha256.slice(0, 12)}</span></li>)}</ul>
          )}
        </div>
      </div>

      <details className="repro">
        <summary>Run definition (identity {r.run_id})</summary>
        <div style={{ marginTop: "0.75rem" }}>
          <KV rows={[
            ["Judge", `${d.judge.config_id} · ${d.judge.provider_model_id ?? "?"} via ${d.judge.route ?? "?"}${d.judge.effort ? ` · effort ${d.judge.effort}` : ""}`],
            ["Harness version", d.judge.harness?.version ?? "—"], ["Prompt", `${d.prompt.prompt_id} (${d.prompt.sha256.slice(0, 12)})`],
            ["Instruction file", d.instructions ? `${d.instructions.prompt_id}${d.instructions.paper_mode ? "" : " (extension)"}` : "none"],
            ["Preprocessing", d.preprocessing?.preprocessing_id ?? "—"], ["Staging", d.staging_mode],
            ["Attempt policy", `${d.attempt_policy.policy_id} · max ${d.attempt_policy.max_attempts} · ${d.attempt_policy.selection_rule} (${d.attempt_policy.source})`],
            ["Execution", `timeout ${d.execution.timeout_s}s · isolation ${d.execution.isolation}`],
            ["Selection", `${d.selection.source}${d.selection.manifest_id ? ` of ${d.selection.manifest_id}` : ""} · ${d.selection.example_ids.length} items`],
            ["Code", `${d.code.package_version} · core ${d.code.core_digest.slice(0, 12)}`], ["Trial", d.trial],
            ["Classification", d.classification.reasons.join("; ") || "paper-compatible"],
          ]} />
        </div>
      </details>
    </>
  );
}

function TaskDrawer({ runId, eid, onClose }: { runId: string; eid: string; onClose: () => void }) {
  const t = useQuery({ queryKey: ["task", runId, eid], queryFn: () => api.get<TaskDetail>(`/api/runs/${runId}/tasks/${eid}`) });
  const [artifact, setArtifact] = useState<string | null>(null);
  const art = useQuery({ queryKey: ["artifact", runId, artifact], enabled: !!artifact, queryFn: () => api.text(`/api/runs/${runId}/artifact?path=${encodeURIComponent(artifact!)}`) });
  return (
    <section className="card" style={{ marginTop: "1rem" }} aria-label={`Attempts for ${eid}`}>
      <div className="spread"><h3 style={{ margin: 0 }}>Attempt history · <span className="mono">{eid}</span></h3><button className="ghost" onClick={onClose}>Close</button></div>
      {t.isLoading ? <Loading /> : t.isError ? <ErrorBox error={t.error} /> : (
        <>
          <p className="subtle">Final: {t.data?.final ? JSON.stringify(t.data.final) : "not finalized"}</p>
          {(t.data?.attempts ?? []).map((a) => (
            <details key={a.attempt_no} open={a.attempt_no === Number((t.data?.final as { selected_attempt?: number } | null)?.selected_attempt)} style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 0" }}>
              <summary className="row"><strong>Attempt {a.attempt_no}</strong><StatusBadge status={a.status} />{a.outcome_class ? <span className="badge">{a.outcome_class.replace(/_/g, " ")}</span> : null}
                {a.counts_toward_limit === false ? <span className="subtle">not a judgment (infrastructure)</span> : null}</summary>
              {a.outcome ? (
                <div className="stack" style={{ marginTop: "0.5rem" }}>
                  {a.outcome.error ? <Banner tone="danger" title="Error">{a.outcome.error}</Banner> : null}
                  {a.outcome.verdict ? <KV rows={[
                    ["success", String(a.outcome.verdict.success)], ["binary valid", String(a.outcome.verdict.binary_valid)],
                    ["full contract valid", String(a.outcome.verdict.full_contract_valid)], ["mistake type", a.outcome.verdict.mistake_type_native ?? "—"],
                    ["confidence", a.outcome.verdict.confidence ?? "—"], ["problems", a.outcome.verdict.problems.join(", ") || "none"],
                  ]} /> : null}
                  {a.outcome.response_text ? <details><summary className="subtle">Raw response ({a.outcome.response_text.length} chars)</summary><pre className="block">{a.outcome.response_text}</pre></details> : null}
                  <KV rows={[
                    ["tokens in / out", `${fmtInt(a.outcome.telemetry?.input_tokens)} / ${fmtInt(a.outcome.telemetry?.output_tokens)}`],
                    ["tool calls / images viewed", `${fmtInt(a.outcome.telemetry?.tool_calls)} / ${fmtInt(a.outcome.telemetry?.images_viewed)}`],
                    ["wall time", a.outcome.telemetry?.wall_time_s ? `${a.outcome.telemetry.wall_time_s.toFixed(1)} s` : "—"],
                    ["telemetry coverage", Object.entries(a.outcome.telemetry?.coverage ?? {}).filter(([, v]) => v !== "reported").map(([k, v]) => `${k}: ${v}`).join(", ") || "all reported"],
                    ["transport retries", String(a.outcome.transport_retries?.length ?? 0)],
                    ["cost", a.cost ? `${a.cost.basis ?? ""} ${fmtUsd(a.cost.charged_usd as number)}` : "—"],
                  ]} />
                  <div className="chip-row">{Object.entries(a.outcome.artifacts ?? {}).map(([k, ref]) => (
                    <button key={k} className="ghost" onClick={() => setArtifact(ref.path)}>{k} ({(ref.bytes / 1024).toFixed(1)} kB)</button>
                  ))}</div>
                  <details><summary className="subtle">Lineage</summary><pre className="block">{JSON.stringify(a.outcome.lineage, null, 2)}</pre></details>
                </div>
              ) : null}
            </details>
          ))}
          {artifact ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div className="spread"><span className="mono subtle">{artifact}</span><button className="ghost" onClick={() => setArtifact(null)}>Close artifact</button></div>
              {art.isLoading ? <Loading /> : art.isError ? <ErrorBox error={art.error} /> : <pre className="block">{art.data}</pre>}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
