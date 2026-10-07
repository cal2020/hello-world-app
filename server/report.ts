// Portable reports. Paths are repository-relative; the absolute root is omitted unless asked for.

import type { BaselineComparison, Repository, Scan, Violation } from "../shared/types.ts";

export function jsonReport(repo: Repository, scan: Scan, comparison: BaselineComparison | null, includeRoot = false) {
  return {
    format: "lattice-architecture-report",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: { name: repo.name, ...(includeRoot ? { root: repo.root } : {}) },
    scan: {
      id: scan.id,
      startedAt: scan.startedAt,
      engine: `detangle ${scan.engineVersion}`,
      source: scan.source,
      config: { source: scan.config.source, path: scan.config.path, policyHash: scan.config.policyHash, textHash: scan.config.textHash },
      counts: scan.counts,
      cyclesIgnoreTypeOnly: scan.cyclesIgnoreTypeOnly,
    },
    notes: scan.notes,
    violations: scan.violations,
    cycles: scan.cycles,
    comparison,
  };
}

const esc = (s: string) => s.replace(/[|`\\]/g, (c) => `\\${c}`);

function describe(v: Violation): string {
  if (v.cycle.length) return `cycle: ${v.cycle.map((c) => `\`${esc(c)}\``).join(" → ")}`;
  if (v.to) return `\`${esc(v.from)}\` → \`${esc(v.to)}\``;
  return `\`${esc(v.from)}\``;
}

export function markdownReport(repo: Repository, scan: Scan, comparison: BaselineComparison | null): string {
  const out: string[] = [];
  out.push(`# Architecture report — ${repo.name}`, "");
  out.push(`- Scanned: ${scan.startedAt}`);
  out.push(`- Engine: detangle ${scan.engineVersion}`);
  out.push(`- Revision: ${scan.source.commit ? `${scan.source.commit.slice(0, 12)}${scan.source.branch ? ` (${scan.source.branch})` : ""}` : "not a git checkout"} · graph ${scan.source.graphFingerprint}`);
  out.push(`- Rules: ${scan.config.source === "file" ? `detangle.toml (policy ${scan.config.policyHash})` : "engine built-in rules"}`);
  out.push(`- Cycle policy: type-only imports ${scan.cyclesIgnoreTypeOnly ? "are ignored" : "count"}`);
  out.push("");
  const c = scan.counts;
  out.push(`| Modules | Imports | Cycles | Errors | Warnings | Info |`, `|---|---|---|---|---|---|`, `| ${c.localModules} local / ${c.modules} total | ${c.edges} | ${c.cycles} | ${c.errors} | ${c.warnings} | ${c.info} |`, "");
  if (scan.notes.length) {
    out.push("## Notes", "");
    for (const n of scan.notes) out.push(`- **${n.level}** ${n.message}${n.hint ? ` — ${n.hint}` : ""}`);
    out.push("");
  }
  if (comparison) {
    const k = comparison.counts;
    out.push(`## Compared with baseline “${esc(comparison.baseline.name)}”`, "");
    out.push(`New: **${k.new}** · Resolved: **${k.resolved}** · Unchanged: ${k.unchanged} · Affected by rule changes: ${k["policy-changed"]}`, "");
    if (!comparison.samePolicy) out.push(`> Rules changed since the baseline (${comparison.changedRules.join(", ")}). Items listed as “affected by rule changes” are not counted as new or fixed.`, "");
    for (const i of comparison.items.filter((i) => i.status !== "unchanged")) out.push(`- **${i.status}** \`${i.violation.rule}\` ${describe(i.violation)}`);
    out.push("");
  }
  out.push("## Violations", "");
  if (!scan.violations.length) out.push("None.");
  const byRule = new Map<string, Violation[]>();
  for (const v of scan.violations) (byRule.get(v.rule) ?? byRule.set(v.rule, []).get(v.rule)!).push(v);
  for (const [rule, vs] of byRule) {
    out.push(`### ${rule} (${vs[0].severity}, ${vs.length})`, "");
    if (vs[0].comment) out.push(`_${vs[0].comment}_`, "");
    for (const v of vs) out.push(`- ${describe(v)}`);
    out.push("");
  }
  return out.join("\n");
}
