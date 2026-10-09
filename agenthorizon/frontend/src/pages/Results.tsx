import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtFrac, fmtPct, type Frac, type Page, type RefTable, type RunRow, type ScoreReport } from "../api";
import { Banner, Empty, ErrorBox, Loading, resultKindBadge, Tabs, useCan } from "../components/ui";

interface CompareResp {
  runs: { run_id: string; label: string | null; status: string; result_kind: string; config_id: string; dataset_version_id: string;
    score: { score_id: number; manifest_id: string; report: ScoreReport } | null; differences_from_first: { field: string; a: unknown; b: unknown }[] }[];
  note: string;
}
interface Judge { config_id: string; model_display: string; interface_label: string }

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CAT_LABEL: Record<string, string> = {
  critical_mistake: "Critical Mistake", bad_side_effect: "Bad Side Effect",
  misunderstanding_of_the_instruction: "Misunderstanding of the Instruction", aggregate_typed_micro: "MT aggregate (typed, micro)",
};

export function ResultsPage() {
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState<"compare" | "reference">("compare");
  const selected = (sp.get("runs") ?? "").split(",").filter(Boolean);
  const runs = useQuery({ queryKey: ["runs-list"], queryFn: () => api.get<Page<RunRow>>("/api/runs?limit=200") });
  const cmp = useQuery({ queryKey: ["compare", selected], enabled: selected.length > 0, queryFn: () => api.get<CompareResp>(`/api/compare?runs=${selected.join(",")}`) });
  const ref = useQuery({ queryKey: ["reference"], queryFn: () => api.get<{ tables: RefTable[]; warning: string }>("/api/reference") });
  const judges = useQuery({ queryKey: ["judges"], queryFn: () => api.get<{ configs: Judge[] }>("/api/judges") });
  const [showMismatched, setShowMismatched] = useState(false);

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setSp(next.length ? { runs: next.join(",") } : {});
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Results and comparison</h1>
          <p className="muted">Class-specific correctness, balanced accuracy with exact denominators, invalid and missing outputs, and exact failure-category recall.</p></div>
      </div>
      <Tabs tabs={[{ id: "compare", label: "Run scores" }, { id: "reference", label: "Paper-reported tables" }]} value={tab} onChange={setTab} />
      {tab === "reference" ? (ref.isLoading ? <Loading /> : ref.isError ? <ErrorBox error={ref.error} /> : <ReferenceTables tables={ref.data!.tables} warning={ref.data!.warning} />) : (
        <>
          <div className="card">
            <h3>Runs</h3>
            {runs.isLoading ? <Loading /> : (runs.data?.items ?? []).length === 0 ? <Empty title="No runs to compare yet" /> : (
              <div className="chip-row">
                {runs.data!.items.map((r) => (
                  <label key={r.run_id} className="check badge" style={{ padding: "0.3rem 0.6rem" }}>
                    <input type="checkbox" checked={selected.includes(r.run_id)} onChange={() => toggle(r.run_id)} />
                    {r.label ?? r.config_id} <span className="mono">{r.run_id.slice(4, 10)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {selected.length === 0 ? null : cmp.isLoading ? <Loading /> : cmp.isError ? <ErrorBox error={cmp.error} /> : (
            <Comparison data={cmp.data!} refTables={ref.data?.tables ?? []} judges={judges.data?.configs ?? []}
              showMismatched={showMismatched} setShowMismatched={setShowMismatched} />
          )}
        </>
      )}
    </>
  );
}

function Comparison({ data, refTables, judges, showMismatched, setShowMismatched }: {
  data: CompareResp; refTables: RefTable[]; judges: Judge[]; showMismatched: boolean; setShowMismatched: (b: boolean) => void;
}) {
  const shown = data.runs.filter((r, i) => i === 0 || showMismatched || r.differences_from_first.length === 0);
  const hidden = data.runs.length - shown.length;
  const t1 = refTables.find((t) => t.table_id === "S8.T1");
  const canLabels = useCan("research.labels");
  const refRow = (configId: string) => {
    const j = judges.find((x) => x.config_id === configId);
    return j && t1 ? t1.rows.find((row) => row.model === j.model_display && row.interface === j.interface_label) : undefined;
  };
  const rows: { label: string; get: (r: ScoreReport) => string; ref?: (row: Record<string, unknown>) => string }[] = [
    { label: "Balanced accuracy", get: (r) => `${fmtPct(r.metrics.balanced_accuracy)}`, ref: (x) => `${x.balanced_accuracy_pct}%` },
    { label: "Positive accuracy (TP / P)", get: (r) => `${fmtPct(r.metrics.positive_accuracy)} (${fmtFrac(r.metrics.positive_accuracy)})`, ref: (x) => `${x.positive_accuracy_pct}%` },
    { label: "Negative accuracy (TN / N)", get: (r) => `${fmtPct(r.metrics.negative_accuracy)} (${fmtFrac(r.metrics.negative_accuracy)})`, ref: (x) => `${x.negative_accuracy_pct}%` },
    { label: "Raw accuracy (secondary)", get: (r) => `${fmtPct(r.metrics.raw_accuracy_secondary)} (${fmtFrac(r.metrics.raw_accuracy_secondary)})` },
    ...Object.keys(CAT_LABEL).map((k) => ({
      label: `Exact recall: ${CAT_LABEL[k]}`,
      get: (r: ScoreReport) => { const f = r.mistake_type_recall?.[k] as Frac | undefined; return f ? `${fmtPct(f)} (${fmtFrac(f)})` : "—"; },
      ref: k === "aggregate_typed_micro" ? (x: Record<string, unknown>) => `${x.mistake_type_recall_pct}%` : undefined,
    })),
    { label: "Invalid outputs (positive / negative)", get: (r) => `${sum(r.confusion.invalid_positive)} / ${sum(r.confusion.invalid_negative)}` },
    { label: "Missing (positive / negative)", get: (r) => `${r.confusion.missing_positive} / ${r.confusion.missing_negative}` },
    { label: "Full-contract valid", get: (r) => `${r.validity.full_contract_valid} of ${r.validity.present} present` },
    { label: "Denominators P / N (typed / untyped negatives)", get: (r) => `${r.manifest.P} / ${r.manifest.N} (${r.manifest.typed_negatives} / ${r.manifest.untyped_negatives})` },
    { label: "Coverage", get: (r) => `${r.coverage.evaluated_with_valid_verdict} valid of ${r.coverage.of}${r.coverage.complete ? "" : " — incomplete"}` },
  ];
  return (
    <>
      {hidden > 0 ? (
        <Banner tone="info" title={`${hidden} run(s) hidden: their protocol differs from the first run`}>
          <label className="check"><input type="checkbox" checked={showMismatched} onChange={(e) => setShowMismatched(e.target.checked)} /> Show them anyway (differences are listed under each run)</label>
        </Banner>
      ) : null}
      <div className="table-wrap" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr><th>Metric</th>
              {shown.map((r) => (
                <th key={r.run_id} className="num">
                  <Link to={`/runs/${r.run_id}`}>{r.label ?? r.config_id}</Link><div className="mono subtle">{r.run_id.slice(0, 12)}</div>
                  <div style={{ marginTop: 4 }}>{resultKindBadge(r.result_kind)}</div>
                </th>
              ))}
              {shown.map((r) => refRow(r.config_id) ? <th key={`ref-${r.run_id}`} className="num" style={{ background: "var(--warn-soft)" }}>Paper-reported<div className="subtle">S8.T1 · legacy AH (605)</div></th> : null)}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                {shown.map((r) => <td key={r.run_id} className="num">{r.score ? m.get(r.score.report) : "not scored"}</td>)}
                {shown.map((r) => { const x = refRow(r.config_id); return x ? <td key={`ref-${r.run_id}`} className="num">{m.ref ? m.ref(x) : ""}</td> : null; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle" style={{ marginTop: "0.5rem" }}>
        Paper-reported values are author aggregates on the legacy partition, shown for orientation only. They are comparable to a run
        only when the run used the same membership (legacy AH, 605 items), the same model identifier, harness version, prompt, and
        instruction file. {data.note}
      </p>
      {shown.map((r) => (
        <div key={r.run_id} className="card">
          <div className="spread">
            <h3 style={{ margin: 0 }}>{r.label ?? r.config_id} <span className="mono subtle">{r.run_id}</span></h3>
            {r.score ? (
              <div className="row">
                <button onClick={() => download(`${r.run_id}-score.json`, JSON.stringify(r.score!.report, null, 2), "application/json")}>Score JSON</button>
                <button onClick={() => download(`${r.run_id}-score.csv`, scoreCsv(r.score!.report), "text/csv")}>Score CSV</button>
                {canLabels ? <ItemsExport scoreId={r.score.score_id} runId={r.run_id} /> : null}
              </div>
            ) : <Link to={`/runs/${r.run_id}`}>Score it from the run page</Link>}
          </div>
          {r.score?.report.warning ? <Banner tone="warn" title={r.score.report.warning} /> : null}
          {r.score ? <p className="subtle">Manifest <code>{r.score.report.manifest.id}</code> ({r.score.report.manifest.partition}, {r.score.report.manifest.official ? "official" : "not official"}) · reconciliation positives {r.score.report.confusion.reconciliation.positive}, negatives {r.score.report.confusion.reconciliation.negative} · digest {r.score.report.report_digest.slice(0, 12)}</p> : null}
          {r.score?.report.selection_subset ? (
            <Banner tone="info" title="Selection subset score (not the benchmark result)">
              Balanced accuracy {fmtPct(r.score.report.selection_subset.metrics.balanced_accuracy)} on {r.score.report.selection_subset.manifest.n_items} selected items. The canonical score above counts every unselected or unfinished item as an error.
            </Banner>
          ) : null}
          {r.differences_from_first.length ? (
            <Banner tone="warn" title="Protocol differs from the first run">
              <ul>{r.differences_from_first.map((d) => <li key={d.field}><code>{d.field}</code>: {JSON.stringify(d.a)} → {JSON.stringify(d.b)}</li>)}</ul>
            </Banner>
          ) : null}
          {canLabels && r.score ? <ItemsTable scoreId={r.score.score_id} runId={r.run_id} dv={r.dataset_version_id} /> : null}
        </div>
      ))}
    </>
  );
}

function sum(o: Record<string, number>): number { return Object.values(o ?? {}).reduce((a, b) => a + b, 0); }

function scoreCsv(r: ScoreReport): string {
  const lines = [["metric", "numerator", "denominator", "value"].join(",")];
  for (const [k, f] of Object.entries(r.metrics)) lines.push([k, f.numerator ?? "", f.denominator ?? "", f.value ?? ""].join(","));
  for (const [k, f] of Object.entries(r.mistake_type_recall ?? {})) lines.push([`mt_recall:${k}`, f.numerator ?? "", f.denominator ?? "", f.value ?? ""].join(","));
  for (const [k, v] of Object.entries(r.confusion)) if (typeof v === "number") lines.push([`confusion:${k}`, v, "", ""].join(","));
  return lines.join("\n") + "\n";
}

interface ItemRow { example_id: string; outcome: string; label: string | null; mistake_type_native: string | null; instruction: string; n_steps: number }

function ItemsExport({ scoreId, runId }: { scoreId: number; runId: string }) {
  return <button onClick={async () => {
    const d = await api.get<{ items: ItemRow[] }>(`/api/research/scores/${scoreId}/items`);
    download(`${runId}-items.jsonl`, d.items.map((x) => JSON.stringify(x)).join("\n") + "\n", "application/x-ndjson");
  }}>Per-item JSONL (labels)</button>;
}

function ItemsTable({ scoreId, runId, dv }: { scoreId: number; runId: string; dv: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const q = useQuery({ queryKey: ["items", scoreId], enabled: open, queryFn: () => api.get<{ items: ItemRow[] }>(`/api/research/scores/${scoreId}/items`) });
  const outcomes = useMemo(() => [...new Set((q.data?.items ?? []).map((i) => i.outcome))].sort(), [q.data]);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: "0.5rem" }}>
      <summary className="subtle">Per-task drill-down (privileged: shows gold labels; access is audited)</summary>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : q.data ? (
        <>
          <select aria-label="Outcome filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: "0.5rem 0" }}>
            <option value="">All outcomes</option>{outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
            <table><thead><tr><th>Example</th><th>Gold</th><th>Outcome</th><th className="num">Steps</th></tr></thead>
              <tbody>{q.data.items.filter((i) => !filter || i.outcome === filter).map((i) => (
                <tr key={i.example_id}>
                  <td><Link to={`/explore/${encodeURIComponent(dv)}/${i.example_id}?run=${runId}`}>{i.instruction.slice(0, 90)}</Link><div className="mono subtle">{i.example_id}</div></td>
                  <td>{i.label}{i.label === "negative" ? <div className="subtle">{i.mistake_type_native ?? "untyped"}</div> : null}</td>
                  <td className="mono">{i.outcome}</td><td className="num">{i.n_steps}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </>
      ) : null}
    </details>
  );
}

function ReferenceTables({ tables, warning }: { tables: RefTable[]; warning: string }) {
  if (!tables.length) return <Empty title="No reference tables captured" />;
  return (
    <>
      <Banner tone="warn" title="Author-reported aggregates (re-rendered, not new measurements)">{warning}</Banner>
      {tables.map((t) => (
        <div key={t.table_id} className="card">
          <h3>{t.table_id} · {t.title}</h3>
          <p className="subtle">{Object.values(t.scope ?? {}).join(" · ")} — source {String(t.provenance.path)}@{String(t.provenance.revision).slice(0, 8)} lines {JSON.stringify(t.provenance.lines)}</p>
          <div className="table-wrap"><table>
            <thead><tr>{t.columns.map((c) => <th key={c} className={c === "model" || c === "interface" ? "" : "num"}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
            <tbody>{t.rows.map((r, i) => <tr key={i}>{t.columns.map((c) => <td key={c} className={c === "model" || c === "interface" ? "" : "num"}>{r[c] === null || r[c] === undefined ? "—" : String(r[c])}</td>)}</tr>)}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
