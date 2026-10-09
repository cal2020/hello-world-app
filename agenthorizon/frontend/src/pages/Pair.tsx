import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type ExampleDetail } from "../api";
import { Banner, Empty, ErrorBox, Loading, SyntheticBanner, useCan } from "../components/ui";

interface Member { example_id: string; instruction: string; label: string | null; mistake_type_native: string | null; recording_id: string | null; component_id: string | null; self: boolean }
interface ResearchResp { example_id: string; gold: { label: string; mistake_type_native: string | null; category: string | null } | null; group: Member[]; group_available: boolean; note: string }

/** Word-level LCS diff of two instructions (display only). */
function wordDiff(a: string, b: string): { t: string; k: "same" | "del" | "add" }[] {
  const x = a.split(/(\s+)/), y = b.split(/(\s+)/);
  const m = x.length, n = y.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: string; k: "same" | "del" | "add" }[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push({ t: x[i], k: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: x[i++], k: "del" });
    else out.push({ t: y[j++], k: "add" });
  }
  while (i < m) out.push({ t: x[i++], k: "del" });
  while (j < n) out.push({ t: y[j++], k: "add" });
  return out;
}

export function PairPage() {
  const { dv = "", eid = "" } = useParams();
  const can = useCan("research.labels");
  const ex = useQuery({ queryKey: ["example", dv, eid], queryFn: () => api.get<ExampleDetail>(`/api/datasets/${encodeURIComponent(dv)}/examples/${eid}`) });
  const r = useQuery({
    queryKey: ["research", dv, eid], enabled: can,
    queryFn: () => api.get<ResearchResp>(`/api/research/datasets/${encodeURIComponent(dv)}/examples/${eid}`),
  });
  if (!can) return <Banner tone="danger" title="Not permitted">Pair inspection is a privileged research view.</Banner>;
  if (ex.isLoading || r.isLoading) return <Loading />;
  if (ex.isError) return <ErrorBox error={ex.error} />;
  if (r.isError) return <ErrorBox error={r.error} />;
  const d = r.data!;
  const me = ex.data!;
  const others = d.group.filter((g) => !g.self);
  return (
    <>
      <SyntheticBanner show={me.synthetic} />
      <Banner tone="warn" title="Privileged research view — audited">
        Gold labels and counterpart instructions are shown here. This view is never available to judges, and must not be used
        while reviewing blind.
      </Banner>
      <div className="page-head">
        <div>
          <div className="subtle"><Link to={`/explore/${encodeURIComponent(dv)}/${eid}`}>← Back to the trajectory</Link></div>
          <h1>Pair inspection</h1>
        </div>
      </div>
      <div className="card">
        <h3>This example</h3>
        <p>{me.instruction}</p>
        <div className="row">
          {d.gold ? <span className={`badge ${d.gold.label === "positive" ? "ok" : "danger"}`}>gold: {d.gold.label}</span> : <span className="badge">no gold label</span>}
          {d.gold?.label === "negative" ? <span className="badge">{d.gold.mistake_type_native ?? "untyped negative"}</span> : null}
          <span className="subtle mono">{me.recording_id}</span>
        </div>
      </div>
      {!d.group_available || others.length === 0 ? (
        <div className="card"><Empty title="Pair mapping unavailable">
          No counterpart is recorded for this example in the release's label grouping or shared recordings. Pairs are never inferred from
          text or screenshot similarity.
        </Empty></div>
      ) : others.map((o) => (
        <div className="card" key={o.example_id}>
          <div className="spread">
            <h3 style={{ margin: 0 }}>Counterpart <span className="mono subtle">{o.example_id.slice(0, 8)}</span></h3>
            <div className="row">
              {o.label ? <span className={`badge ${o.label === "positive" ? "ok" : "danger"}`}>gold: {o.label}</span> : null}
              {o.label === "negative" ? <span className="badge">{o.mistake_type_native ?? "untyped negative"}</span> : null}
              <span className="badge info">{o.recording_id && o.recording_id === me.recording_id ? "same recording (identical screenshots)" : "label-pair group"}</span>
            </div>
          </div>
          <p style={{ marginTop: "0.6rem" }} aria-label="Instruction difference">
            {wordDiff(me.instruction, o.instruction).map((p, i) => (
              <span key={i} className={p.k === "del" ? "diff-del" : p.k === "add" ? "diff-add" : undefined}>{p.t}</span>
            ))}
          </p>
          <p className="subtle">Struck-through words appear only in this example; highlighted words only in the counterpart.</p>
          <Link to={`/explore/${encodeURIComponent(dv)}/${o.example_id}`}>Open counterpart trajectory →</Link>
        </div>
      ))}
      <p className="subtle">{d.note}</p>
    </>
  );
}
