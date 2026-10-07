// Turns an engine violation into a human explanation with a concrete, reproducible import path.

import type { ImportEdge, Scan, Violation } from "../../shared/types";

export interface Hop {
  from: string;
  to: string;
  specifier: string | null;
  types: string[];
  typeOnly: boolean;
}

export interface Explanation {
  headline: string;
  detail: string;
  hops: Hop[];
  /** Where the hops came from, so the UI never overstates certainty. */
  pathSource: "engine-cycle" | "direct-import" | "group-imports" | "none";
  notes: string[];
}

export function edgeIndex(edges: ImportEdge[]) {
  const m = new Map<string, ImportEdge>();
  for (const e of edges) m.set(`${e.from}>${e.to}`, e);
  return m;
}

const hop = (idx: Map<string, ImportEdge>, from: string, to: string): Hop => {
  const e = idx.get(`${from}>${to}`);
  return { from, to, specifier: e?.specifier ?? null, types: e?.types ?? [], typeOnly: e?.typeOnly ?? false };
};

export function explain(v: Violation, scan: Scan, idx = edgeIndex(scan.edges)): Explanation {
  const notes: string[] = [];
  if (v.category === "cycle" && v.cycle.length > 1) {
    const hops = v.cycle.slice(0, -1).map((c, i) => hop(idx, c, v.cycle[i + 1]));
    const n = v.cycle.length - 1;
    if (hops.some((h) => h.typeOnly)) notes.push("Part of this loop is a type-only import.");
    notes.push(
      scan.cyclesIgnoreTypeOnly
        ? "Cycle policy: type-only imports are ignored (they are erased at runtime), so this is a runtime cycle."
        : "Cycle policy: type-only imports count toward cycles in this configuration.",
    );
    return {
      headline: `${n}-module import cycle`,
      detail: `${v.from} imports ${v.to}, and following imports from there leads back to ${v.from}. The engine reports this loop for the import ${v.from} → ${v.to}.`,
      hops,
      pathSource: "engine-cycle",
      notes,
    };
  }
  if (v.category === "unresolved") {
    const h = { from: v.from, to: v.to ?? "?", specifier: v.to, types: ["unresolvable"], typeOnly: false };
    notes.push("Usually a deleted/renamed file, a missing dependency install, or a path alias the engine can't see (tsconfig paths, bundler aliases).");
    return { headline: "Import can't be resolved", detail: `${v.from} imports “${v.to}”, which doesn't match any file or installed package.`, hops: [h], pathSource: "direct-import", notes };
  }
  if (v.imports.length) {
    return {
      headline: v.scope === "group" ? "Forbidden dependency between groups" : "Forbidden dependency",
      detail: `${v.from} depends on ${v.to} through ${v.imports.length} import(s); rule “${v.rule}” forbids it.`,
      hops: v.imports.map((i) => ({ ...hop(idx, i.from, i.to), specifier: i.specifier })),
      pathSource: "group-imports",
      notes,
    };
  }
  if (v.to) {
    const h = hop(idx, v.from, v.to);
    if (v.scope === "folder") notes.push("Folder-scope rule: the folders stand for everything beneath them.");
    if (h.typeOnly) notes.push("This is a type-only import; it still counts for this rule.");
    return {
      headline: "Forbidden import across a boundary",
      detail: `${v.from} imports ${v.to}${h.specifier ? ` (via “${h.specifier}”)` : ""}, which rule “${v.rule}” forbids.`,
      hops: [h],
      pathSource: "direct-import",
      notes,
    };
  }
  return { headline: "Module-level finding", detail: `${v.from} matches rule “${v.rule}”.`, hops: [], pathSource: "none", notes };
}
