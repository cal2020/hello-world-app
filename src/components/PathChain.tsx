import { ArrowDown } from "lucide-react";
import type { Hop } from "../lib/explain";
import { Badge, Path, cx } from "./ui";

/** Vertical chain of modules joined by the import statement that links them. */
export function PathChain({ hops, onSelect, closed }: { hops: Hop[]; onSelect?: (id: string) => void; closed?: boolean }) {
  if (!hops.length) return null;
  const nodes = [hops[0].from, ...hops.map((h) => h.to)];
  return (
    <ol className="relative space-y-0" aria-label="Import path">
      {nodes.map((n, i) => {
        const h = hops[i];
        const repeat = closed && i === nodes.length - 1;
        return (
          <li key={`${n}-${i}`}>
            <button
              onClick={() => onSelect?.(n)}
              className={cx(
                "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition hover:border-accent/50",
                repeat ? "border-dashed border-warn/40 bg-warn-soft" : "border-line bg-panel-2",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-panel-solid text-[10px] font-semibold text-fg-3">{repeat ? "↺" : i + 1}</span>
              <Path value={n} />
            </button>
            {h && (
              <div className="flex items-center gap-2 py-1 pl-4">
                <ArrowDown className="size-3.5 shrink-0 text-fg-3" aria-hidden />
                <span className="mono truncate text-[11.5px] text-fg-2">
                  imports <span className="text-accent">{h.specifier ? `“${h.specifier}”` : "(specifier not reported)"}</span>
                </span>
                {h.typeOnly && <Badge tone="info">type-only</Badge>}
                {h.types.includes("dynamic") && <Badge>dynamic</Badge>}
                {h.types.includes("unresolvable") && <Badge tone="danger">unresolved</Badge>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
