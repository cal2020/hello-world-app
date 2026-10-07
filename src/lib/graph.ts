// Pure view-model for the graph: folder collapsing, neighborhoods, filters and caps.
// The engine's graph is never modified; this only decides what to draw.

import type { ImportEdge, Module, Scan, Violation } from "../../shared/types";

export const MAX_NODES = 220;
export const MAX_EDGES = 700;

export type VNodeKind = "folder" | "module" | "external" | "unresolved";

export interface VNode {
  id: string;
  kind: VNodeKind;
  label: string;
  /** Parent folder path for modules, the folder itself for folders. */
  dir: string;
  moduleCount: number;
  violationCount: number;
  inCycle: boolean;
  module?: Module;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  violation: boolean;
  circular: boolean;
  typeOnly: boolean;
  specifiers: string[];
}

export interface GraphView {
  nodes: VNode[];
  edges: VEdge[];
  totalNodes: number;
  totalEdges: number;
  truncatedNodes: number;
  truncatedEdges: number;
}

export interface ViewOptions {
  expanded: Set<string>;
  showExternals: boolean;
  violationsOnly: boolean;
  hideTypeOnly: boolean;
  /** Neighborhood mode: show only modules within `focusDepth` hops of this module, at file level. */
  focus: string | null;
  focusDepth: number;
}

export const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
export const baseName = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** All folder prefixes of a path, shallowest first: a/b/c.ts -> [a, a/b]. */
export function ancestors(id: string): string[] {
  const parts = id.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Visible node id for a module under the current expansion. */
export function representative(m: Module, expanded: Set<string>): string {
  if (m.kind !== "local") return `${m.kind}:${m.id}`;
  for (const a of ancestors(m.id)) if (!expanded.has(a)) return `dir:${a}`;
  return m.id;
}

/** Pairs (from>to) that carry a violation, including every hop of a reported cycle. */
export function violationEdgeKeys(violations: Violation[]): Set<string> {
  const s = new Set<string>();
  for (const v of violations) {
    if (v.cycle.length > 1) for (let i = 0; i + 1 < v.cycle.length; i++) s.add(`${v.cycle[i]}>${v.cycle[i + 1]}`);
    else if (v.to) s.add(`${v.from}>${v.to}`);
    for (const imp of v.imports) s.add(`${imp.from}>${imp.to}`);
  }
  return s;
}

export function violationsByModule(violations: Violation[]): Map<string, Violation[]> {
  const m = new Map<string, Violation[]>();
  const add = (id: string, v: Violation) => {
    const list = m.get(id);
    if (list) {
      if (!list.includes(v)) list.push(v);
    } else m.set(id, [v]);
  };
  for (const v of violations) {
    add(v.from, v);
    if (v.to) add(v.to, v);
    for (const c of v.cycle) add(c, v);
  }
  return m;
}

/** Expands folders breadth-first until about `target` nodes are visible. */
export function autoExpand(modules: Module[], target = 18): Set<string> {
  const local = modules.filter((m) => m.kind === "local");
  const expanded = new Set<string>();
  const count = () => new Set(local.map((m) => representative(m, expanded))).size;
  for (let depth = 1; depth < 12; depth++) {
    const candidates = new Set<string>();
    for (const m of local) {
      const a = ancestors(m.id);
      if (a.length >= depth && a.slice(0, depth - 1).every((x) => expanded.has(x))) candidates.add(a[depth - 1]);
    }
    if (!candidates.size) break;
    let changed = false;
    // Expand the biggest folders first.
    const sized = [...candidates].map((c) => [c, local.filter((m) => m.id.startsWith(`${c}/`)).length] as const).sort((x, y) => y[1] - x[1]);
    for (const [c] of sized) {
      expanded.add(c);
      if (count() > target) {
        expanded.delete(c);
      } else changed = true;
    }
    if (!changed) break;
  }
  return expanded;
}

function neighborhood(edges: ImportEdge[], start: string, depth: number): Set<string> {
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) for (const x of [...(out.get(n) ?? []), ...(inn.get(n) ?? [])]) if (!seen.has(x)) (seen.add(x), next.push(x));
    frontier = next;
  }
  return seen;
}

