import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtInt, type DatasetDetail, type DatasetSummary } from "../api";
import { Banner, C, Empty, ErrorBox, Loading, Meter, Stat, StatusBadge, SyntheticBanner } from "../components/ui";

interface SourcesResp {
  lock_generated_at: string;
  sources: { source_id: string; citation: string; kind: string; status: string; title: string; role: string; resolved_revision: string | null; license: string | null; last_access: { outcome: string; url: string; detail: string; at: string } | null }[];
  availability: { counts: Record<string, number>; artifacts: { artifact_id: string; name: string; status: string; detail: string; benchmark: string; needed_for: string[] | string }[] };
}

export function CoveragePage() {
  const [sp, setSp] = useSearchParams();
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.get<{ datasets: DatasetSummary[] }>("/api/datasets") });
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.get<SourcesResp>("/api/sources") });
  const list = datasets.data?.datasets ?? [];
  const dv = sp.get("dv") ?? list.find((d) => !d.synthetic)?.dataset_version_id ?? list[0]?.dataset_version_id;
  const detail = useQuery({
    queryKey: ["dataset", dv], enabled: !!dv,
    queryFn: () => api.get<DatasetDetail>(`/api/datasets/${encodeURIComponent(dv!)}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data coverage</h1>
          <p className="muted">What is ingested, which membership governs scoring, and what is still missing — with provenance.</p>
        </div>
        {list.length > 0 ? (
          <label className="field" style={{ minWidth: 280 }}>
            Dataset version
            <select value={dv} onChange={(e) => setSp({ dv: e.target.value })}>
              {list.map((d) => (
                <option key={d.dataset_version_id} value={d.dataset_version_id}>
                  {d.dataset_version_id}{d.synthetic ? " (synthetic fixture)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {datasets.isLoading ? <Loading /> : datasets.isError ? <ErrorBox error={datasets.error} /> : list.length === 0 ? (
        <div className="card">
          <Empty title="No dataset version has been ingested">
            The official AgentHorizon release is hosted on Hugging Face. If this environment cannot reach it (see the source table
            below), operators can ingest a local mirror from <Link to="/admin">Operations</Link>.
          </Empty>
        </div>
      ) : detail.isLoading ? <Loading /> : detail.isError ? <ErrorBox error={detail.error} /> : detail.data ? (
        <DatasetCoverage d={detail.data} />
      ) : null}

      <h2 style={{ marginTop: "2rem" }}>Sources and provenance</h2>
      {sources.isLoading ? <Loading /> : sources.isError ? <ErrorBox error={sources.error} /> : sources.data ? <Sources s={sources.data} /> : null}
    </>
  );
}

const CHECK_TONE: Record<string, string> = { pass: "ok", fail: "failed", warn: "unverified", not_evaluable: "not_applicable", not_applicable: "not_applicable" };

function DatasetCoverage({ d }: { d: DatasetDetail }) {
  const rev = d.membership_status.revised_paper_partition;
  const legacy = d.manifests.filter((m) => m.partition === "legacy-submitted");
  const mat = d.counts.screenshots_materialized;
  const media = d.media_by_status;
  return (
    <>
      <SyntheticBanner show={d.synthetic} />
      <div className="grid grid-2">
        <div className="card" aria-labelledby="rev-h">
          <div className="spread"><h2 id="rev-h">Revised paper partition</h2><StatusBadge status={rev.status} /></div>
          <p className="muted">{rev.note}.</p>
          {rev.status !== "acquired" ? (
            <Banner tone="danger" title="Exact reproduction of the paper's AH / AH-S tables is blocked">
              The three-splitter membership (AH, AH-S, AH-D) was not located in any accessible release. Scores on the legacy
              partition are reported separately and are never relabelled as the paper partition.
            </Banner>
          ) : null}
          {rev.detail ? <p className="subtle">{rev.detail}</p> : null}
        </div>
        <div className="card" aria-labelledby="leg-h">
          <div className="spread"><h2 id="leg-h">Legacy partition</h2>
            <StatusBadge status={d.membership_status.legacy_partition.present ? "acquired" : "not_located"} label={d.membership_status.legacy_partition.present ? "present" : "absent"} />
          </div>
          <p className="muted">{d.membership_status.legacy_partition.note}.</p>
          {legacy.map((m) => (
            <div key={m.manifest_id} className="spread" style={{ padding: "0.3rem 0" }}>
              <span>{m.name}</span>
              <span className="row"><span className="badge">{m.n_items} items</span>
                <Link to={`/explore/${encodeURIComponent(d.dataset_version_id)}?manifest=${encodeURIComponent(m.manifest_id)}`}>Explore</Link></span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="grid grid-4">
          <Stat value={fmtInt(d.counts.examples)} label="evaluation examples" />
          <Stat value={fmtInt(d.counts.steps_total)} label="steps (all examples)" />
          <Stat value={fmtInt(d.counts.max_steps)} label="longest trajectory (steps)" />
          <Stat value={`${d.validation.errors ?? 0} / ${d.validation.warnings ?? 0}`} label="validation errors / warnings" />
        </div>
        <hr className="sep" />
        <h3>Screenshot coverage</h3>
        <Meter ariaLabel="screenshot materialization" total={d.counts.screenshots} segments={[
          { label: "materialized", value: mat, color: C.ok },
          { label: "pending", value: Math.max(0, d.counts.screenshots - mat - (media.failed ?? 0) - (media.quarantined ?? 0)), color: C.neutral },
          { label: "failed / quarantined", value: (media.failed ?? 0) + (media.quarantined ?? 0), color: C.danger },
        ]} />
        <p className="subtle" style={{ marginTop: "0.5rem" }}>
          Metadata is fully explorable while media is materialized lazily. Judging an item requires every one of its screenshots.
        </p>
      </div>

      <h2 style={{ marginTop: "1.5rem" }}>Manifests</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Manifest</th><th>Partition</th><th>Role</th><th>Official</th><th className="num">Items</th><th>Digest</th><th /></tr></thead>
          <tbody>
            {d.manifests.map((m) => (
              <tr key={m.manifest_id}>
                <td><strong>{m.name}</strong><div className="subtle mono">{m.manifest_id}</div></td>
                <td><span className={`badge ${m.partition === "legacy-submitted" ? "warn" : m.partition === "full-release" ? "info" : ""}`}>{m.partition}</span></td>
                <td>{m.role}</td>
                <td>{m.official ? <span className="badge ok">official</span> : <span className="badge">not official</span>}</td>
                <td className="num">{m.n_items.toLocaleString()}</td>
                <td className="mono subtle">{m.digest.slice(0, 12)}</td>
                <td><Link to={`/explore/${encodeURIComponent(d.dataset_version_id)}?manifest=${encodeURIComponent(m.manifest_id)}`}>Explore</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="repro">
        <summary>Validation checks ({d.validation.checks.length}) and reconciliation</summary>
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead><tr><th>Check</th><th>Status</th><th className="num">Count</th></tr></thead>
            <tbody>
              {d.validation.checks.map((c) => (
                <tr key={c.check}><td>{c.check}</td><td><StatusBadge status={CHECK_TONE[c.status] ?? c.status} label={c.status.replace(/_/g, " ")} /></td><td className="num">{c.count ?? ""}</td></tr>
              ))}
              {(d.reconciliation?.checks ?? []).map((c) => (
                <tr key={`r-${c.check}`}><td>reconcile: {c.check}</td><td><StatusBadge status={CHECK_TONE[c.status] ?? c.status} label={c.status.replace(/_/g, " ")} /></td><td /></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function Sources({ s }: { s: SourcesResp }) {
  const counts = s.availability?.counts ?? {};
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ref</th><th>Source</th><th>Status</th><th>Pinned revision</th><th>Licence</th><th>Last access</th></tr></thead>
          <tbody>
            {s.sources.map((x) => (
              <tr key={x.source_id + x.citation}>
                <td className="mono">{x.citation}</td>
                <td><strong>{x.title ?? x.source_id}</strong><div className="subtle">{x.role}</div></td>
                <td><StatusBadge status={x.status} /></td>
                <td className="mono">{x.resolved_revision ? x.resolved_revision.slice(0, 12) : "—"}</td>
                <td>{x.license ?? "—"}</td>
                <td className="subtle">{x.last_access ? <>{x.last_access.outcome.replace(/_/g, " ")}<div title={x.last_access.detail}>{x.last_access.at}</div></> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ marginTop: "1.25rem" }}>Artifact availability</h3>
      <div className="chip-row" style={{ marginBottom: "0.6rem" }}>
        {Object.entries(counts).map(([k, v]) => <StatusBadge key={k} status={k} label={`${k.replace(/_/g, " ")}: ${v}`} />)}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Artifact</th><th>Benchmark</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {(s.availability?.artifacts ?? []).map((a) => (
              <tr key={a.artifact_id}>
                <td><strong>{a.name}</strong><div className="subtle mono">{a.artifact_id}</div></td>
                <td>{a.benchmark}</td>
                <td><StatusBadge status={a.status} /></td>
                <td className="subtle">{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
