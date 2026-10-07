import { useEffect, useState } from "react";
import { BookmarkPlus, CheckCircle2, Equal, GitCommitHorizontal, Settings2, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import type { BaselineComparison, ComparisonStatus, Scan, Violation } from "../../shared/types";
import { api, ApiFailure, type BaselineItem } from "../api";
import { Badge, Button, EmptyState, Notice, Path, SeverityBadge, Segmented, cx, inputCls } from "./ui";
import { shortHash, timeAgo } from "../lib/format";

const statusMeta: Record<ComparisonStatus, { label: string; tone: "danger" | "ok" | "neutral" | "warn"; icon: typeof Sparkles }> = {
  new: { label: "New", tone: "danger", icon: Sparkles },
  resolved: { label: "Resolved", tone: "ok", icon: CheckCircle2 },
  unchanged: { label: "Unchanged", tone: "neutral", icon: Equal },
  "policy-changed": { label: "Rule changed", tone: "warn", icon: Settings2 },
};

export function CompareView({ repoId, scan, onSelectViolation, baselineId, setBaselineId }: { repoId: string; scan: Scan | null; onSelectViolation: (v: Violation) => void; baselineId: string | null; setBaselineId: (id: string | null) => void }) {
  const [baselines, setBaselines] = useState<BaselineItem[] | null>(null);
  const [cmp, setCmp] = useState<BaselineComparison | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"changes" | ComparisonStatus | "all">("changes");

  const load = async () => {
    try {
      const b = await api.baselines(repoId);
      setBaselines(b);
      if (!baselineId || !b.some((x) => x.id === baselineId)) setBaselineId(b[0]?.id ?? null);
    } catch (e) {
      setError(e as ApiFailure);
    }
  };
  useEffect(() => {
    void load();
  }, [repoId]);
  useEffect(() => {
    setCmp(null);
    if (!baselineId || !scan) return;
    api.compare(baselineId, scan.id).then(setCmp, (e) => setError(e as ApiFailure));
  }, [baselineId, scan]);

  const create = async () => {
    if (!scan) return;
    setCreating(true);
    setError(null);
    try {
      const b = await api.createBaseline(repoId, scan.id, name || undefined);
      setName("");
      await load();
      setBaselineId(b.id);
    } catch (e) {
      setError(e as ApiFailure);
    } finally {
      setCreating(false);
    }
  };

  if (!scan) return <EmptyState icon={<GitCommitHorizontal className="size-6" />} title="Scan first">Baselines are saved from a scan.</EmptyState>;

  const items = cmp?.items.filter((i) => (filter === "all" ? true : filter === "changes" ? i.status !== "unchanged" : i.status === filter)) ?? [];

  return (
    <div className="scroll-thin h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="glass rounded-2xl p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex-1">
              <h2 className="text-[14px] font-semibold">Baselines</h2>
              <p className="text-[12.5px] text-fg-2">Save today's violations, then compare later scans to see only what was introduced or fixed.</p>
            </div>
            <div className="flex gap-2">
              <input className={cx(inputCls, "md:w-56")} placeholder="Baseline name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Baseline name" maxLength={80} />
              <Button variant="primary" icon={<BookmarkPlus className="size-4" />} loading={creating} onClick={create}>
                Save current scan
              </Button>
            </div>
          </div>
          {baselines && baselines.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {baselines.map((b) => (
                <li key={b.id} className={cx("flex items-center gap-1 rounded-lg border pl-3 text-[12.5px]", b.id === baselineId ? "border-accent bg-accent-soft" : "border-line bg-panel-2")}>
                  <button className="py-1.5 text-left" onClick={() => setBaselineId(b.id)} aria-pressed={b.id === baselineId}>
                    <span className="font-medium">{b.name}</span> <span className="text-fg-3">· {b.violationCount} violations · {timeAgo(b.createdAt)}</span>
                  </button>
                  <button
                    aria-label={`Delete baseline ${b.name}`}
                    className="rounded-md p-1.5 text-fg-3 hover:text-danger"
                    onClick={async () => {
                      await api.removeBaseline(b.id);
                      if (b.id === baselineId) setBaselineId(null);
                      await load();
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && <Notice level="error" title={error.message}>{error.hint}</Notice>}
        {baselines?.length === 0 && <p className="text-center text-[13px] text-fg-3">No baselines yet. Save the current scan to start tracking introduced violations.</p>}

        {cmp && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["new", "resolved", "policy-changed", "unchanged"] as ComparisonStatus[]).map((s) => {
                const M = statusMeta[s];
                return (
                  <button key={s} onClick={() => setFilter(s)} className={cx("glass rounded-xl px-3 py-3 text-left transition hover:border-line-strong", filter === s && "!border-accent")}>
                    <div className={cx("flex items-center gap-1.5 text-[11.5px]", { danger: "text-danger", ok: "text-ok", warn: "text-warn", neutral: "text-fg-3" }[M.tone])}>
                      <M.icon className="size-3.5" /> {M.label}
                    </div>
                    <div className="mt-1 text-[24px] font-semibold tabular-nums">{cmp.counts[s]}</div>
                  </button>
                );
              })}
            </div>

            <div className="glass grid grid-cols-1 gap-3 rounded-2xl p-4 text-[12.5px] md:grid-cols-3">
              <Ctx ok={cmp.sameRepository} label="Repository" value={cmp.sameRepository ? "Same repository" : "Different repository"} />
              <Ctx
                ok={cmp.sameRevision}
                neutral={!cmp.baseline.source.commit || !cmp.scan.source.commit}
                label="Revision"
                value={
                  <>
                    <span className="mono">{shortHash(cmp.baseline.source.commit) ?? "no git"}</span> → <span className="mono">{shortHash(cmp.scan.source.commit) ?? "no git"}</span>
                    <span className="block text-fg-3">
                      graph <span className="mono">{cmp.baseline.source.graphFingerprint}</span> → <span className="mono">{cmp.scan.source.graphFingerprint}</span>
                    </span>
                  </>
                }
              />
              <Ctx ok={cmp.samePolicy} label="Rules" value={cmp.samePolicy ? "Same policy" : <>Changed: <span className="mono">{cmp.changedRules.join(", ")}</span></>} />
            </div>
            {!cmp.samePolicy && (
              <Notice level="warn" title="The rule configuration changed since this baseline">
                Violations of changed rules are listed as “Rule changed” instead of new or resolved, so a config edit is never reported as a code fix.
              </Notice>
            )}

            <div className="flex items-center justify-between">
              <Segmented
                label="Comparison filter"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "changes", label: "Changes" },
                  { value: "all", label: "All" },
                ]}
              />
              <a className="text-[12px] text-accent hover:underline" href={api.reportUrl(scan.id, "md", cmp.baseline.id)}>
                Export comparison report
              </a>
            </div>
            <ul className="space-y-1.5">
              {items.map((i) => {
                const M = statusMeta[i.status];
                return (
                  <li key={`${i.status}-${i.violation.key}`}>
                    <button className="glass flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left hover:border-accent/40" onClick={() => onSelectViolation(i.violation)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={M.tone}>{M.label}</Badge>
                        <SeverityBadge severity={i.violation.severity} />
                        <span className="mono text-[12px] font-semibold">{i.violation.rule}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        <Path value={i.violation.from} className="max-w-[48%]" />
                        {i.violation.to && (
                          <>
                            <span className="text-fg-3">→</span>
                            <Path value={i.violation.to} />
                          </>
                        )}
                      </div>
                      {i.reason && <p className="text-[11.5px] text-warn">{i.reason}</p>}
                    </button>
                  </li>
                );
              })}
              {items.length === 0 && <p className="py-6 text-center text-[13px] text-fg-3">{filter === "changes" ? "No changes since this baseline." : "Nothing in this group."}</p>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Ctx({ ok, neutral, label, value }: { ok: boolean; neutral?: boolean; label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      {neutral ? <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-fg-3" /> : ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
      <div className="min-w-0">
        <div className="text-[11px] text-fg-3 uppercase tracking-wider">{label}</div>
        <div className="text-fg">{value}</div>
      </div>
    </div>
  );
}