export function buildView(scan: Scan, opts: ViewOptions): GraphView {
  const vByModule = violationsByModule(scan.violations);
  const vEdges = violationEdgeKeys(scan.violations);
  let modules = scan.modules.filter((m) => m.kind === "local" || m.kind === "unresolved" || opts.showExternals);
  let edges = scan.edges.filter((e) => !(opts.hideTypeOnly && e.typeOnly));
  const focusSet = opts.focus ? neighborhood(edges, opts.focus, opts.focusDepth) : null;
  if (focusSet) modules = modules.filter((m) => focusSet.has(m.id));
  if (opts.violationsOnly) {
    const involved = new Set<string>(vByModule.keys());
    modules = modules.filter((m) => involved.has(m.id));
  }
  const keep = new Set(modules.map((m) => m.id));
  edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  const expanded = focusSet ? new Set(modules.flatMap((m) => ancestors(m.id))) : opts.expanded;
  const rep = new Map<string, string>();
  const nodes = new Map<string, VNode>();
  for (const m of modules) {
    const r = representative(m, expanded);
    rep.set(m.id, r);
    const vs = vByModule.get(m.id)?.length ?? 0;
    const n = nodes.get(r);
    if (n) {
      n.moduleCount++;
      n.violationCount += vs;
      n.inCycle ||= m.cycle !== null;
      continue;
    }
    if (r.startsWith("dir:")) {
      const dir = r.slice(4);
      nodes.set(r, { id: r, kind: "folder", label: baseName(dir), dir, moduleCount: 1, violationCount: vs, inCycle: m.cycle !== null });
    } else {
      const kind: VNodeKind = m.kind === "local" ? "module" : m.kind === "unresolved" ? "unresolved" : "external";
      nodes.set(r, { id: r, kind, label: kind === "module" ? baseName(m.id) : m.id, dir: kind === "module" ? folderOf(m.id) : m.kind, moduleCount: 1, violationCount: vs, inCycle: m.cycle !== null, module: m });
    }
  }

  const agg = new Map<string, VEdge>();
  for (const e of edges) {
    const s = rep.get(e.from)!;
    const t = rep.get(e.to)!;
    if (s === t) continue;
    const id = `${s}=>${t}`;
    const isV = vEdges.has(`${e.from}>${e.to}`);
    const a = agg.get(id);
    if (a) {
      a.count++;
      a.violation ||= isV;
      a.circular ||= e.circular;
      a.typeOnly &&= e.typeOnly;
      if (a.specifiers.length < 4) a.specifiers.push(e.specifier);
    } else agg.set(id, { id, source: s, target: t, count: 1, violation: isV, circular: e.circular, typeOnly: e.typeOnly, specifiers: [e.specifier] });
  }

  // Caps: keep the most relevant nodes (violations, then most connected) and edges (violations first).
  let nodeList = [...nodes.values()];
  const totalNodes = nodeList.length;
  if (nodeList.length > MAX_NODES) {
    const degree = new Map<string, number>();
    for (const e of agg.values()) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + e.count);
      degree.set(e.target, (degree.get(e.target) ?? 0) + e.count);
    }
    const pinned = opts.focus ? rep.get(opts.focus) : undefined;
    nodeList.sort((a, b) => Number(b.id === pinned) - Number(a.id === pinned) || b.violationCount - a.violationCount || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
    nodeList = nodeList.slice(0, MAX_NODES);
  }
  const visible = new Set(nodeList.map((n) => n.id));
  let edgeList = [...agg.values()].filter((e) => visible.has(e.source) && visible.has(e.target));
  const totalEdges = agg.size;
  if (edgeList.length > MAX_EDGES) {
    edgeList.sort((a, b) => Number(b.violation) - Number(a.violation) || Number(b.circular) - Number(a.circular) || b.count - a.count);
    edgeList = edgeList.slice(0, MAX_EDGES);
  }
  return {
    nodes: nodeList,
    edges: edgeList,
    totalNodes,
    totalEdges,
    truncatedNodes: totalNodes - nodeList.length,
    truncatedEdges: totalEdges - edgeList.length,
  };
}
