import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, Search, ShieldAlert } from "lucide-react";
import type { Scan, Violation } from "../../shared/types";
import { Kbd, Path, cx } from "./ui";

type Item = { kind: "module"; id: string } | { kind: "violation"; v: Violation } | { kind: "action"; id: string; label: string; hint?: string };

export function CommandPalette({ open, onClose, scan, actions, onModule, onViolation }: { open: boolean; onClose: () => void; scan: Scan | null; actions: { id: string; label: string; hint?: string; run: () => void }[]; onModule: (id: string) => void; onViolation: (v: Violation) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items: Item[] = useMemo(() => {
    const t = q.toLowerCase().trim();
    const terms = t.split(/\s+/).filter(Boolean);
    const acts = actions.filter((a) => !t || a.label.toLowerCase().includes(t)).map((a) => ({ kind: "action" as const, id: a.id, label: a.label, hint: a.hint }));
    if (!scan || !t) return acts.slice(0, 8);
    const mods = scan.modules
      .filter((m) => terms.every((x) => m.id.toLowerCase().includes(x)))
      .sort((a, b) => Number(b.id.toLowerCase().endsWith(t)) - Number(a.id.toLowerCase().endsWith(t)) || a.id.length - b.id.length)
      .slice(0, 12)
      .map((m) => ({ kind: "module" as const, id: m.id }));
    const vs = scan.violations.filter((v) => terms.every((x) => `${v.rule} ${v.from} ${v.to ?? ""}`.toLowerCase().includes(x))).slice(0, 5).map((v) => ({ kind: "violation" as const, v }));
    return [...acts.slice(0, 3), ...mods, ...vs];
  }, [q, scan, actions]);

  if (!open) return null;
  const choose = (it: Item) => {
    onClose();
    if (it.kind === "module") onModule(it.id);
    else if (it.kind === "violation") onViolation(it.v);
    else actions.find((a) => a.id === it.id)?.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="rise glass w-full max-w-xl overflow-hidden rounded-2xl bg-panel-solid">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-fg-3" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setI(0))}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(items.length - 1, x + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
              if (e.key === "Enter" && items[i]) choose(items[i]);
            }}
            placeholder="Search modules, violations, actions…"
            aria-label="Search"
            aria-activedescendant={items[i] ? `pal-${i}` : undefined}
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul role="listbox" className="scroll-thin max-h-[50vh] overflow-auto p-1.5">
          {items.map((it, idx) => (
            <li key={idx} id={`pal-${idx}`} role="option" aria-selected={idx === i}>
              <button onMouseEnter={() => setI(idx)} onClick={() => choose(it)} className={cx("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left", idx === i && "bg-accent-soft")}>
                {it.kind === "module" && (
                  <>
                    <FileCode2 className="size-4 shrink-0 text-fg-3" /> <Path value={it.id} />
                  </>
                )}
                {it.kind === "violation" && (
                  <>
                    <ShieldAlert className="size-4 shrink-0 text-danger" />
                    <span className="mono shrink-0 text-[12px] font-semibold">{it.v.rule}</span>
                    <Path value={it.v.from} />
                  </>
                )}
                {it.kind === "action" && (
                  <>
                    <span className="size-4 shrink-0 rounded bg-accent-soft" />
                    <span className="text-[13px]">{it.label}</span>
                    {it.hint && <span className="ml-auto"><Kbd>{it.hint}</Kbd></span>}
                  </>
                )}
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-fg-3">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
