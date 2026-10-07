import dagre from "@dagrejs/dagre";
import type { GraphView } from "./graph";

export const NODE_W = 196;
export const NODE_H = 46;
const RANK_GAP = 56;
const ROW_GAP = 16;
/** Above this many nodes, dagre's crossing minimization gets too slow for interactive use. */
export const DAGRE_LIMIT = 90;

type Pos = Map<string, { x: number; y: number }>;

/** Left-to-right layered layout of the visible (already capped) graph. */
export function layout(view: GraphView): Pos {
  return view.nodes.length <= DAGRE_LIMIT ? dagreLayout(view) : fastLayout(view);
}

function dagreLayout(view: GraphView): Pos {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: RANK_GAP, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of view.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of view.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const pos: Pos = new Map();
  for (const n of view.nodes) {
    const p = g.node(n.id);
    pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return pos;
}

/**
 * Linear-time layered layout: back edges are ignored (DFS order), ranks are longest paths
 * from sources, and each column is ordered by the mean row of its predecessors (one sweep).
 */
export function fastLayout(view: GraphView): Pos {
  const ids = view.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inn = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of view.edges) {
    out.get(e.source)?.push(e.target);
    inn.get(e.target)?.push(e.source);
  }
  // Iterative DFS to find a topological order of the graph minus back edges.
  const state = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  const back = new Set<string>();
  for (const start of ids) {
    if (state.get(start)) continue;
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = out.get(top[0])!;
      if (top[1] < kids.length) {
        const k = kids[top[1]++];
        const s = state.get(k);
        if (s === 1) back.add(`${top[0]}>${k}`);
        else if (!s) (state.set(k, 1), stack.push([k, 0]));
      } else {
        state.set(top[0], 2);
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  order.reverse();
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of order) for (const k of out.get(id)!) if (!back.has(`${id}>${k}`)) rank.set(k, Math.max(rank.get(k)!, rank.get(id)! + 1));
  const columns: string[][] = [];
  for (const id of order) (columns[rank.get(id)!] ??= []).push(id);
  const row = new Map<string, number>();
  for (const col of columns) {
    if (!col) continue;
    const key = (id: string) => {
      const ps = inn.get(id)!.filter((p) => row.has(p));
      return ps.length ? ps.reduce((n, p) => n + row.get(p)!, 0) / ps.length : Number.MAX_SAFE_INTEGER;
    };
    const keyed = col.map((id) => [id, key(id)] as const).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    keyed.forEach(([id], i) => row.set(id, i));
  }
  const tallest = Math.max(1, ...columns.map((c) => c?.length ?? 0));
  const pos: Pos = new Map();
  columns.forEach((col, r) => {
    if (!col) return;
    const offset = ((tallest - col.length) * (NODE_H + ROW_GAP)) / 2;
    for (const id of col) pos.set(id, { x: 20 + r * (NODE_W + RANK_GAP), y: 20 + offset + row.get(id)! * (NODE_H + ROW_GAP) });
  });
  return pos;
}
