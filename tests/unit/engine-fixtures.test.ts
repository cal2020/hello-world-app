import path from "node:path";
import { describe, expect, it } from "vitest";
import * as engine from "../../server/engine.ts";
import { buildView, violationsByModule } from "../../src/lib/graph.ts";
import { explain, edgeIndex } from "../../src/lib/explain.ts";
import { FIXTURES, tempService } from "./helpers.ts";

const scanFixture = async (name: string) => {
  const s = tempService();
  const repo = s.register({ path: path.join(FIXTURES, name) });
  return s.scan(repo.id);
};

describe("fixture classification matches the engine", () => {
  it("clean project has no violations", async () => {
    const scan = await scanFixture("clean-app");
    expect(scan.violations).toEqual([]);
    expect(scan.counts.cycles).toBe(0);
    // type-only import is marked distinctly
    expect(scan.edges.find((e) => e.from === "src/ui/greeting.ts" && e.to === "src/data/user.ts")?.typeOnly).toBe(true);
  });

  it("real import cycle is reported with its loop", async () => {
    const scan = await scanFixture("cycle-app");
    expect(scan.violations.every((v) => v.category === "cycle")).toBe(true);
    expect(scan.violations).toHaveLength(3);
    expect(scan.cycles).toEqual([["src/orders/order.ts", "src/pricing/discount.ts", "src/pricing/price.ts"]]);
    expect(scan.cyclesIgnoreTypeOnly).toBe(true);
    const v = scan.violations.find((x) => x.from === "src/orders/order.ts")!;
    expect(v.cycle[0]).toBe(v.cycle[v.cycle.length - 1]);
  });

  it("forbidden cross-feature import is a boundary violation", async () => {
    const scan = await scanFixture("boundary-app");
    expect(scan.violations.map((v) => [v.rule, v.category, v.from, v.to])).toEqual([["no-cross-feature", "boundary", "src/features/checkout/view.ts", "src/features/cart/store.ts"]]);
    expect(scan.config.source).toBe("file");
  });

  it("unresolved import is reported with its specifier", async () => {
    const scan = await scanFixture("unresolved-app");
    expect(scan.violations.map((v) => [v.rule, v.category, v.from, v.to])).toEqual([["not-to-unresolvable", "unresolved", "src/telemetry/track.ts", "./transport"]]);
    expect(scan.modules.some((m) => m.kind === "unresolved" && m.id === "./transport")).toBe(true);
  });

  it("uses `detangle check` output as the authority and it agrees with the graph command", async () => {
    const root = path.join(FIXTURES, "storefront");
    const [a, c] = await Promise.all([engine.analyze(root, path.join(root, "detangle.toml")), engine.check(root, path.join(root, "detangle.toml"))]);
    const key = (v: { rule: string; from: string; to: string | null }) => `${v.rule}|${v.from}|${v.to}`;
    expect(new Set(a.analysis.violations.map(key))).toEqual(new Set(c.violations.map(key)));
    expect(c.exitCode).toBe(1);
  });
});

describe("graph and list agree; explanations are reproducible", () => {
  it("violations-only graph shows exactly the modules the list flags", async () => {
    const scan = await scanFixture("storefront");
    const listed = new Set(violationsByModule(scan.violations).keys());
    const all = new Set(scan.modules.flatMap((m) => m.id.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
    const view = buildView(scan, { expanded: all, showExternals: false, violationsOnly: true, hideTypeOnly: false, focus: null, focusDepth: 1 });
    const shown = new Set(view.nodes.map((n) => n.module!.id));
    expect(shown).toEqual(listed);
  });

  it("every hop of every explanation is an import the engine reported", async () => {
    const scan = await scanFixture("storefront");
    const idx = edgeIndex(scan.edges);
    for (const v of scan.violations) {
      const ex = explain(v, scan, idx);
      expect(ex.hops.length).toBeGreaterThan(0);
      if (v.category === "unresolved") continue;
      for (const h of ex.hops) expect(idx.has(`${h.from}>${h.to}`), `${h.from} -> ${h.to}`).toBe(true);
      if (v.category === "cycle") expect(ex.hops[0].from).toBe(ex.hops[ex.hops.length - 1].to);
    }
  });
});
