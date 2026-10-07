import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { AlertOctagon, Box, ChevronRight, CircleSlash, Crosshair, FileCode2, Folder, FolderOpen, Minus, Package, Plus, RefreshCcw } from "lucide-react";
import type { Scan } from "../../shared/types";
import { buildView, type VNode } from "../lib/graph";
import { layout, NODE_H, NODE_W } from "../lib/layout";
import { Badge, Button, Segmented, Toggle, cx } from "./ui";

export interface GraphState {
  expanded: Set<string>;
  showExternals: boolean;
  violationsOnly: boolean;
  hideTypeOnly: boolean;
  focusMode: boolean;
  focusDepth: number;
}

type NodeData = { v: VNode; selected: boolean; dim: boolean; onToggle: (dir: string) => void };

const GraphNode = memo(function GraphNode({ data }: NodeProps<Node<NodeData>>) {
  const { v, selected, dim, onToggle } = data;
  const isFolder = v.kind === "folder";
  const Icon = isFolder ? Folder : v.kind === "unresolved" ? CircleSlash : v.kind === "external" ? Package : FileCode2;
  const tone =
    v.kind === "unresolved"
      ? "border-danger/40 border-dashed"
      : v.violationCount
        ? "border-danger/45"
        : v.inCycle
          ? "border-warn/45"
          : "border-line-strong";
  return (
    <div
      className={cx(
        "group relative flex h-[46px] w-[196px] items-center gap-2 rounded-xl border bg-panel-2 px-2.5 text-left shadow-sm transition-[opacity,box-shadow] duration-200",
        tone,
        selected && "ring-2 ring-accent shadow-[0_0_0_6px_var(--accent-soft)]",
        dim && "opacity-25",
        isFolder && "bg-gradient-to-br from-panel-2 to-accent-soft",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-line-strong" />
      <div
        className={cx(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          isFolder ? "bg-accent-soft text-accent" : v.kind === "unresolved" ? "bg-danger-soft text-danger" : v.kind === "external" ? "bg-info-soft text-info" : "bg-panel-2 text-fg-2",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="mono truncate text-[12px] font-semibold text-fg">{isFolder ? `${v.label}/` : v.label}</div>
        <div className="mono truncate text-[10.5px] text-fg-3">{isFolder ? `${v.moduleCount} modules` : v.dir || "·"}</div>
      </div>
      {v.violationCount > 0 && (
        <span className="absolute -top-2 -right-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white shadow" aria-label={`${v.violationCount} violations`}>
          {v.violationCount}
        </span>
      )}
      {v.inCycle && !v.violationCount && <span className="absolute -top-1.5 -right-1.5 size-3 rounded-full border-2 border-panel-solid bg-warn" aria-label="in a cycle" />}
      {isFolder && (
        <button
          className="nodrag flex size-6 items-center justify-center rounded-md text-fg-3 opacity-70 transition hover:bg-accent-soft hover:text-accent group-hover:opacity-100"
          aria-label={`Expand ${v.dir}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(v.dir);
          }}
        >
          <Plus className="size-3.5" />
        </button>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-line-strong" />
    </div>
  );
});

const nodeTypes = { g: GraphNode };

interface Props {
  scan: Scan;
  state: GraphState;
  setState: (s: GraphState) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onSwitchToList: () => void;
}

function Inner({ scan, state, setState, selected, onSelect, onSwitchToList }: Props) {
  const rf = useReactFlow();
  const focus = state.focusMode && selected && !selected.startsWith("dir:") ? selected : null;
  const view = useMemo(
    () =>
      buildView(scan, {
        expanded: state.expanded,
        showExternals: state.showExternals,
        violationsOnly: state.violationsOnly,
        hideTypeOnly: state.hideTypeOnly,
        focus,
        focusDepth: state.focusDepth,
      }),
    [scan, state, focus],
  );
  const positions = useMemo(() => layout(view), [view]);
  const [hover, setHover] = useState<string | null>(null);
  // SVG attributes can't read CSS variables, so resolve the theme colors for the minimap.
  const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme : "dark";
  const colors = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return { danger: v("--danger"), accent: v("--accent"), node: v("--text-3"), panel: v("--panel-solid"), mask: theme === "dark" ? "rgba(0,0,0,0.55)" : "rgba(240,242,248,0.6)" };
  }, [theme]);

  const toggle = (dir: string) => {
    const next = new Set(state.expanded);
    if (next.has(dir)) {
      for (const d of [...next]) if (d === dir || d.startsWith(`${dir}/`)) next.delete(d);
    } else next.add(dir);
    setState({ ...state, expanded: next });
  };

  const selectedNodeId = useMemo(() => {
    if (!selected) return null;
    if (view.nodes.some((n) => n.id === selected)) return selected;
    // A selected module hidden inside a collapsed folder highlights that folder.
    return view.nodes.find((n) => n.kind === "folder" && selected.startsWith(`${n.dir}/`))?.id ?? null;
  }, [selected, view]);

  // In neighborhood mode every visible node is context, so nothing is dimmed except on hover.
  const active = hover ?? (focus ? null : selectedNodeId);
  const neighbors = useMemo(() => {
    if (!active) return null;
    const s = new Set([active]);
    for (const e of view.edges) {
      if (e.source === active) s.add(e.target);
      if (e.target === active) s.add(e.source);
    }
    return s;
  }, [active, view]);

  const nodes: Node<NodeData>[] = useMemo(
    () =>
      view.nodes.map((v) => ({
        id: v.id,
        type: "g",
        position: positions.get(v.id)!,
        width: NODE_W,
        height: NODE_H,
        data: { v, selected: v.id === selectedNodeId, dim: !!neighbors && !neighbors.has(v.id), onToggle: toggle },
        ariaLabel: `${v.kind === "folder" ? "Folder" : "Module"} ${v.kind === "folder" ? v.dir : v.module?.id}${v.violationCount ? `, ${v.violationCount} violations` : ""}`,
      })),
    [view, positions, selectedNodeId, neighbors],
  );

  const edges: Edge[] = useMemo(
    () =>
      view.edges.map((e) => {
        const lit = !!active && (e.source === active || e.target === active);
        const color = e.violation ? "var(--danger)" : e.circular ? "var(--warn)" : lit ? "var(--accent)" : "var(--edge)";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          className: e.violation ? "edge-violation" : undefined,
          style: {
            stroke: color,
            strokeWidth: e.violation || lit ? 2 : Math.min(1 + Math.log2(e.count) * 0.6, 3),
            strokeDasharray: e.typeOnly ? "2 4" : undefined,
            opacity: active && !lit && !e.violation ? 0.15 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          label: e.count > 1 ? String(e.count) : undefined,
          labelStyle: { fill: "var(--text-3)", fontSize: 10, fontFamily: "var(--font-mono)" },
          labelBgStyle: { fill: "var(--panel-solid)" },
          zIndex: e.violation ? 10 : lit ? 5 : 0,
        } satisfies Edge;
      }),
    [view, active],
  );

  // Fit when the visible graph changes, and when the canvas is resized (e.g. the detail pane opens).
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fit = () => rf.fitView({ padding: 0.12, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250, maxZoom: 1.15, minZoom: 0.5 });
    let t = setTimeout(fit, 40);
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(fit, 120);
    });
    if (wrapper.current) ro.observe(wrapper.current);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [view, rf]);

  const collapseAll = () => setState({ ...state, expanded: new Set() });

  return (
    <div ref={wrapper} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeDoubleClick={(_, n) => {
          const v = (n.data as NodeData).v;
          if (v.kind === "folder") toggle(v.dir);
        }}
        onNodeMouseEnter={(_, n) => setHover(n.id)}
        onNodeMouseLeave={() => setHover(null)}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        nodesDraggable={false}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
        onlyRenderVisibleElements
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(n) => {
            const v = (n.data as NodeData).v;
            return v.violationCount ? colors.danger : v.kind === "folder" ? colors.accent : colors.node;
          }}
          bgColor={colors.panel}
          maskColor={colors.mask}
          className="!hidden md:!block"
        />
      </ReactFlow>

      {/* Toolbar */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
        <div className="glass pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-3 py-2">
          <Toggle checked={state.violationsOnly} onChange={(v) => setState({ ...state, violationsOnly: v })} label="Violations only" />
          <Toggle checked={state.showExternals} onChange={(v) => setState({ ...state, showExternals: v })} label="Packages" />
          <Toggle checked={state.hideTypeOnly} onChange={(v) => setState({ ...state, hideTypeOnly: v })} label="Hide type-only" />
          <div className="h-4 w-px bg-line" />
          <Button size="sm" variant="ghost" icon={<Minus className="size-3.5" />} onClick={collapseAll} disabled={!!focus}>
            Collapse all
          </Button>
        </div>
        <div className="glass pointer-events-auto flex items-center gap-2 rounded-xl px-2 py-1.5">
          <Crosshair className={cx("size-3.5", focus ? "text-accent" : "text-fg-3")} aria-hidden />
          <Toggle checked={state.focusMode} onChange={(v) => setState({ ...state, focusMode: v })} label="Neighborhood" />
          {state.focusMode && (
            <Segmented
              label="Neighborhood depth"
              value={String(state.focusDepth) as "1" | "2" | "3"}
              onChange={(d) => setState({ ...state, focusDepth: Number(d) })}
              options={[
                { value: "1", label: "1 hop" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
              ]}
            />
          )}
        </div>
      </div>

      {/* Status strip */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-16">
        <div className="glass pointer-events-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full px-3.5 py-1.5 text-[11.5px] text-fg-2">
          <span>
            <b className="text-fg">{view.nodes.length}</b> nodes · <b className="text-fg">{view.edges.length}</b> edges shown
          </span>
          {state.focusMode && !focus && <span className="text-accent">Select a module to show its neighborhood</span>}
          {focus && (
            <span className="inline-flex items-center gap-1 text-accent">
              <Crosshair className="size-3" /> {state.focusDepth}-hop neighborhood
            </span>
          )}
          {(view.truncatedNodes > 0 || view.truncatedEdges > 0) && (
            <Badge tone="warn" title="Rendering every node/edge at once would make the graph unreadable">
              {view.truncatedNodes > 0 && `${view.truncatedNodes} nodes`}
              {view.truncatedNodes > 0 && view.truncatedEdges > 0 && " · "}
              {view.truncatedEdges > 0 && `${view.truncatedEdges} edges`} hidden — collapse folders or use neighborhood
            </Badge>
          )}
          <button className="text-fg-3 underline-offset-2 hover:text-fg hover:underline" onClick={onSwitchToList}>
            Open list view
          </button>
        </div>
      </div>

      {view.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="glass rounded-2xl px-5 py-4 text-center text-[13px] text-fg-2">
            {state.violationsOnly ? (
              <>
                <AlertOctagon className="mx-auto mb-2 size-5 text-ok" /> No modules are involved in violations.
              </>
            ) : (
              <>
                <Box className="mx-auto mb-2 size-5" /> Nothing to show with these filters.
              </>
            )}
            <div className="mt-2">
              <Button size="sm" icon={<RefreshCcw className="size-3.5" />} onClick={() => setState({ ...state, violationsOnly: false, focusMode: false })}>
                Reset filters
              </Button>
            </div>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        Graph shows {view.nodes.length} nodes and {view.edges.length} edges.
      </span>
      <FolderLegend />
    </div>
  );
}

function FolderLegend() {
  return (
    <div className="glass pointer-events-none absolute bottom-3 left-14 hidden rounded-xl px-3 py-2 text-[11px] text-fg-2 2xl:block">
      <div className="mb-1 font-medium text-fg-3 uppercase tracking-wider text-[10px]">Legend</div>
      <div className="flex items-center gap-2"><span className="h-0.5 w-5 bg-danger" /> violation</div>
      <div className="flex items-center gap-2"><span className="h-0.5 w-5 bg-warn" /> cycle</div>
      <div className="flex items-center gap-2"><span className="h-0 w-5 border-t-2 border-dotted border-fg-3" /> type-only</div>
      <div className="flex items-center gap-2"><FolderOpen className="size-3 text-accent" /> folder (double-click)</div>
      <div className="flex items-center gap-2"><ChevronRight className="size-3" /> imports flow left → right</div>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
