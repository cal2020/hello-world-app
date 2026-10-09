import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type AttemptRow, type ExampleDetail, type Page, type RunRow } from "../api";
import { citedSteps, relMs, ScreenshotViewer, Timeline, useStepWindows } from "../components/trajectory";
import { Banner, ErrorBox, KV, Loading, StatusBadge, SyntheticBanner, useCan } from "../components/ui";

interface TaskDetail { example_id: string; attempts: AttemptRow[]; final: { selected_attempt: number | null; has_response: boolean; final_class: string } | null }

export function InspectPage() {
  const { dv = "", eid = "" } = useParams();
  const ex = useQuery({ queryKey: ["example", dv, eid], queryFn: () => api.get<ExampleDetail>(`/api/datasets/${encodeURIComponent(dv)}/examples/${eid}`) });
  if (ex.isLoading) return <Loading label="Loading trajectory" />;
  if (ex.isError || !ex.data) return <ErrorBox error={ex.error} />;
  return <Inspector dv={dv} ex={ex.data} />;
}

function Inspector({ dv, ex }: { dv: string; ex: ExampleDetail }) {
  const [sp, setSp] = useSearchParams();
  const n = ex.n_steps;
  const clamp = useCallback((i: number) => Math.max(0, Math.min(n - 1, i)), [n]);
  const selected = clamp(Number(sp.get("step") ?? 0) || 0);
  const runId = sp.get("run") ?? "";
  const select = useCallback((i: number) => {
    setSp((prev) => { const p = new URLSearchParams(prev); p.set("step", String(clamp(i))); return p; }, { replace: true });
  }, [setSp, clamp]);
  const canLabels = useCan("research.labels");
  const canReview = useCan("review.write");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const k = e.key;
      if (k === "ArrowDown" || k === "j") { e.preventDefault(); select(selected + 1); }
      else if (k === "ArrowUp" || k === "k") { e.preventDefault(); select(selected - 1); }
      else if (k === "PageDown") { e.preventDefault(); select(selected + 10); }
      else if (k === "PageUp") { e.preventDefault(); select(selected - 10); }
      else if (k === "Home") { e.preventDefault(); select(0); }
      else if (k === "End") { e.preventDefault(); select(n - 1); }
      else if (k === "g") { e.preventDefault(); document.getElementById("goto-step")?.focus(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, select, n]);

  const { byIdx } = useStepWindows(dv, ex.example_id, n, [selected]);
  const step = byIdx.get(selected);

  const runs = useQuery({ queryKey: ["runs-list"], queryFn: () => api.get<Page<RunRow>>("/api/runs?limit=200") });
  const dvRuns = (runs.data?.items ?? []).filter((r) => r.dataset_version_id === dv);
  const task = useQuery({
    queryKey: ["task", runId, ex.example_id], enabled: !!runId,
    queryFn: () => api.get<TaskDetail>(`/api/runs/${runId}/tasks/${ex.example_id}`),
  });
  const sel = task.data?.final?.selected_attempt ? task.data.attempts.find((a) => a.attempt_no === task.data!.final!.selected_attempt) : undefined;
  const verdict = sel?.outcome?.verdict ?? null;
  // "Step N" in a verdict refers to the release's 0-based step label. Loaded steps map labels to timeline positions;
  // labels in windows not yet loaded fall back to the identical position (the release numbers steps contiguously).
  const idMap = useMemo(() => {
    const m = new Map<number, number>();
    byIdx.forEach((s, i) => { if (s.step_id !== null) m.set(s.step_id, i); });
    return m;
  }, [byIdx]);
  const evidence = useMemo(() => new Set(citedSteps(verdict?.reasoning, (id) => idMap.get(id) ?? (id >= 0 && id < n ? id : undefined))),
    [verdict?.reasoning, n, idMap]);

  const [repro, setRepro] = useState<"" | "markdown" | "json">("");
  const released = useQuery({
    queryKey: ["released", dv, ex.example_id, repro], enabled: !!repro,
    queryFn: () => api.text(`/api/datasets/${encodeURIComponent(dv)}/examples/${ex.example_id}/released/${repro}`),
  });

  return (
    <>
      <SyntheticBanner show={ex.synthetic} />
      <div className="page-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="subtle"><Link to={`/explore/${encodeURIComponent(dv)}`}>Trajectories</Link> / {ex.example_id}</div>
          <h1 style={{ marginTop: "0.25rem" }}>{ex.instruction}</h1>
          <div className="row subtle">
            <span>{n} steps</span><span>· {ex.os ?? "OS unknown"}</span>{ex.application ? <span>· {ex.application}</span> : null}
            {ex.domain ? <span>· {ex.domain}</span> : null}<span>· {ex.media_materialized}/{ex.media_total} screenshots</span>
            {ex.manifests.map((m) => <span key={m.manifest_id} className={`badge ${m.partition === "legacy-submitted" ? "warn" : ""}`}>{m.name}</span>)}
          </div>
        </div>
        <div className="row">
          {canLabels ? <Link className="btn" to={`/explore/${encodeURIComponent(dv)}/${ex.example_id}/pair`}>Pair inspection</Link> : null}
          {canReview ? <Link className="btn" to={`/review/${encodeURIComponent(dv)}/${ex.example_id}`}>Review</Link> : null}
        </div>
      </div>
      <p className="subtle" style={{ marginTop: "-0.5rem" }}>
        Observation timing: {ex.timing.note}. Keys: <kbd>↑</kbd>/<kbd>↓</kbd> step, <kbd>PgUp</kbd>/<kbd>PgDn</kbd> ±10,
        <kbd>Home</kbd>/<kbd>End</kbd>, <kbd>g</kbd> go to step, <kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd> zoom.
      </p>
      <div className="inspect">
        <div className="stack">
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              Go to step (#1–{n})
              <input id="goto-step" type="number" min={1} max={n} value={selected + 1}
                onChange={(e) => select(Number(e.target.value) - 1)} />
            </label>
          </div>
          <Timeline dv={dv} eid={ex.example_id} nSteps={n} selected={selected} onSelect={select} evidence={evidence} firstTs={ex.timing.first_us} />
        </div>
        <div className="stack">
          <ScreenshotViewer step={step} />
          <div className="card">
            <h3>Action at step {step?.step_id ?? selected}</h3>
            {step ? (
              <>
                <KV rows={[
                  ["Action", <code key="a">{step.action_text_full ?? step.action_text ?? step.action_type}</code>],
                  ["Type", step.action_type],
                  ["Time from start", relMs(step.timestamp_us, ex.timing.first_us) || "—"],
                  ["Observation", "screenshot shows the screen before this action"],
                  ...(step.thought ? [["Recorded thought", step.thought] as [string, string]] : []),
                  ...(step.action_description ? [["Description", step.action_description] as [string, string]] : []),
                ]} />
                <details style={{ marginTop: "0.5rem" }}><summary className="subtle">Structured action</summary>
                  <pre className="block">{JSON.stringify(step.action, null, 2)}</pre></details>
              </>
            ) : <span className="spinner" />}
          </div>
          <div className="card">
            <div className="spread">
              <h3 style={{ margin: 0 }}>Compare with a judge prediction</h3>
              <select aria-label="Run" value={runId} onChange={(e) => setSp((p) => { const q = new URLSearchParams(p); if (e.target.value) q.set("run", e.target.value); else q.delete("run"); return q; })}>
                <option value="">Select a run…</option>
                {dvRuns.map((r) => <option key={r.run_id} value={r.run_id}>{r.label ?? r.config_id} · {r.run_id.slice(4, 12)}</option>)}
              </select>
            </div>
            {!runId ? <p className="subtle" style={{ marginTop: "0.5rem" }}>Pick a run to see its verdict for this item next to the evidence.</p> :
              task.isLoading ? <span className="spinner" /> : task.isError ? <ErrorBox error={task.error} /> : !task.data?.final ? (
                <p className="muted">This item has not been finalized in that run ({task.data?.attempts.length ?? 0} attempts so far).</p>
              ) : !task.data.final.has_response ? (
                <Banner tone="danger" title={`Missing prediction (${task.data.final.final_class?.replace(/_/g, " ")})`}>
                  No response was obtained; the canonical score counts this item as an error for its gold class.
                </Banner>
              ) : (
                <div className="stack" style={{ marginTop: "0.5rem" }}>
                  <div className="row">
                    {verdict?.binary_valid ? <StatusBadge status={verdict.success ? "ok" : "missing"} label={verdict.success ? "judged successful" : "judged unsuccessful"} /> :
                      <StatusBadge status="invalid" label={`invalid verdict (${verdict?.success_raw_type ?? "no JSON"})`} />}
                    {verdict?.mistake_type_native ? <span className="badge">{verdict.mistake_type_native}</span> : null}
                    {verdict?.confidence ? <span className="badge">confidence: {verdict.confidence}</span> : null}
                    <span className="subtle">attempt {sel?.attempt_no} of {task.data.attempts.length}</span>
                  </div>
                  {verdict?.reasoning ? <p>{verdict.reasoning}</p> : null}
                  {evidence.size ? (
                    <div className="chip-row" aria-label="Steps cited in the reasoning">
                      {[...evidence].map((i) => <button key={i} className="ghost" onClick={() => select(i)}>Step {i}</button>)}
                    </div>
                  ) : <p className="subtle">The verdict cites no step numbers; the official output contract has no step-citation field.</p>}
                  <Link to={`/runs/${runId}?task=${ex.example_id}`} className="subtle">Attempt history and raw output →</Link>
                </div>
              )}
          </div>
        </div>
      </div>
      <details className="repro">
        <summary>Reproducibility details</summary>
        <div style={{ marginTop: "0.75rem" }}>
          <KV rows={[
            ["Example id", <code key="e">{ex.example_id}</code>], ["Recording id", <code key="r">{ex.recording_id}</code>],
            ["Instruction id", <code key="i">{ex.instruction_id}</code>], ["Dataset version", <code key="d">{ex.dataset_version_id}</code>],
            ["Duration", ex.meta.duration_ms ? `${Math.round(ex.meta.duration_ms).toLocaleString()} ms` : "—"],
            ["Video", "no video artifact in this release; navigation uses recorded step timestamps"],
          ]} />
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button onClick={() => setRepro(repro === "markdown" ? "" : "markdown")} disabled={!ex.has_markdown}>Released Markdown (judge input)</button>
            <button onClick={() => setRepro(repro === "json" ? "" : "json")} disabled={!ex.has_json}>Released JSON</button>
          </div>
          {repro ? (released.isLoading ? <Loading /> : released.isError ? <ErrorBox error={released.error} /> :
            <pre className="block" style={{ marginTop: "0.75rem" }}>{released.data}</pre>) : null}
          <p className="subtle">Shown as plain text exactly as released (never rendered as HTML).</p>
        </div>
      </details>
    </>
  );
}
