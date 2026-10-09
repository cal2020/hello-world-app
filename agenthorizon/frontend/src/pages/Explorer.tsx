import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, qs, type DatasetDetail, type DatasetSummary, type ExampleRow, type Page, type RunRow } from "../api";
import { Banner, Empty, ErrorBox, Loading, SyntheticBanner, useCan } from "../components/ui";

interface Facets { os: { value: string | null; count: number }[]; application: { value: string | null; count: number }[]; domain: { value: string | null; count: number }[]; length_bin: { value: string; count: number }[]; steps: { min: number; max: number } }
interface LabelledRow { example_id: string; label: string; category: string | null; mistake_type_native: string | null; instruction: string; n_steps: number }

const FILTER_KEYS = ["q", "os", "application", "domain", "length_bin", "min_steps", "max_steps", "media", "manifest", "run", "run_status", "review"] as const;

export function ExplorerPage() {
  const { dv: dvParam } = useParams();
  const navigate = useNavigate();
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.get<{ datasets: DatasetSummary[] }>("/api/datasets") });
  const list = datasets.data?.datasets ?? [];
  const dv = dvParam ?? list.find((d) => !d.synthetic)?.dataset_version_id ?? list[0]?.dataset_version_id;
  useEffect(() => {
    if (!dvParam && dv) navigate(`/explore/${encodeURIComponent(dv)}${window.location.search}`, { replace: true });
  }, [dvParam, dv, navigate]);

  if (datasets.isLoading) return <Loading />;
  if (datasets.isError) return <ErrorBox error={datasets.error} />;
  if (!dv) return <div className="card"><Empty title="No dataset version indexed">Ingest data from Operations first.</Empty></div>;
  return <Explorer dv={dv} datasets={list} />;
}

