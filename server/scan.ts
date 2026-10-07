// Turns engine output into a Scan snapshot tied to its source and config versions.
// Pure functions here are tested without the engine.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ImportEdge, Module, PathExplanation, Scan, ScanNote, SourceVersion, Violation, BaselineComparison, Baseline, ComparisonItem, ScanSummary } from "../shared/types.ts";
import { STORE_SCHEMA_VERSION } from "../shared/types.ts";
import type { EngineAnalysis, EngineViolation } from "./engine.ts";
import { sha256 } from "./rules.ts";

export const violationKey = (v: Pick<EngineViolation, "rule" | "scope" | "from" | "to">) => `${v.rule}|${v.scope}|${v.from}|${v.to ?? ""}`;

export function categorize(v: EngineViolation): Violation["category"] {
  if (v.cycle.length) return "cycle";
  if (v.rule === "not-to-unresolvable" || /unresolv/.test(v.rule)) return "unresolved";
  if (v.to) return "boundary";
  return "other";
}

const outsideRoot = (id: string) => id.startsWith("../") || id.startsWith("/") || /^[A-Za-z]:[\\/]/.test(id);

export function toViolation(v: EngineViolation): Violation {
  return { key: violationKey(v), rule: v.rule, severity: v.severity, comment: v.comment, scope: v.scope, from: v.from, to: v.to, cycle: v.cycle, imports: v.imports ?? [], category: categorize(v) };
}

