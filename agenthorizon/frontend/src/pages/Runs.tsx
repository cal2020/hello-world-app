import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, qs, type Page, type RunRow } from "../api";
import { Empty, ErrorBox, Loading, resultKindBadge, StatusBadge, useCan } from "../components/ui";

export function RunsPage() {
  const navigate = useNavigate();
  const canWrite = useCan("runs.write");
  const runs = useInfiniteQuery({
    queryKey: ["runs"], initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page<RunRow>>(`/api/runs${qs({ cursor: pageParam || undefined, limit: 50 })}`),
    getNextPageParam: (l) => l.next_cursor ?? undefined, refetchInterval: 5000,
  });
  const rows = (runs.data?.pages ?? []).flatMap((p) => p.items);
  return (
    <>
      <div className="page-head">
        <div><h1>Runs</h1><p className="muted">Every judge run with its identity, status, and result classification.</p></div>
        {canWrite ? <Link className="btn" to="/runs/new">New run</Link> : null}
      </div>
      {runs.isLoading ? <Loading /> : runs.isError ? <ErrorBox error={runs.error} /> : rows.length === 0 ? (
        <div className="card"><Empty title="No runs yet">
          No judge has been executed in this workbench. Live model runs need credentials and an explicit budget; plan one in
          {" "}<Link to="/runs/new">Experiment setup</Link>.
        </Empty></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Run</th><th>Status</th><th>Kind</th><th className="num">Tasks</th><th>Dataset</th><th>Created</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.run_id} className="clickable" onClick={() => navigate(`/runs/${r.run_id}`)}>
                  <td><Link to={`/runs/${r.run_id}`}><strong>{r.label ?? r.config_id}</strong></Link>
                    <div className="subtle mono">{r.run_id}{r.trial > 1 ? ` · trial ${r.trial}` : ""}</div></td>
                  <td><StatusBadge status={r.status} />{r.pause_reason ? <div className="subtle">{r.pause_reason}</div> : null}</td>
                  <td>{resultKindBadge(r.result_kind)}</td>
                  <td className="num">{r.n_tasks}</td>
                  <td className="mono subtle">{r.dataset_version_id}</td>
                  <td className="subtle">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage ? <button style={{ marginTop: "0.75rem" }} onClick={() => runs.fetchNextPage()}>Load more</button> : null}
    </>
  );
}