function Explorer({ dv, datasets }: { dv: string; datasets: DatasetSummary[] }) {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const canLabels = useCan("research.labels");
  const [privileged, setPrivileged] = useState(false);
  const [qInput, setQInput] = useState(sp.get("q") ?? "");
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? ""])) as Record<(typeof FILTER_KEYS)[number], string>;

  function set(k: string, v: string) {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      if (v) n.set(k, v); else n.delete(k);
      return n;
    }, { replace: true });
  }

  useEffect(() => {
    const t = setTimeout(() => set("q", qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = useQuery({ queryKey: ["dataset", dv], queryFn: () => api.get<DatasetDetail>(`/api/datasets/${encodeURIComponent(dv)}`) });
  const facets = useQuery({ queryKey: ["facets", dv], queryFn: () => api.get<Facets>(`/api/datasets/${encodeURIComponent(dv)}/facets`) });
  const runs = useQuery({ queryKey: ["runs-list"], queryFn: () => api.get<Page<RunRow>>("/api/runs?limit=200") });
  const dvRuns = (runs.data?.items ?? []).filter((r) => r.dataset_version_id === dv);

  const results = useInfiniteQuery({
    queryKey: ["examples", dv, filters],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page<ExampleRow>>(`/api/datasets/${encodeURIComponent(dv)}/examples${qs({ ...filters, cursor: pageParam || undefined, limit: 100 })}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !privileged,
  });
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("");
  const labelled = useInfiniteQuery({
    queryKey: ["labelled", dv, label, category, filters.manifest],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page<LabelledRow>>(`/api/research/datasets/${encodeURIComponent(dv)}/labelled${qs({ label, category, manifest: filters.manifest, cursor: pageParam || undefined, limit: 200 })}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: privileged && canLabels,
  });

  const rows: (ExampleRow | LabelledRow)[] = useMemo(() => {
    const src = privileged ? labelled.data : results.data;
    return (src?.pages ?? []).flatMap((p) => p.items as (ExampleRow | LabelledRow)[]);
  }, [privileged, labelled.data, results.data]);
  const total = privileged ? undefined : results.data?.pages[0]?.total;
  const active = privileged ? labelled : results;

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 76, overscan: 8 });
  const items = virt.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= rows.length - 10 && active.hasNextPage && !active.isFetchingNextPage) active.fetchNextPage();
  }, [items, rows.length, active]);

  const facetSel = (k: "os" | "application" | "domain" | "length_bin", label: string) => (
    <label className="field">
      {label}
      <select value={filters[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">Any</option>
        {(facets.data?.[k] ?? []).filter((f) => f.value).map((f) => <option key={String(f.value)} value={String(f.value)}>{f.value} ({f.count})</option>)}
      </select>
    </label>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trajectories</h1>
          <p className="muted">Search instructions and actions; filter by metadata, media, run outcome, and review state.</p>
        </div>
        <label className="field" style={{ minWidth: 260 }}>
          Dataset version
          <select value={dv} onChange={(e) => navigate(`/explore/${encodeURIComponent(e.target.value)}`)}>
            {datasets.map((d) => <option key={d.dataset_version_id} value={d.dataset_version_id}>{d.dataset_version_id}{d.synthetic ? " (synthetic)" : ""}</option>)}
          </select>
        </label>
      </div>
      <SyntheticBanner show={!!detail.data?.synthetic} />
      {privileged ? (
        <Banner tone="warn" title="Privileged research view — gold labels are visible">
          Access is audited. Never use this view while reviewing blind or while preparing judge inputs.
        </Banner>
      ) : null}
      <div className="explorer">
        <aside className="filters card" aria-label="Filters">
          <label className="field">
            Search instruction and actions
            <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="e.g. export as PNG" disabled={privileged} />
          </label>
          <label className="field">
            Manifest
            <select value={filters.manifest} onChange={(e) => set("manifest", e.target.value)}>
              <option value="">All examples</option>
              {(detail.data?.manifests ?? []).map((m) => <option key={m.manifest_id} value={m.manifest_id}>{m.name} ({m.n_items})</option>)}
            </select>
          </label>
          {!privileged ? (
            <>
              {facetSel("os", "Operating system")}
              {facetSel("application", "Application")}
              {facetSel("domain", "Domain")}
              {facetSel("length_bin", "Length (steps)")}
              <div className="row">
                <label className="field" style={{ flex: 1 }}>Min steps<input type="number" min={0} value={filters.min_steps} onChange={(e) => set("min_steps", e.target.value)} /></label>
                <label className="field" style={{ flex: 1 }}>Max steps<input type="number" min={0} value={filters.max_steps} onChange={(e) => set("max_steps", e.target.value)} /></label>
              </div>
              <label className="field">
                Screenshots
                <select value={filters.media} onChange={(e) => set("media", e.target.value)}>
                  <option value="">Any</option><option value="complete">All materialized</option><option value="partial">Partially materialized</option><option value="none">None materialized</option>
                </select>
              </label>
              <label className="field">
                Run
                <select value={filters.run} onChange={(e) => set("run", e.target.value)}>
                  <option value="">—</option>
                  {dvRuns.map((r) => <option key={r.run_id} value={r.run_id}>{r.label ?? r.config_id} · {r.run_id.slice(4, 12)}</option>)}
                </select>
              </label>
              <label className="field">
                Execution status in that run
                <select value={filters.run_status} onChange={(e) => set("run_status", e.target.value)} disabled={!filters.run}>
                  <option value="">Any</option><option value="finalized">Finalized</option><option value="response">Has a response</option><option value="missing">Missing (no response)</option><option value="unfinished">Not finished</option>
                </select>
              </label>
              <label className="field">
                Review status
                <select value={filters.review} onChange={(e) => set("review", e.target.value)}>
                  <option value="">Any</option><option value="unreviewed_by_me">Not reviewed by me</option><option value="mine">Reviewed by me</option><option value="any">Reviewed by anyone</option><option value="none">Not reviewed</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field">Gold label
                <select value={label} onChange={(e) => setLabel(e.target.value)}><option value="">Any</option><option value="positive">positive</option><option value="negative">negative</option></select>
              </label>
              <label className="field">Failure category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Any</option><option value="critical_mistake">Critical Mistake</option><option value="bad_side_effect">Bad Side Effect</option>
                  <option value="misunderstanding_of_the_instruction">Misunderstanding of the Instruction(s)</option><option value="untyped">Untyped negative</option>
                </select>
              </label>
            </>
          )}
          {canLabels ? (
            <label className="check"><input type="checkbox" checked={privileged} onChange={(e) => setPrivileged(e.target.checked)} /> Privileged research view</label>
          ) : null}
          <button className="ghost" onClick={() => { setQInput(""); setSp({}, { replace: true }); }}>Clear filters</button>
        </aside>
        <section aria-label="Results">
          <div className="spread" style={{ marginBottom: "0.5rem" }}>
            <span className="muted" aria-live="polite">
              {active.isLoading ? "Searching…" : total !== undefined ? `${total.toLocaleString()} matching examples` : `${rows.length.toLocaleString()} loaded`}
            </span>
            {active.isFetchingNextPage ? <span className="spinner" aria-label="loading more" /> : null}
          </div>
          {active.isError ? <ErrorBox error={active.error} /> : !active.isLoading && rows.length === 0 ? (
            <div className="card"><Empty title="No matching examples">Try removing a filter.</Empty></div>
          ) : (
            <div className="result-list" ref={parentRef}>
              <div style={{ height: virt.getTotalSize(), position: "relative" }}>
                {items.map((vi) => {
                  const r = rows[vi.index];
                  const ex = r as ExampleRow;
                  const lab = r as LabelledRow;
                  return (
                    <Link key={r.example_id} to={`/explore/${encodeURIComponent(dv)}/${r.example_id}`} className="result"
                      style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: vi.size }}>
                      <span className="instr">{r.instruction}</span>
                      <span className="subtle">{r.n_steps} steps</span>
                      <span className="meta">
                        {privileged ? (
                          <>
                            <span className={`badge ${lab.label === "positive" ? "ok" : "danger"}`}>{lab.label}</span>
                            {lab.label === "negative" ? <span className="badge">{lab.mistake_type_native ?? "untyped"}</span> : null}
                          </>
                        ) : (
                          <>
                            {ex.os ? <span>{ex.os}</span> : null}
                            {ex.application ? <span>· {ex.application}</span> : null}
                            {ex.domain ? <span>· {ex.domain}</span> : null}
                            <span>· {ex.media_materialized}/{ex.media_total} screenshots</span>
                          </>
                        )}
                        <span className="mono">· {r.example_id.slice(0, 8)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