/** Reads the checked-out commit from .git without running git (which could run hooks or fsmonitor commands). */
export function readGitRevision(root: string): { commit: string | null; branch: string | null } {
  try {
    let gitDir = path.join(root, ".git");
    const st = fs.lstatSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return { commit: null, branch: null };
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return { commit: head, branch: null };
    const ref = /^ref:\s*(refs\/.+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return { commit: null, branch: null };
    const branch = ref.replace(/^refs\/heads\//, "");
    // Worktrees keep refs in the common dir.
    const commonFile = path.join(gitDir, "commondir");
    const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
    for (const dir of [gitDir, common]) {
      const loose = path.join(dir, ref);
      if (fs.existsSync(loose)) return { commit: fs.readFileSync(loose, "utf8").trim(), branch };
    }
    const packed = path.join(common, "packed-refs");
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
      if (line) return { commit: line.split(" ")[0], branch };
    }
    return { commit: null, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

export function cyclesIgnoreTypeOnly(configText: string | null): boolean {
  if (!configText) return true; // engine default
  try {
    const opts = ((parseToml(configText) as Record<string, unknown>).options ?? {}) as Record<string, unknown>;
    return opts.cycles_ignore_type_only !== false;
  } catch {
    return true;
  }
}

export interface BuildInput {
  id?: string;
  repositoryId: string;
  startedAt: string;
  durationMs: number;
  engineVersion: string;
  analysis: EngineAnalysis;
  checkViolations: EngineViolation[];
  config: Scan["config"];
  configText: string | null;
  git: { commit: string | null; branch: string | null };
  notes: ScanNote[];
}

export function buildScan(input: BuildInput): Scan {
  const { analysis } = input;
  const notes = [...input.notes];
  const dropped = new Set(analysis.modules.filter((m) => outsideRoot(m.id)).map((m) => m.id));
  if (dropped.size) {
    notes.push({
      level: "warn",
      code: "outside-root-modules",
      message: `${dropped.size} import target(s) resolved outside the repository (through a symlink or ../ path) and were left out of the graph.`,
      hint: "Register the enclosing folder instead if those files belong to the project.",
    });
  }
  const modules: Module[] = [];
  const edges: ImportEdge[] = [];
  for (const m of analysis.modules) {
    if (dropped.has(m.id)) continue;
    modules.push({ id: m.id, kind: m.kind, fanIn: m.fanIn, fanOut: m.fanOut, instability: m.instability, cycle: m.cycle });
    for (const d of m.dependencies) {
      if (dropped.has(d.module)) continue;
      edges.push({ from: m.id, to: d.module, specifier: d.specifier, types: d.types, typeOnly: d.types.includes("type-only"), circular: d.circular });
    }
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // `check` is the authoritative rule result (what CI would report); deduplicate by stable key.
  const seen = new Map<string, Violation>();
  for (const v of input.checkViolations) {
    if (outsideRoot(v.from)) continue;
    const vv = toViolation(v);
    if (!seen.has(vv.key)) seen.set(vv.key, vv);
  }
  const violations = [...seen.values()].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from));
  const fp = sha256(edges.map((e) => `${e.from}>${e.to}:${e.types.join(",")}`).join("\n") + "\n#" + modules.map((m) => m.id).join("\n")).slice(0, 16);
  const source: SourceVersion = { ...input.git, graphFingerprint: fp };
  const count = (s: string) => violations.filter((v) => v.severity === s).length;
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    id: input.id ?? crypto.randomUUID(),
    repositoryId: input.repositoryId,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    engineMs: { scan: analysis.summary.timings.scan_ms, graph: analysis.summary.timings.graph_ms },
    engineVersion: input.engineVersion,
    source,
    config: input.config,
    counts: {
      modules: modules.length,
      localModules: modules.filter((m) => m.kind === "local").length,
      edges: edges.length,
      cycles: analysis.cycles.length,
      errors: count("error"),
      warnings: count("warn"),
      info: count("info"),
      unresolved: modules.filter((m) => m.kind === "unresolved").length,
    },
    modules,
    edges,
    cycles: analysis.cycles.filter((c) => !c.some(outsideRoot)),
    violations,
    notes,
    cyclesIgnoreTypeOnly: cyclesIgnoreTypeOnly(input.configText),
  };
}

const sevRank = (s: string) => ({ error: 0, warn: 1, info: 2, off: 3 })[s] ?? 4;

export function summarize(s: Scan): ScanSummary {
  const { schemaVersion: _v, modules: _m, edges: _e, cycles: _c, violations: _vi, notes: _n, cyclesIgnoreTypeOnly: _t, ...summary } = s;
  return summary;
}

/** Shortest import chain between two different modules over the engine's graph (breadth-first). */
export function shortestPath(edges: ImportEdge[], from: string, to: string, opts: { includeTypeOnly?: boolean } = {}): PathExplanation {
  const out = new Map<string, ImportEdge[]>();
  for (const e of edges) {
    if (opts.includeTypeOnly === false && e.typeOnly) continue;
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  const prev = new Map<string, ImportEdge>();
  const seen = new Set([from]);
  const queue = [from];
  for (let i = 0; i < queue.length && !seen.has(to); i++) {
    for (const e of out.get(queue[i]) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, e);
      queue.push(e.to);
    }
  }
  if (from === to || !prev.has(to)) return { from, to, hops: [], found: false };
  const hops: PathExplanation["hops"] = [];
  for (let cur = to; cur !== from; ) {
    const e = prev.get(cur)!;
    hops.unshift({ from: e.from, to: e.to, specifier: e.specifier, types: e.types });
    cur = e.from;
  }
  return { from, to, hops, found: true };
}

// ---- Baselines ---------------------------------------------------------------

export function compareToBaseline(baseline: Baseline, scan: Scan): BaselineComparison {
  const changedRules = new Set<string>();
  const b = baseline.config.ruleHashes;
  const c = scan.config.ruleHashes;
  for (const k of new Set([...Object.keys(b), ...Object.keys(c)])) if (b[k] !== c[k]) changedRules.add(k);
  if (baseline.config.policyHash !== scan.config.policyHash && changedRules.size === 0) changedRules.add("[policy]");
  const globalChange = changedRules.has("[options]") || changedRules.has("[policy]") || baseline.config.source !== scan.config.source;
  const policyChanged = (rule: string) => globalChange || changedRules.has(rule);

  const before = new Map(baseline.violations.map((v) => [v.key, v]));
  const after = new Map(scan.violations.map((v) => [v.key, v]));
  const items: ComparisonItem[] = [];
  for (const [k, v] of after) {
    if (before.has(k)) items.push({ status: "unchanged", violation: v });
    else if (policyChanged(v.rule)) items.push({ status: "policy-changed", violation: v, reason: "Appeared after the rule configuration changed — may come from the new policy rather than new code." });
    else items.push({ status: "new", violation: v });
  }
  for (const [k, v] of before) {
    if (after.has(k)) continue;
    if (policyChanged(v.rule)) items.push({ status: "policy-changed", violation: v, reason: "Disappeared after the rule configuration changed — not necessarily fixed in code." });
    else items.push({ status: "resolved", violation: v });
  }
  const order = { new: 0, "policy-changed": 1, resolved: 2, unchanged: 3 } as const;
  items.sort((x, y) => order[x.status] - order[y.status] || x.violation.key.localeCompare(y.violation.key));
  const counts = { new: 0, resolved: 0, unchanged: 0, "policy-changed": 0 };
  for (const i of items) counts[i.status]++;
  return {
    baseline: { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt, source: baseline.source, config: baseline.config },
    scan: { id: scan.id, startedAt: scan.startedAt, source: scan.source, config: scan.config },
    sameRepository: baseline.repositoryId === scan.repositoryId,
    sameRevision: !!baseline.source.commit && baseline.source.commit === scan.source.commit,
    samePolicy: baseline.config.policyHash === scan.config.policyHash,
    changedRules: [...changedRules].sort(),
    items,
    counts,
  };
}
