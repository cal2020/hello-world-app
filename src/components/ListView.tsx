import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { Module, Scan } from "../../shared/types";
import { violationsByModule } from "../lib/graph";
import { Badge, Path, Toggle, cx, inputCls } from "./ui";

type SortKey = "id" | "fanIn" | "fanOut" | "instability" | "violations";
const ROW = 38;

export function ListView({ scan, selected, onSelect }: { scan: Scan; selected: string | null; onSelect: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [onlyV, setOnlyV] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "violations", dir: -1 });
  const [scrollTop, setScrollTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const vmap = useMemo(() => violationsByModule(scan.violations), [scan]);

  const rows = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = scan.modules.filter((m) => (showExt || m.kind === "local" || m.kind === "unresolved") && terms.every((t) => m.id.toLowerCase().includes(t)));
    if (onlyV) list = list.filter((m) => vmap.has(m.id));
    const val = (m: Module) => (sort.key === "violations" ? (vmap.get(m.id)?.length ?? 0) : m[sort.key]);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return (c || a.id.localeCompare(b.id)) * (c ? sort.dir : 1);
    });
  }, [scan, q, onlyV, showExt, sort, vmap]);

  const height = box.current?.clientHeight ?? 800;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 8);

  const Th = ({ k, children, className }: { k: SortKey; children: string; className?: string }) => (
    <th scope="col" aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={cx("px-3 font-medium", className)}>
      <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort({ key: k, dir: sort.key === k ? ((-sort.dir) as 1 | -1) : k === "id" ? 1 : -1 })}>
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selected);
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (n) {
      onSelect(n.id);
      const idx = rows.indexOf(n);
      const el = box.current!;
      if (idx * ROW < el.scrollTop) el.scrollTop = idx * ROW;
      if ((idx + 1) * ROW > el.scrollTop + el.clientHeight - ROW) el.scrollTop = (idx + 2) * ROW - el.clientHeight;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-3" aria-hidden />
          <input className={cx(inputCls, "pl-9")} placeholder="Filter by path (space-separated terms)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter modules by path" />
        </div>
        <Toggle checked={onlyV} onChange={setOnlyV} label="With violations" />
        <Toggle checked={showExt} onChange={setShowExt} label="Packages" />
        <span className="text-[12px] text-fg-3">{rows.length.toLocaleString()} modules</span>
      </div>
      <div ref={box} className="scroll-thin relative flex-1 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} tabIndex={0} onKeyDown={onKey} aria-label="Modules table">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-panel-solid/95 text-left text-[11.5px] text-fg-3 backdrop-blur">
            <tr className="h-9">
              <Th k="id" className="w-full">Module</Th>
              <Th k="violations">Violations</Th>
              <Th k="fanIn">Importers</Th>
              <Th k="fanOut">Imports</Th>
              <Th k="instability">Instability</Th>
              <th scope="col" className="px-3 font-medium">Cycle</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ height: start * ROW }} aria-hidden />
            {rows.slice(start, end).map((m) => {
              const vs = vmap.get(m.id)?.length ?? 0;
              return (
                <tr
                  key={m.id}
                  style={{ height: ROW }}
                  onClick={() => onSelect(m.id)}
                  aria-selected={selected === m.id}
                  className={cx("cursor-pointer transition-colors", selected === m.id ? "bg-accent-soft" : "hover:bg-panel-2")}
                >
                  <td className="max-w-0 border-b border-line px-3">
                    <div className="flex items-center gap-2">
                      {m.kind !== "local" && <Badge tone={m.kind === "unresolved" ? "danger" : "info"}>{m.kind}</Badge>}
                      <Path value={m.id} />
                    </div>
                  </td>
                  <td className="border-b border-line px-3">{vs ? <Badge tone="danger">{vs}</Badge> : <span className="text-fg-3">—</span>}</td>
                  <td className="mono border-b border-line px-3 text-fg-2">{m.fanIn}</td>
                  <td className="mono border-b border-line px-3 text-fg-2">{m.fanOut}</td>
                  <td className="border-b border-line px-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-panel-2">
                        <div className="h-full rounded-full bg-gradient-to-r from-accent-2 to-accent" style={{ width: `${m.instability * 100}%` }} />
                      </div>
                      <span className="mono text-fg-3">{m.instability.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className="border-b border-line px-3">{m.cycle !== null ? <Badge tone="warn">#{m.cycle + 1}</Badge> : <span className="text-fg-3">—</span>}</td>
                </tr>
              );
            })}
            <tr style={{ height: (rows.length - end) * ROW }} aria-hidden />
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-8 text-center text-[13px] text-fg-3">No modules match this filter.</p>}
      </div>
    </div>
  );
}
