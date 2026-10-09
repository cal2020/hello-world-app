import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetSummary } from "../api";
import { Banner, ErrorBox, Loading, StatusBadge, Tabs, useCan } from "../components/ui";

interface Job { job_id: number; queue: string; kind: string; status: string; attempts: number; max_attempts: number; lease_owner: string | null; last_error: string | null; created_by: string | null; created_at: string; finished_at: string | null; result: Record<string, unknown> | null }
interface Worker { worker_id: string; queue: string; info: { credentials?: string[]; harness?: Record<string, { version: string | null }>; isolation?: { ok: boolean; detail: string } }; last_seen: string }
interface Audit { id: number; at: string; actor: string | null; role: string | null; action: string; target: string | null; detail: Record<string, unknown> }

export function AdminPage() {
  const can = useCan("jobs.admin");
  const [tab, setTab] = useState<"data" | "jobs" | "workers" | "audit" | "users">("data");
  if (!can) return <Banner tone="danger" title="Operators only" />;
  return (
    <>
      <div className="page-head"><div><h1>Operations</h1><p className="muted">Data jobs, workers, audit trail, and access.</p></div></div>
      <Tabs tabs={[{ id: "data", label: "Data" }, { id: "jobs", label: "Jobs" }, { id: "workers", label: "Workers" }, { id: "audit", label: "Audit log" }, { id: "users", label: "Users" }]} value={tab} onChange={setTab} />
      {tab === "data" ? <DataOps /> : tab === "jobs" ? <Jobs /> : tab === "workers" ? <Workers /> : tab === "audit" ? <AuditLog /> : <Users />}
    </>
  );
}

