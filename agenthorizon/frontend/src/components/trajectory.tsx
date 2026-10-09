import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, type StepRow } from "../api";

export const WINDOW = 100;

/** Steps are fetched in windows of 100 (only the windows that are visible or selected), never all at once. */
export function useStepWindows(dv: string, eid: string, nSteps: number, wanted: number[]) {
  const windows = useMemo(() => {
    const s = new Set<number>();
    for (const i of wanted) if (i >= 0 && i < nSteps) s.add(Math.floor(i / WINDOW));
    return [...s].sort((a, b) => a - b);
  }, [wanted, nSteps]);
  const results = useQueries({
    queries: windows.map((w) => ({
      queryKey: ["steps", dv, eid, w],
      queryFn: () => api.get<{ steps: StepRow[] }>(`/api/datasets/${encodeURIComponent(dv)}/examples/${eid}/steps?offset=${w * WINDOW}&limit=${WINDOW}`),
      staleTime: Infinity,
    })),
  });
  const byIdx = useMemo(() => {
    const m = new Map<number, StepRow>();
    results.forEach((r) => r.data?.steps.forEach((s) => m.set(s.idx, s)));
    return m;
  }, [results]);
  return { byIdx, loading: results.some((r) => r.isLoading), error: results.find((r) => r.isError)?.error };
}

export function relMs(ts: number | null, first: number | null): string {
  if (ts === null || first === null) return "";
  return `${((ts - first) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`;
}

export function Timeline({ dv, eid, nSteps, selected, onSelect, evidence, firstTs }: {
  dv: string; eid: string; nSteps: number; selected: number; onSelect: (i: number) => void; evidence: Set<number>; firstTs: number | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: nSteps, getScrollElement: () => parentRef.current, estimateSize: () => 79, overscan: 6 });
  const vis = virt.getVirtualItems();
  const wanted = useMemo(() => [selected, ...vis.map((v) => v.index)], [selected, vis]);
  const { byIdx, error } = useStepWindows(dv, eid, nSteps, wanted);
  useEffect(() => {
    virt.scrollToIndex(selected, { align: "auto" });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="timeline" ref={parentRef} role="listbox" aria-label="Steps" aria-activedescendant={`step-${selected}`} tabIndex={-1}>
      {error ? <div className="banner danger">Steps failed to load</div> : null}
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {vis.map((v) => {
          const s = byIdx.get(v.index);
          return (
            <div key={v.index} id={`step-${v.index}`} role="option" aria-selected={selected === v.index}
              className={`step ${selected === v.index ? "active" : ""} ${evidence.has(v.index) ? "evidence" : ""}`}
              style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)`, height: v.size }}
              onClick={() => onSelect(v.index)}>
              {s?.media.thumb_url ? (
                <img className="thumb" src={s.media.thumb_url} alt={`Screenshot before step ${s.step_id ?? v.index}`} loading="lazy" decoding="async" width={96} height={62} />
              ) : (
                <div className="thumb missing">{s ? (s.media.status === "no_screenshot" ? "no screenshot" : s.media.status.replace(/_/g, " ")) : "…"}</div>
              )}
              <div style={{ minWidth: 0 }}>
                <div className="lbl">Step {s?.step_id ?? v.index} · #{v.index + 1}{s ? ` · ${relMs(s.timestamp_us, firstTs)}` : ""}{evidence.has(v.index) ? " · cited" : ""}</div>
                <div className="act">{s ? s.action_text ?? s.action_type : "loading…"}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ScreenshotViewer({ step }: { step: StepRow | undefined }) {
  const [zoom, setZoom] = useState<"fit" | 1 | 2>("fit");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [step?.media.full_url]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "+" || e.key === "=") setZoom((z) => (z === "fit" ? 1 : 2));
      if (e.key === "-") setZoom((z) => (z === 2 ? 1 : "fit"));
      if (e.key === "0") setZoom("fit");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const m = step?.media;
  const w = m?.width ?? undefined;
  const h = m?.height ?? undefined;
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="subtle">
          {step ? <>Screen <strong>before</strong> step {step.step_id ?? step.idx} executes{w && h ? ` · ${w}×${h}px` : ""}</> : "Select a step"}
        </span>
        <span className="row" role="group" aria-label="Zoom">
          <button className={zoom === "fit" ? "primary" : ""} onClick={() => setZoom("fit")} aria-pressed={zoom === "fit"}>Fit</button>
          <button className={zoom === 1 ? "primary" : ""} onClick={() => setZoom(1)} aria-pressed={zoom === 1}>100%</button>
          <button className={zoom === 2 ? "primary" : ""} onClick={() => setZoom(2)} aria-pressed={zoom === 2}>200%</button>
          {m?.full_url ? <a className="btn" href={m.full_url} target="_blank" rel="noreferrer">Original</a> : null}
        </span>
      </div>
      <div className="viewer-stage">
        {!step ? <div className="placeholder">Loading step…</div> : m?.full_url ? (
          <>
            {!loaded ? <div className="placeholder" style={{ position: "absolute" }}><span className="spinner" /> Loading full resolution…</div> : null}
            <img src={m.full_url} alt={`Full-resolution screenshot before step ${step.step_id ?? step.idx}: ${step.action_text ?? ""}`}
              onLoad={() => setLoaded(true)}
              style={zoom === "fit" ? { maxWidth: "100%", height: "auto" } : { width: (w ?? 1000) * zoom, height: "auto" }} />
          </>
        ) : (
          <div className="placeholder">
            {m?.status === "no_screenshot" ? "This step has no screenshot in the release." :
              `Screenshot ${m?.status?.replace(/_/g, " ") ?? "unavailable"} — materialize media for this dataset version to view it.`}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Step N" mentions in a judge's reasoning, mapped to timeline indices via the released step ids. */
export function citedSteps(text: string | null | undefined, stepIdToIdx: (id: number) => number | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const m of text.matchAll(/\bsteps?\s+(\d{1,4})(?:\s*(?:-|–|to|and)\s*(\d{1,4}))?/gi)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 50; i++) {
      const idx = stepIdToIdx(i);
      if (idx !== undefined) out.add(idx);
    }
  }
  return [...out].sort((x, y) => x - y);
}
