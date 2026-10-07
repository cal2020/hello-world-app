import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Crosshair, FileCode2, Folder, Route, Search, X } from "lucide-react";
import type { PathExplanation, Scan, Violation } from "../../shared/types";
import { api } from "../api";
import { edgeIndex, explain, type Hop } from "../lib/explain";
import { violationsByModule } from "../lib/graph";
import { PathChain } from "./PathChain";
import { Badge, Button, IconButton, Notice, Path, SeverityBadge, cx, inputCls } from "./ui";

export type Selection = { type: "module"; id: string } | { type: "folder"; dir: string } | { type: "violation"; violation: Violation } | null;

interface Props {
  scan: Scan;
  selection: Selection;
  onSelectModule: (id: string) => void;
  onSelectViolation: (v: Violation) => void;
  onFocusGraph: (id: string) => void;
  onClose: () => void;
}

export function DetailPane(props: Props) {
  const { selection, onClose } = props;
  return (
    <aside aria-label="Details" className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-[12px] font-semibold tracking-wider text-fg-3 uppercase">{selection?.type === "violation" ? "Violation" : selection?.type === "folder" ? "Folder" : "Module"}</h2>
        <IconButton label="Close details" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="scroll-thin flex-1 overflow-auto p-4">
        {!selection && <p className="text-[13px] text-fg-3">Select a module, folder or violation to inspect it.</p>}
        {selection?.type === "module" && <ModuleDetail {...props} id={selection.id} />}
        {selection?.type === "folder" && <FolderDetail {...props} dir={selection.dir} />}
        {selection?.type === "violation" && <ViolationDetail {...props} v={selection.violation} />}
      </div>
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 flex items-center gap-2 text-[11.5px] font-semibold tracking-wider text-fg-3 uppercase">
        {title}
        {count !== undefined && <span className="rounded bg-panel-2 px-1.5 text-[10.5px] text-fg-2">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function ViolationDetail({ scan, v, onSelectModule, onFocusGraph }: Props & { v: Violation }) {
  const ex = useMemo(() => explain(v, scan), [v, scan]);
  return (
    <div className="rise">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={v.severity} />
        <span className="mono text-[13px] font-semibold">{v.rule}</span>
        {v.scope !== "module" && <Badge>{v.scope} scope</Badge>}
      </div>
      <h3 className="mt-3 text-[16px] font-semibold tracking-tight">{ex.headline}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{ex.detail}</p>
      {v.comment && (
        <blockquote className="mt-3 rounded-lg border-l-2 border-accent bg-accent-soft px-3 py-2 text-[12.5px] text-fg">
          <span className="text-fg-3">Rule reason: </span>
          {v.comment}
        </blockquote>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <dt className="text-fg-3">Source</dt>
        <dd className="min-w-0">
          <button className="max-w-full truncate hover:underline" onClick={() => onSelectModule(v.from)}>
            <Path value={v.from} />
          </button>
        </dd>
        {v.to && (
          <>
            <dt className="text-fg-3">Destination</dt>
            <dd className="min-w-0">
              {v.category === "unresolved" ? (
                <span className="mono text-danger">“{v.to}”</span>
              ) : (
                <button className="max-w-full truncate hover:underline" onClick={() => onSelectModule(v.to!)}>
                  <Path value={v.to} />
                </button>
              )}
            </dd>
          </>
        )}
      </dl>

      {ex.hops.length > 0 && (
        <Section title={ex.pathSource === "engine-cycle" ? "Shortest loop (from engine)" : ex.pathSource === "group-imports" ? "Imports behind it" : "Offending import"}>
          <PathChain hops={ex.hops} onSelect={onSelectModule} closed={ex.pathSource === "engine-cycle"} />
        </Section>
      )}
      {ex.notes.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {ex.notes.map((n) => (
            <li key={n} className="flex gap-2 text-[12px] text-fg-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-fg-3" />
              {n}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" icon={<Crosshair className="size-3.5" />} onClick={() => onFocusGraph(v.from)}>
          Show in graph
        </Button>
      </div>
    </div>
  );
}

function FolderDetail({ scan, dir, onSelectModule }: Props & { dir: string }) {
  const mods = useMemo(() => scan.modules.filter((m) => m.kind === "local" && m.id.startsWith(`${dir}/`)), [scan, dir]);
  const vmap = useMemo(() => violationsByModule(scan.violations), [scan]);
  const ids = new Set(mods.map((m) => m.id));
  const outgoing = scan.edges.filter((e) => ids.has(e.from) && !ids.has(e.to)).length;
  const incoming = scan.edges.filter((e) => !ids.has(e.from) && ids.has(e.to)).length;
  return (
    <div className="rise">
      <div className="flex items-center gap-2">
        <Folder className="size-4 text-accent" />
        <Path value={`${dir}/`} strong />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Modules" value={mods.length} />
        <Stat label="Imports out" value={outgoing} />
        <Stat label="Imports in" value={incoming} />
      </div>
      <p className="mt-3 text-[12px] text-fg-3">Double-click the folder in the graph (or press its + button) to expand it.</p>
      <Section title="Modules" count={mods.length}>
        <ul className="space-y-1">
          {mods.slice(0, 200).map((m) => (
            <li key={m.id}>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-panel-2" onClick={() => onSelectModule(m.id)}>
                <FileCode2 className="size-3.5 shrink-0 text-fg-3" />
                <Path value={m.id.slice(dir.length + 1)} />
                {vmap.get(m.id) && <Badge tone="danger" className="ml-auto">{vmap.get(m.id)!.length}</Badge>}
              </button>
            </li>
          ))}
        </ul>
        {mods.length > 200 && <p className="mt-2 text-[12px] text-fg-3">Showing 200 of {mods.length}. Use the list view to see all.</p>}
      </Section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 py-2">
      <div className={cx("text-[17px] font-semibold tabular-nums", tone)}>{value}</div>
      <div className="text-[11px] text-fg-3">{label}</div>
    </div>
  );
}

function ModuleDetail({ scan, id, onSelectModule, onSelectViolation, onFocusGraph }: Props & { id: string }) {
  const m = scan.modules.find((x) => x.id === id);
  const imports = useMemo(() => scan.edges.filter((e) => e.from === id), [scan, id]);
  const importers = useMemo(() => scan.edges.filter((e) => e.to === id), [scan, id]);
  const vs = useMemo(() => violationsByModule(scan.violations).get(id) ?? [], [scan, id]);
  if (!m) return <Notice level="info" title="This module isn't in the current scan." />;
  return (
    <div className="rise">
      <div className="flex items-start gap-2">
        <FileCode2 className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="mono text-[13px] font-semibold break-all">{m.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={m.kind === "local" ? "accent" : m.kind === "unresolved" ? "danger" : "info"}>{m.kind}</Badge>
            {m.cycle !== null && <Badge tone="warn">in cycle #{m.cycle + 1}</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Importers" value={m.fanIn} />
        <Stat label="Imports" value={m.fanOut} />
        <Stat label="Instability" value={m.instability.toFixed(2)} />
      </div>
      <div className="mt-3">
        <Button size="sm" icon={<Crosshair className="size-3.5" />} onClick={() => onFocusGraph(id)}>
          Show neighborhood
        </Button>
      </div>

      {vs.length > 0 && (
        <Section title="Violations" count={vs.length}>
          <ul className="space-y-1.5">
            {vs.map((v) => (
              <li key={v.key}>
                <button onClick={() => onSelectViolation(v)} className="w-full rounded-lg border border-danger/25 bg-danger-soft px-2.5 py-2 text-left transition hover:border-danger/50">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={v.severity} />
                    <span className="mono truncate text-[12px] font-semibold">{v.rule}</span>
                  </div>
                  <div className="mt-1 truncate text-[12px] text-fg-2">
                    {v.from === id ? (v.to ? <>→ {v.to}</> : "this module") : <>← from {v.from}</>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Imports" count={imports.length}>
        <EdgeList edges={imports.map((e) => ({ id: e.to, spec: e.specifier, types: e.types, typeOnly: e.typeOnly, circular: e.circular }))} icon={<ArrowUpRight className="size-3.5" />} onSelect={onSelectModule} empty="Imports nothing." />
      </Section>
      <Section title="Imported by" count={importers.length}>
        <EdgeList edges={importers.map((e) => ({ id: e.from, spec: e.specifier, types: e.types, typeOnly: e.typeOnly, circular: e.circular }))} icon={<ArrowDownLeft className="size-3.5" />} onSelect={onSelectModule} empty="Nothing imports this module." />
      </Section>
      {m.kind === "local" && <ExplainPath scan={scan} from={id} onSelectModule={onSelectModule} />}
    </div>
  );
}

function EdgeList({ edges, icon, onSelect, empty }: { edges: { id: string; spec: string; types: string[]; typeOnly: boolean; circular: boolean }[]; icon: React.ReactNode; onSelect: (id: string) => void; empty: string }) {
  if (!edges.length) return <p className="text-[12px] text-fg-3">{empty}</p>;
  return (
    <ul className="space-y-0.5">
      {edges.map((e) => (
        <li key={e.id}>
          <button className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2" onClick={() => onSelect(e.id)} title={`specifier: ${e.spec}`}>
            <span className="text-fg-3 group-hover:text-accent">{icon}</span>
            <Path value={e.id} className="flex-1" />
            {e.typeOnly && <Badge tone="info">type</Badge>}
            {e.types.includes("dynamic") && <Badge>dynamic</Badge>}
            {e.circular && <Badge tone="warn">cycle</Badge>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ExplainPath({ scan, from, onSelectModule }: { scan: Scan; from: string; onSelectModule: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [result, setResult] = useState<PathExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState(true);
  useEffect(() => {
    setTo(null);
    setResult(null);
    setQ("");
  }, [from]);
  const matches = useMemo(() => {
    const t = q.toLowerCase().trim();
    if (!t || to) return [];
    return scan.modules.filter((m) => m.id !== from && m.id.toLowerCase().includes(t)).slice(0, 8);
  }, [q, scan, from, to]);
  const run = async (target: string, withTypes = types) => {
    setTo(target);
    setQ(target);
    setError(null);
    try {
      setResult(await api.path(scan.id, from, target, withTypes));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const idx = useMemo(() => edgeIndex(scan.edges), [scan]);
  const hops: Hop[] = (result?.hops ?? []).map((h) => ({ ...h, typeOnly: idx.get(`${h.from}>${h.to}`)?.typeOnly ?? false }));
  return (
    <Section title="Why does it depend on…">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-3" aria-hidden />
        <input
          className={cx(inputCls, "pl-9")}
          placeholder="Search a target module"
          value={q}
          aria-label="Target module for path explanation"
          onChange={(e) => {
            setQ(e.target.value);
            setTo(null);
            setResult(null);
          }}
        />
        {matches.length > 0 && (
          <ul className="glass absolute inset-x-0 top-10 z-20 overflow-hidden rounded-xl bg-panel-solid py-1" role="listbox">
            {matches.map((m) => (
              <li key={m.id}>
                <button className="flex w-full px-3 py-1.5 text-left hover:bg-panel-2" onClick={() => run(m.id)} role="option" aria-selected={false}>
                  <Path value={m.id} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="mt-2 flex items-center gap-2 text-[12px] text-fg-2">
        <input
          type="checkbox"
          checked={types}
          onChange={(e) => {
            setTypes(e.target.checked);
            if (to) void run(to, e.target.checked);
          }}
          className="accent-[var(--accent)]"
        />
        Follow type-only imports
      </label>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {result && !result.found && <p className="mt-3 text-[12.5px] text-fg-2">{from.split("/").pop()} does not depend on this module{types ? "" : " through runtime imports"}.</p>}
      {result?.found && (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] text-fg-2">
            <Route className="size-3.5 text-accent" /> Shortest chain: {result.hops.length} hop{result.hops.length > 1 ? "s" : ""}
          </div>
          <PathChain hops={hops} onSelect={onSelectModule} />
        </div>
      )}
    </Section>
  );
}