function DataOps() {
  const qc = useQueryClient();
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.get<{ datasets: DatasetSummary[] }>("/api/datasets") });
  const [src, setSrc] = useState({ source: "hf", revision: "main", local_dir: "", media: "none" });
  const [dv, setDv] = useState("");
  const [limit, setLimit] = useState("");
  const ingest = useMutation({ mutationFn: () => api.post<{ job_id: number }>("/api/admin/datasets/ingest", { ...src, local_dir: src.local_dir || null }), onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }) });
  const mat = useMutation({ mutationFn: () => api.post<{ job_id: number }>(`/api/admin/datasets/${encodeURIComponent(dv)}/materialize`, { limit: limit ? Number(limit) : null }) });
  const idx = useMutation({ mutationFn: () => api.post<{ job_id: number }>(`/api/admin/datasets/${encodeURIComponent(dv)}/index`) });
  const doctor = useMutation({ mutationFn: () => api.post<{ counts: Record<string, number> }>("/api/admin/judges/doctor"), onSuccess: () => qc.invalidateQueries({ queryKey: ["judges"] }) });
  return (
    <div className="grid grid-2">
      <div className="card">
        <h3>Ingest a release</h3>
        <p className="subtle">Pins the revision, verifies checksums, normalizes, and indexes. Labels go only to the private store.</p>
        <div className="form-grid">
          <label className="field">Source<select value={src.source} onChange={(e) => setSrc({ ...src, source: e.target.value })}><option value="hf">Official (Hugging Face)</option><option value="local">Local mirror</option></select></label>
          <label className="field">Revision<input type="text" value={src.revision} onChange={(e) => setSrc({ ...src, revision: e.target.value })} /></label>
          {src.source === "local" ? <label className="field">Local directory (server path)<input type="text" value={src.local_dir} onChange={(e) => setSrc({ ...src, local_dir: e.target.value })} /></label> : null}
          <label className="field">Media<select value={src.media} onChange={(e) => setSrc({ ...src, media: e.target.value })}><option value="none">Metadata now, media lazily</option><option value="all">Materialize all screenshots</option></select></label>
        </div>
        <button className="primary" style={{ marginTop: "0.75rem" }} onClick={() => ingest.mutate()} disabled={ingest.isPending}>Queue ingestion</button>
        {ingest.data ? <p className="subtle">Queued job #{ingest.data.job_id}.</p> : null}
        {ingest.isError ? <ErrorBox error={ingest.error} /> : null}
      </div>
      <div className="card">
        <h3>Media and index</h3>
        <label className="field">Dataset version<select value={dv} onChange={(e) => setDv(e.target.value)}><option value="">Choose…</option>{(datasets.data?.datasets ?? []).map((d) => <option key={d.dataset_version_id} value={d.dataset_version_id}>{d.dataset_version_id}</option>)}</select></label>
        <label className="field" style={{ marginTop: "0.5rem" }}>Materialize at most N files (blank = all)<input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button onClick={() => mat.mutate()} disabled={!dv || mat.isPending}>Materialize media</button>
          <button onClick={() => idx.mutate()} disabled={!dv || idx.isPending}>Rebuild index</button>
        </div>
        {mat.data ? <p className="subtle">Queued job #{mat.data.job_id}.</p> : null}
        {idx.data ? <p className="subtle">Queued job #{idx.data.job_id}.</p> : null}
        {mat.isError ? <ErrorBox error={mat.error} /> : null}
        <hr className="sep" />
        <h3>Judge capabilities</h3>
        <p className="subtle">Re-probe installation, credentials (names only), identifiers, routes, and isolation. No model is called.</p>
        <button onClick={() => doctor.mutate()} disabled={doctor.isPending}>{doctor.isPending ? "Probing…" : "Refresh capability report"}</button>
        {doctor.data ? <p className="subtle">{JSON.stringify(doctor.data.counts)}</p> : null}
        {doctor.isError ? <ErrorBox error={doctor.error} /> : null}
      </div>
    </div>
  );
}

function Jobs() {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<{ items: Job[] }>("/api/admin/jobs?limit=200"), refetchInterval: 3000 });
  const cancel = useMutation({ mutationFn: (id: number) => api.post(`/api/admin/jobs/${id}/cancel`), onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }) });
  if (jobs.isLoading) return <Loading />;
  if (jobs.isError) return <ErrorBox error={jobs.error} />;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>#</th><th>Kind</th><th>Queue</th><th>Status</th><th className="num">Attempts</th><th>Lease</th><th>Created</th><th>Result / error</th><th /></tr></thead>
      <tbody>{jobs.data!.items.map((j) => (
        <tr key={j.job_id}>
          <td className="mono">{j.job_id}</td><td>{j.kind}</td><td>{j.queue}</td><td><StatusBadge status={j.status} /></td>
          <td className="num">{j.attempts}/{j.max_attempts}</td><td className="mono subtle">{j.lease_owner ?? "—"}</td>
          <td className="subtle">{new Date(j.created_at).toLocaleString()}<div>{j.created_by}</div></td>
          <td className="subtle" style={{ maxWidth: 360 }}>{j.last_error ? <span title={j.last_error}>{j.last_error.split("\n")[0].slice(0, 160)}</span> : j.result ? JSON.stringify(j.result).slice(0, 160) : "—"}</td>
          <td>{["queued", "running"].includes(j.status) ? <button className="danger" onClick={() => cancel.mutate(j.job_id)}>Cancel</button> : null}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Workers() {
  const w = useQuery({ queryKey: ["workers"], queryFn: () => api.get<{ items: Worker[] }>("/api/admin/workers"), refetchInterval: 10000 });
  if (w.isLoading) return <Loading />;
  if (w.isError) return <ErrorBox error={w.error} />;
  if (!w.data!.items.length) return <Banner tone="warn" title="No worker has reported yet">Start <code>agenthorizon worker --queue judge</code> and <code>--queue trusted</code> (or <code>agenthorizon dev</code>).</Banner>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Worker</th><th>Queue</th><th>Last seen</th><th>Credentials present (names)</th><th>Harnesses</th><th>Isolation</th></tr></thead>
      <tbody>{w.data!.items.map((x) => {
        const stale = Date.now() - new Date(x.last_seen).getTime() > 90_000;
        return (
          <tr key={x.worker_id}>
            <td className="mono">{x.worker_id}</td><td>{x.queue}</td>
            <td>{stale ? <StatusBadge status="unavailable" label="stale" /> : <StatusBadge status="ok" label="live" />} <span className="subtle">{new Date(x.last_seen).toLocaleTimeString()}</span></td>
            <td>{x.info.credentials?.length ? x.info.credentials.join(", ") : <span className="subtle">none</span>}</td>
            <td className="subtle">{Object.entries(x.info.harness ?? {}).map(([k, v]) => `${k} ${v.version ?? "missing"}`).join(" · ") || "—"}</td>
            <td>{x.info.isolation ? <StatusBadge status={x.info.isolation.ok ? "ok" : "blocked"} label={x.info.isolation.ok ? "available" : "unavailable"} /> : "—"}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function AuditLog() {
  const a = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ items: Audit[] }>("/api/admin/audit?limit=200"), refetchInterval: 10000 });
  if (a.isLoading) return <Loading />;
  if (a.isError) return <ErrorBox error={a.error} />;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>{a.data!.items.map((e) => (
        <tr key={e.id}><td className="subtle">{new Date(e.at).toLocaleString()}</td><td>{e.actor ?? "system"} <span className="subtle">{e.role}</span></td>
          <td className="mono">{e.action}</td><td className="mono subtle">{e.target}</td><td className="subtle mono">{JSON.stringify(e.detail).slice(0, 140)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function Users() {
  const [u, setU] = useState({ user_id: "", role: "reviewer" });
  const add = useMutation({ mutationFn: () => api.post<{ user_id: string; role: string; token: string }>("/api/admin/users", u) });
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3>Issue an access token</h3>
      <div className="form-grid">
        <label className="field">User id<input type="text" value={u.user_id} onChange={(e) => setU({ ...u, user_id: e.target.value })} pattern="[a-z0-9_.-]{2,64}" /></label>
        <label className="field">Role<select value={u.role} onChange={(e) => setU({ ...u, role: e.target.value })}>{["viewer", "reviewer", "researcher", "operator"].map((r) => <option key={r}>{r}</option>)}</select></label>
      </div>
      <button className="primary" style={{ marginTop: "0.75rem" }} onClick={() => add.mutate()} disabled={!u.user_id || add.isPending}>Create</button>
      {add.data ? <Banner tone="ok" title={`Token for ${add.data.user_id} (${add.data.role}) — shown once`}><code style={{ wordBreak: "break-all" }}>{add.data.token}</code></Banner> : null}
      {add.isError ? <ErrorBox error={add.error} /> : null}
    </div>
  );
}
