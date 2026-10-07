import { describe, expect, it } from "vitest";
import type { Scan } from "../../shared/types.ts";
import { autoExpand, buildView, MAX_NODES, representative } from "../../src/lib/graph.ts";
import { fastLayout, layout } from "../../src/lib/layout.ts";

function fakeScan(n: number): Scan {
  const modules = Array.from({ length: n }, (_, i) => ({ id: `src/f${i % 10}/sub${i % 3}/m${i}.ts`, kind: "local" as const, fanIn: 0, fanOut: 1, instability: 1, cycle: null }));
  const edges = modules.slice(1).map((m, i) => ({ from: m.id, to: modules[i].id, specifier: "./x", types: ["local"], typeOnly: false, circular: false }));
  return { modules, edges, violations: [], cycles: [] } as unknown as Scan;
}

describe("graph view model", () => {
  it("collapses folders into representatives", () => {
    const m = { id: "src/a/b/c.ts", kind: "local" as const, fanIn: 0, fanOut: 0, instability: 0, cycle: null };
    expect(representative(m, new Set())).toBe("dir:src");
    expect(representative(m, new Set(["src"]))).toBe("dir:src/a");
    expect(representative(m, new Set(["src", "src/a", "src/a/b"]))).toBe("src/a/b/c.ts");
  });

  it("caps nodes and edges on large graphs and reports what is hidden", () => {
    const scan = fakeScan(1000);
    const all = new Set(scan.modules.flatMap((m) => m.id.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
    const v = buildView(scan, { expanded: all, showExternals: false, violationsOnly: false, hideTypeOnly: false, focus: null, focusDepth: 1 });
    expect(v.nodes.length).toBe(MAX_NODES);
    expect(v.truncatedNodes).toBe(1000 - MAX_NODES);
    const pos = layout(v);
    expect(pos.size).toBe(v.nodes.length);
  });

  it("auto-expansion keeps the first view small", () => {
    const scan = fakeScan(1000);
    const v = buildView(scan, { expanded: autoExpand(scan.modules), showExternals: false, violationsOnly: false, hideTypeOnly: false, focus: null, focusDepth: 1 });
    expect(v.nodes.length).toBeLessThanOrEqual(18);
    expect(v.nodes.length).toBeGreaterThan(1);
  });

  it("fast layout handles cycles and positions every node", () => {
    const view = {
      nodes: ["a", "b", "c"].map((id) => ({ id, kind: "module", label: id, dir: "", moduleCount: 1, violationCount: 0, inCycle: true })),
      edges: [["a", "b"], ["b", "c"], ["c", "a"]].map(([s, t]) => ({ id: `${s}${t}`, source: s, target: t, count: 1, violation: false, circular: true, typeOnly: false, specifiers: [] })),
      totalNodes: 3, totalEdges: 3, truncatedNodes: 0, truncatedEdges: 0,
    } as never;
    const pos = fastLayout(view);
    expect([...pos.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(new Set([...pos.values()].map((p) => p.x)).size).toBe(3);
  });
});
