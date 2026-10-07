// Measures analysis (engine + snapshot build) and the graph view-model/layout separately.
// Usage: npm run bench [-- fixtures/generated-1000]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Service } from "../server/service.ts";
import { autoExpand, buildView } from "../src/lib/graph.ts";
import { layout } from "../src/lib/layout.ts";

const target = path.resolve(process.argv[2] ?? "fixtures/generated-1000");
if (!fs.existsSync(target)) {
  console.error(`${target} does not exist. Run npm run fixtures:large first.`);
  process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-bench-"));
const service = new Service(dataDir);
const repo = service.register({ path: target });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const runs: number[] = [];
const engine: number[] = [];
let scan = await service.scan(repo.id); // warm-up
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  scan = await service.scan(repo.id);
  runs.push(performance.now() - t);
  engine.push(scan.engineMs.scan + scan.engineMs.graph);
}
const ui: Record<string, number[]> = { "autoExpand": [], "view: default folders": [], "layout: default folders": [], "view: all files (capped)": [], "layout: all files (capped)": [], "view: 2-hop neighborhood": [], "layout: 2-hop neighborhood": [] };
const allDirs = new Set(scan.modules.flatMap((m) => m.id.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
const busiest = [...scan.modules].sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))[0].id;
let sizes = "";
for (let i = 0; i < 5; i++) {
  let t = performance.now();
  const expanded = autoExpand(scan.modules);
  ui["autoExpand"].push(performance.now() - t);
  const base = { showExternals: false, violationsOnly: false, hideTypeOnly: false, focus: null, focusDepth: 2 };
  for (const [label, opts] of [
    ["default folders", { ...base, expanded }],
    ["all files (capped)", { ...base, expanded: allDirs }],
    ["2-hop neighborhood", { ...base, expanded, focus: busiest }],
  ] as const) {
    t = performance.now();
    const v = buildView(scan, opts);
    ui[`view: ${label}`].push(performance.now() - t);
    t = performance.now();
    layout(v);
    ui[`layout: ${label}`].push(performance.now() - t);
    if (i === 0) sizes += `  ${label}: ${v.nodes.length} nodes / ${v.edges.length} edges drawn (of ${v.totalNodes} / ${v.totalEdges}; ${v.truncatedNodes} nodes, ${v.truncatedEdges} edges hidden by caps)\n`;
  }
}
console.log(`Machine: ${os.cpus()[0]?.model ?? "unknown CPU"} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, Node ${process.version}, ${os.platform()}`);
console.log(`Fixture: ${path.relative(process.cwd(), target)} — ${scan.counts.modules} modules, ${scan.counts.edges} imports, ${scan.violations.length} violations`);
console.log(`Method: 1 warm-up + 5 runs, median reported (performance.now)`);
console.log(`Analysis (Service.scan: preflight + engine graph + engine check + snapshot): ${median(runs).toFixed(0)} ms`);
console.log(`  of which engine-reported scan+graph time: ${median(engine).toFixed(1)} ms`);
console.log(`Graph view-model + layout (UI main-thread work, measured in Node):`);
for (const [k, v] of Object.entries(ui)) console.log(`  ${k}: ${median(v).toFixed(1)} ms`);
console.log(`Visible graph sizes:\n${sizes}`);
fs.rmSync(dataDir, { recursive: true, force: true });
