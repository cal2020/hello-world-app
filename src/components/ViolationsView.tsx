import { useMemo, useState } from "react";
import { CheckCircle2, CircleSlash, GitFork, RefreshCw, ShieldAlert } from "lucide-react";
import type { Scan, Violation } from "../../shared/types";
import { Badge, EmptyState, Path, SeverityBadge, Segmented, cx } from "./ui";

type Cat = "all" | Violation["category"];

const catMeta: Record<Violation["category"], { label: string; icon: typeof GitFork }> = {
  boundary: { label: "Boundaries", icon: ShieldAlert },
  cycle: { label: "Cycles", icon: RefreshCw },
  unresolved: { label: "Unresolved", icon: CircleSlash },
  other: { label: "Other", icon: GitFork },
};

export function ViolationsView({ scan, selectedKey, onSelect }: { scan: Scan; selectedKey: string | null; onSelect: (v: Violation) => void }) {
  const [cat, setCat] = useState<Cat>("all");
  const counts = useMemo(() => {
    const c = { all: scan.violations.length, boundary: 0, cycle: 0, unresolved: 0, other: 0 };
    for (const v of scan.violations) c[v.category]++;
    return c;
  }, [scan]);
  const groups = useMemo(() => {
    const m = new Map<string, Violation[]>();
    for (const v of scan.violations) if (cat === "all" || v.category === cat) (m.get(v.rule) ?? m.set(v.rule, []).get(v.rule)!).push(v);
    return [...m.entries()];
  }, [scan, cat]);

  if (!scan.violations.length) {
    return (
      <EmptyState icon={<CheckCircle2 className="size-6 text-ok" />} title="No violations">
        The engine found no rule violations with the {scan.config.source === "file" ? "rules in detangle.toml" : "built-in rules"}. Add a boundary rule to start enforcing your architecture.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Segmented
          label="Violation category"
          value={cat}
          onChange={setCat}
          options={(["all", "boundary", "cycle", "unresolved", "other"] as Cat[])
            .filter((c) => c === "all" || counts[c])
            .map((c) => ({ value: c, label: `${c === "all" ? "All" : catMeta[c].label} ${counts[c]}` }))}
        />
      </div>
      <div className="scroll-thin flex-1 space-y-5 overflow-auto p-4">
        {groups.map(([rule, vs]) => {
          const Icon = catMeta[vs[0].category].icon;
          return (
            <section key={rule} className="rise" aria-label={`Rule ${rule}`}>
              <header className="mb-2 flex flex-wrap items-center gap-2">
                <Icon className="size-4 text-fg-3" aria-hidden />
                <h3 className="mono text-[13px] font-semibold">{rule}</h3>
                <SeverityBadge severity={vs[0].severity} />
                <span className="text-[12px] text-fg-3">{vs.length}</span>
                {vs[0].comment && <span className="w-full text-[12.5px] text-fg-2 sm:w-auto sm:flex-1 sm:truncate">— {vs[0].comment}</span>}
              </header>
              <ul className="space-y-1.5">
                {vs.map((v) => (
                  <li key={v.key}>
                    <button
                      onClick={() => onSelect(v)}
                      aria-pressed={selectedKey === v.key}
                      className={cx(
                        "glass flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition hover:border-accent/40 sm:flex-row sm:items-center sm:gap-3",
                        selectedKey === v.key && "!border-accent ring-2 ring-accent/20",
                      )}
                    >
                      <Path value={v.from} className="sm:max-w-[45%]" />
                      {v.to && (
                        <>
                          <span className="text-[11px] text-fg-3" aria-hidden>
                            {v.category === "unresolved" ? "imports" : "→"}
                          </span>
                          {v.category === "unresolved" ? <span className="mono truncate text-[12.5px] text-danger">“{v.to}”</span> : <Path value={v.to} className="sm:flex-1" />}
                        </>
                      )}
                      {v.cycle.length > 0 && <Badge tone="warn" className="sm:ml-auto">{v.cycle.length - 1}-module loop</Badge>}
                      {v.scope !== "module" && <Badge>{v.scope}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
