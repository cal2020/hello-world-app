import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type DatasetDetail, type DatasetSummary, type ExampleDetail } from "../api";
import { ScreenshotViewer, Timeline, useStepWindows } from "../components/trajectory";
import { Banner, Empty, ErrorBox, KV, Loading, Stat, SyntheticBanner, useCan } from "../components/ui";

const MISTAKES = ["Critical Mistake", "Bad Side Effect", "Misunderstanding of the Instruction"];
interface Annotation { annotation_id: number; phase: string; success: boolean | null; mistake_type_native: string | null; rationale: string; evidence_steps: number[]; proposed_correction: Record<string, unknown> | null; rubric_revision: string; created_at: string }
interface ReviewState { example_id: string; my_annotations: Annotation[]; revealed: boolean; reveal: RevealResp | null; rubric_revision: string }
interface RevealResp { gold: { label: string; mistake_type_native: string | null } | null; group: { example_id: string; instruction: string; label: string | null; self: boolean }[]; blind_verdict_agrees_with_gold?: boolean | null }

export function ReviewPage() {
  const { dv, eid } = useParams();
  return dv && eid ? <ReviewItem dv={dv} eid={eid} /> : <ReviewQueue />;
}

function ReviewQueue() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const canExport = useCan("review.export");
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.get<{ datasets: DatasetSummary[] }>("/api/datasets") });
  const list = datasets.data?.datasets ?? [];
  const dv = sp.get("dv") ?? list.find((d) => !d.synthetic)?.dataset_version_id ?? list[0]?.dataset_version_id ?? "";
  const manifest = sp.get("manifest") ?? "";
  const detail = useQuery({ queryKey: ["dataset", dv], enabled: !!dv, queryFn: () => api.get<DatasetDetail>(`/api/datasets/${encodeURIComponent(dv)}`) });
  const queue = useQuery({ queryKey: ["review-queue", dv, manifest], enabled: !!dv, queryFn: () => api.get<{ items: { example_id: string; instruction: string; n_steps: number }[] }>(`/api/reviews/queue?dv=${encodeURIComponent(dv)}&limit=50${manifest ? `&manifest=${encodeURIComponent(manifest)}` : ""}`) });
  const stats = useQuery({ queryKey: ["review-stats", dv], enabled: !!dv, queryFn: () => api.get<{ items_with_blind_verdicts: number; items_with_independent_blind_verdicts: number; pairwise_agreement: number | null; pairs: number; note: string }>(`/api/reviews/stats?dv=${encodeURIComponent(dv)}`) });

  if (datasets.isLoading) return <Loading />;
  if (!dv) return <div className="card"><Empty title="No dataset version indexed" /></div>;
  return (
    <>
      <div className="page-head">
        <div><h1>Human review</h1><p className="muted">Blind review first; reveal the gold label afterwards. Corrections are proposals in a separate annotation layer.</p></div>
        <div className="row">
          <label className="field">Dataset<select value={dv} onChange={(e) => setSp({ dv: e.target.value })}>{list.map((d) => <option key={d.dataset_version_id} value={d.dataset_version_id}>{d.dataset_version_id}</option>)}</select></label>
          <label className="field">Manifest<select value={manifest} onChange={(e) => setSp({ dv, ...(e.target.value ? { manifest: e.target.value } : {}) })}>
            <option value="">All</option>{(detail.data?.manifests ?? []).map((m) => <option key={m.manifest_id} value={m.manifest_id}>{m.name}</option>)}</select></label>
        </div>
      </div>
      <SyntheticBanner show={!!detail.data?.synthetic} />
      <div className="card">
        <div className="grid grid-3">
          <Stat value={stats.data?.items_with_blind_verdicts ?? "—"} label="items with blind verdicts" />
          <Stat value={stats.data?.items_with_independent_blind_verdicts ?? "—"} label="items with ≥ 2 independent reviewers" />
          <Stat value={stats.data?.pairwise_agreement === null || stats.data?.pairwise_agreement === undefined ? "not computed" : `${(stats.data.pairwise_agreement * 100).toFixed(1)}%`} label="pairwise agreement" hint={stats.data?.note} />
        </div>
        <p className="subtle" style={{ marginTop: "0.5rem" }}>{stats.data?.note}</p>
        {canExport ? <div className="row">
          <a className="btn" href={`/api/reviews/export?dv=${encodeURIComponent(dv)}&format=jsonl`}>Export JSONL</a>
          <a className="btn" href={`/api/reviews/export?dv=${encodeURIComponent(dv)}&format=csv`}>Export CSV</a>
        </div> : null}
      </div>
      <h2 style={{ marginTop: "1.25rem" }}>Your queue</h2>
      {queue.isLoading ? <Loading /> : queue.isError ? <ErrorBox error={queue.error} /> : (queue.data?.items ?? []).length === 0 ? (
        <div className="card"><Empty title="Nothing left to review here" /></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Instruction</th><th className="num">Steps</th></tr></thead>
          <tbody>{queue.data!.items.map((i) => (
            <tr key={i.example_id} className="clickable" onClick={() => navigate(`/review/${encodeURIComponent(dv)}/${i.example_id}`)}>
              <td><Link to={`/review/${encodeURIComponent(dv)}/${i.example_id}`}>{i.instruction}</Link></td><td className="num">{i.n_steps}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

function ReviewItem({ dv, eid }: { dv: string; eid: string }) {
  const qc = useQueryClient();
  const ex = useQuery({ queryKey: ["example", dv, eid], queryFn: () => api.get<ExampleDetail>(`/api/datasets/${encodeURIComponent(dv)}/examples/${eid}`) });
  const st = useQuery({ queryKey: ["review", dv, eid], queryFn: () => api.get<ReviewState>(`/api/reviews/${encodeURIComponent(dv)}/${eid}`) });
  const rubric = useQuery({ queryKey: ["rubric"], queryFn: () => api.get<{ rubric_revision: string; text: string }>("/api/reviews/rubric") });
  const [step, setStep] = useState(0);
  const [success, setSuccess] = useState<"" | "true" | "false">("");
  const [mistake, setMistake] = useState("");
  const [rationale, setRationale] = useState("");
  const [evidence, setEvidence] = useState<number[]>([]);
  const [correction, setCorrection] = useState({ label: "", why: "" });
  const n = ex.data?.n_steps ?? 0;
  const { byIdx } = useStepWindows(dv, eid, n, [step]);
  const done = () => { qc.invalidateQueries({ queryKey: ["review", dv, eid] }); qc.invalidateQueries({ queryKey: ["review-stats", dv] }); qc.invalidateQueries({ queryKey: ["review-queue"] }); };
  const submit = useMutation({
    mutationFn: () => api.post(`/api/reviews/${encodeURIComponent(dv)}/${eid}`, {
      success: success === "" ? null : success === "true", mistake_type_native: success === "false" && mistake ? mistake : null,
      rationale, evidence_steps: evidence, rubric_revision: rubric.data?.rubric_revision ?? st.data?.rubric_revision,
    }),
    onSuccess: done,
  });
  const reveal = useMutation({ mutationFn: () => api.post<RevealResp>(`/api/reviews/${encodeURIComponent(dv)}/${eid}/reveal`), onSuccess: done });
  const correct = useMutation({
    mutationFn: () => api.post(`/api/reviews/${encodeURIComponent(dv)}/${eid}`, { rationale: correction.why, rubric_revision: rubric.data?.rubric_revision, proposed_correction: correction }),
    onSuccess: done,
  });

  if (ex.isLoading || st.isLoading) return <Loading />;
  if (ex.isError) return <ErrorBox error={ex.error} />;
  if (st.isError) return <ErrorBox error={st.error} />;
  const s = st.data!;
  const e = ex.data!;
  const hasBlind = s.my_annotations.some((a) => a.phase === "blind");
  const rv = s.reveal ?? reveal.data ?? null;
  return (
    <>
      <SyntheticBanner show={e.synthetic} />
      <div className="subtle"><Link to={`/review?dv=${encodeURIComponent(dv)}`}>Review queue</Link> / {eid}</div>
      <h1 style={{ marginTop: "0.3rem" }}>{e.instruction}</h1>
      {!s.revealed ? <Banner tone="info" title="Blind phase">Labels, failure categories, and counterpart instructions are hidden until you record a verdict.</Banner> : null}
      <div className="inspect">
        <Timeline dv={dv} eid={eid} nSteps={n} selected={step} onSelect={setStep} evidence={new Set(evidence)} firstTs={e.timing.first_us} />
        <div className="stack">
          <ScreenshotViewer step={byIdx.get(step)} />
          <div className="card">
            <h3>{s.revealed ? "Post-reveal annotation" : "Your blind verdict"}</h3>
            <form className="stack" onSubmit={(ev) => { ev.preventDefault(); submit.mutate(); }}>
              <fieldset style={{ margin: 0 }}><legend>Did the recorded workflow accomplish the instruction?</legend>
                <div className="row">
                  <label className="check"><input type="radio" name="succ" checked={success === "true"} onChange={() => setSuccess("true")} /> Success</label>
                  <label className="check"><input type="radio" name="succ" checked={success === "false"} onChange={() => setSuccess("false")} /> Failure</label>
                  <label className="check"><input type="radio" name="succ" checked={success === ""} onChange={() => setSuccess("")} /> Cannot decide</label>
                </div>
              </fieldset>
              {success === "false" ? (
                <label className="field">Failure category (rubric)
                  <select value={mistake} onChange={(ev) => setMistake(ev.target.value)}><option value="">Choose…</option>{MISTAKES.map((m) => <option key={m}>{m}</option>)}</select>
                </label>
              ) : null}
              <label className="field">Rationale (cite evidence)<textarea value={rationale} onChange={(ev) => setRationale(ev.target.value)} required minLength={3} /></label>
              <div className="row">
                <button type="button" onClick={() => setEvidence((xs) => (xs.includes(step) ? xs : [...xs, step].sort((a, b) => a - b)))}>Cite current step ({step})</button>
                {evidence.map((i) => <button type="button" key={i} className="ghost" onClick={() => setEvidence((xs) => xs.filter((x) => x !== i))} aria-label={`Remove step ${i}`}>Step {i} ✕</button>)}
              </div>
              <div className="row">
                <button type="submit" className="primary" disabled={submit.isPending || rationale.trim().length < 3 || (success === "false" && !mistake)}>Save annotation</button>
                <span className="subtle">Rubric {rubric.data?.rubric_revision}</span>
              </div>
              {submit.isError ? <ErrorBox error={submit.error} /> : null}
            </form>
          </div>
          {s.my_annotations.length ? (
            <div className="card">
              <h3>Your annotations</h3>
              {s.my_annotations.map((a) => (
                <div key={a.annotation_id} className="subtle" style={{ borderTop: "1px solid var(--border)", padding: "0.4rem 0" }}>
                  #{a.annotation_id} · {a.phase} · {a.success === null ? "undecided" : a.success ? "success" : `failure${a.mistake_type_native ? ` (${a.mistake_type_native})` : ""}`}
                  {a.evidence_steps.length ? ` · steps ${a.evidence_steps.join(", ")}` : ""}{a.proposed_correction ? ` · proposes ${JSON.stringify(a.proposed_correction)}` : ""}
                  <div>{a.rationale}</div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="card">
            <h3>Reveal</h3>
            {!s.revealed ? (
              <>
                <p className="muted">Reveal is recorded in the audit log and is only possible after your blind verdict.</p>
                <button onClick={() => reveal.mutate()} disabled={!hasBlind || reveal.isPending}>Reveal gold label and pair evidence</button>
                {reveal.isError ? <ErrorBox error={reveal.error} /> : null}
              </>
            ) : rv ? (
              <>
                <KV rows={[
                  ["Gold label", rv.gold ? `${rv.gold.label}${rv.gold.label === "negative" ? ` · ${rv.gold.mistake_type_native ?? "untyped"}` : ""}` : "unavailable"],
                  ...(rv.blind_verdict_agrees_with_gold !== undefined && rv.blind_verdict_agrees_with_gold !== null ? [["Your blind verdict", rv.blind_verdict_agrees_with_gold ? "agrees" : "disagrees"] as [string, string]] : []),
                ]} />
                {rv.group.filter((g) => !g.self).length ? (
                  <><h3 style={{ marginTop: "0.75rem" }}>Counterparts</h3>
                    <ul>{rv.group.filter((g) => !g.self).map((g) => <li key={g.example_id}>{g.instruction} <span className="badge">{g.label}</span></li>)}</ul></>
                ) : <p className="subtle">No counterpart recorded for this example.</p>}
                <form className="stack" onSubmit={(ev) => { ev.preventDefault(); correct.mutate(); }} style={{ marginTop: "0.75rem" }}>
                  <h3>Propose a correction (never edits the official label)</h3>
                  <label className="field">Proposed label<select value={correction.label} onChange={(ev) => setCorrection({ ...correction, label: ev.target.value })}><option value="">Choose…</option><option value="positive">positive</option><option value="negative">negative</option></select></label>
                  <label className="field">Why<textarea value={correction.why} onChange={(ev) => setCorrection({ ...correction, why: ev.target.value })} /></label>
                  <button type="submit" disabled={!correction.label || correction.why.trim().length < 3 || correct.isPending}>Record proposal</button>
                  {correct.isError ? <ErrorBox error={correct.error} /> : null}
                </form>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <details className="repro"><summary>Released rubric ({rubric.data?.rubric_revision})</summary><pre className="block">{rubric.data?.text}</pre></details>
    </>
  );
}
