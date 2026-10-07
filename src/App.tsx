import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  Command,
  Download,
  FolderSearch,
  GitBranch,
  GitCompareArrows,
  List,
  Menu,
  Moon,
  Network,
  Play,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
} from "lucide-react";
import type { Scan, Violation } from "../shared/types";
import { api, ApiFailure, type RepoListItem } from "./api";
import { autoExpand } from "./lib/graph";
import { ms, shortHash, timeAgo } from "./lib/format";
import { CommandPalette } from "./components/CommandPalette";
import { CompareView } from "./components/CompareView";
import { DetailPane, type Selection } from "./components/DetailPane";
import { GraphView, type GraphState } from "./components/GraphView";
import { ListView } from "./components/ListView";
import { Logo } from "./components/Logo";
import { RulesView } from "./components/RulesView";
import { Sidebar } from "./components/Sidebar";
import { ViolationsView } from "./components/ViolationsView";
import { Badge, Button, EmptyState, Field, IconButton, Kbd, Modal, Notice, cx, inputCls } from "./components/ui";

type Tab = "graph" | "list" | "violations" | "rules" | "compare";
const TABS: { id: Tab; label: string; icon: typeof Network; key: string }[] = [
  { id: "graph", label: "Graph", icon: Network, key: "1" },
  { id: "list", label: "Modules", icon: List, key: "2" },
  { id: "violations", label: "Violations", icon: ShieldAlert, key: "3" },
  { id: "rules", label: "Rules", icon: ShieldCheck, key: "4" },
  { id: "compare", label: "Baseline", icon: GitCompareArrows, key: "5" },
];

const defaultGraph = (): GraphState => ({ expanded: new Set(), showExternals: false, violationsOnly: false, hideTypeOnly: false, focusMode: false, focusDepth: 1 });

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const s = localStorage.getItem("lattice-theme");
      if (s === "dark" || s === "light") return s;
    } catch {
      /* storage unavailable */
    }
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("lattice-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export default function App() {
  const [theme, setTheme] = useTheme();
  const [repos, setRepos] = useState<RepoListItem[] | null>(null);
  const [offline, setOffline] = useState<ApiFailure | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem("lattice-repo"));
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanning, setScanning] = useState<{ started: number } | null>(null);
  const [scanError, setScanError] = useState<ApiFailure | null>(null);
  const [tab, setTabState] = useState<Tab>("graph");
  const [graph, setGraph] = useState<GraphState>(defaultGraph);
  const [selection, setSelection] = useState<Selection>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  // Rules and Baseline show the detail pane as an overlay, so start them without one open.
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (t === "rules" || t === "compare") setSelection(null);
  }, []);
  const [, tick] = useState(0);

  const loadRepos = useCallback(async () => {
    try {
      const r = await api.repos();
      setRepos(r);
      setOffline(null);
      return r;
    } catch (e) {
      setOffline(e as ApiFailure);
      setRepos([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void loadRepos().then((r) => {
      if (!r.length) return;
      if (!activeId || !r.some((x) => x.id === activeId)) setActiveId(r[0].id);
    });
  }, []);

  const active = repos?.find((r) => r.id === activeId) ?? null;

  // Load the latest saved scan when switching repositories.
  useEffect(() => {
    setScan(null);
    setSelection(null);
    setScanError(null);
    setBaselineId(null);
    if (!activeId) return;
    try {
      localStorage.setItem("lattice-repo", activeId);
    } catch {
      /* ignore */
    }
    setScanLoading(true);
    api
      .latestScan(activeId)
      .then((s) => {
        setScan(s);
        if (s) setGraph({ ...defaultGraph(), expanded: autoExpand(s.modules) });
      })
      .catch((e) => setScanError(e as ApiFailure))
      .finally(() => setScanLoading(false));
  }, [activeId]);

  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [scanning]);

  const runScan = useCallback(async () => {
    if (!activeId || scanning) return;
    const c = new AbortController();
    scanAbort.current = c;
    setScanning({ started: performance.now() });
    setScanError(null);
    try {
      const s = await api.scan(activeId, c.signal);
      const keepExpansion = scan && scan.repositoryId === s.repositoryId;
      setScan(s);
      setGraph((g) => (keepExpansion ? g : { ...defaultGraph(), expanded: autoExpand(s.modules) }));
      setSelection((sel) => {
        if (sel?.type === "violation") {
          const v = s.violations.find((x) => x.key === sel.violation.key);
          return v ? { type: "violation", violation: v } : null;
        }
        if (sel?.type === "module" && !s.modules.some((m) => m.id === sel.id)) return null;
        return sel;
      });
    } catch (e) {
      const err = e as ApiFailure;
      if (err.code !== "cancelled") setScanError(err);
    } finally {
      setScanning(null);
      void loadRepos();
    }
  }, [activeId, scanning, scan, loadRepos]);

  const cancelScan = () => {
    if (activeId) void api.cancelScan(activeId).catch(() => undefined);
    scanAbort.current?.abort();
  };

  const selectModule = useCallback((id: string) => {
    if (id.startsWith("dir:")) setSelection({ type: "folder", dir: id.slice(4) });
    else setSelection({ type: "module", id: id.replace(/^(unresolved|npm|core):/, "") });
  }, []);
  const selectViolation = useCallback((v: Violation) => setSelection({ type: "violation", violation: v }), []);
  const focusGraph = (id: string) => {
    setTab("graph");
    setSelection({ type: "module", id });
    setGraph((g) => ({ ...g, focusMode: true, violationsOnly: false }));
  };

  const graphSelectedId = selection?.type === "module" ? selection.id : selection?.type === "folder" ? `dir:${selection.dir}` : selection?.type === "violation" ? selection.violation.from : null;

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input,textarea,select,[contenteditable]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((x) => !x);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const t = TABS.find((x) => x.key === e.key);
      if (t) setTab(t.id);
      else if (e.key === "/") (e.preventDefault(), setPaletteOpen(true));
      else if (e.key === "Escape") setSelection(null);
      else if (e.key.toLowerCase() === "s" && active) void runScan();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, runScan]);

  const actions = useMemo(
    () => [
      { id: "scan", label: "Scan repository", hint: "S", run: () => void runScan() },
      ...TABS.map((t) => ({ id: `tab-${t.id}`, label: `Go to ${t.label}`, hint: t.key, run: () => setTab(t.id) })),
      { id: "register", label: "Register a repository", run: () => setRegisterOpen(true) },
      { id: "theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`, run: () => setTheme(theme === "dark" ? "light" : "dark") },
    ],
    [runScan, theme, setTheme],
  );

  const violationCount = scan?.violations.length ?? 0;
  const warnNotes = scan?.notes.filter((n) => n.level !== "info") ?? [];

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className={cx("glass fixed inset-y-0 left-0 z-40 w-[264px] border-y-0 border-l-0 transition-transform lg:static lg:translate-x-0 lg:rounded-none", navOpen ? "translate-x-0" : "-translate-x-full")}>
        <Sidebar
          repos={repos ?? []}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setNavOpen(false);
          }}
          onRegister={() => {
            setNavOpen(false);
            setRegisterOpen(true);
          }}
          onChanged={async () => {
            const r = await loadRepos();
            if (!r.some((x) => x.id === activeId)) setActiveId(r[0]?.id ?? null);
          }}
        />
      </div>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
          <IconButton label="Open navigation" className="lg:hidden" onClick={() => setNavOpen(true)}>
            <Menu className="size-4" />
          </IconButton>
          {active ? (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-semibold tracking-tight">{active.name}</h1>
                {scan && (
                  <span className="hidden sm:inline">
                    <Badge className="whitespace-nowrap" tone={scan.counts.errors ? "danger" : scan.counts.warnings ? "warn" : "ok"}>
                      {scan.counts.errors ? `${scan.counts.errors} errors` : scan.counts.warnings ? `${scan.counts.warnings} warnings` : "clean"}
                    </Badge>
                  </span>
                )}
              </div>
              <ScanMeta scan={scan} root={active.root} />
            </div>
          ) : (
            <h1 className="text-[15px] font-semibold">Lattice</h1>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setPaletteOpen(true)}
              className="hidden h-9 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 text-[12.5px] text-fg-3 transition hover:text-fg md:flex"
              aria-label="Search modules (Ctrl+K)"
            >
              <Command className="size-3.5" /> Search modules <Kbd>⌘K</Kbd>
            </button>
            {scan && (
              <div className="relative">
                <Button variant="ghost" icon={<Download className="size-4" />} onClick={() => setExportOpen((x) => !x)} aria-expanded={exportOpen} aria-haspopup="menu">
                  <span className="hidden sm:inline">Export</span>
                  <ChevronDown className="size-3.5" />
                </Button>
                {exportOpen && (
                  <div role="menu" className="glass absolute top-11 right-0 z-30 w-64 overflow-hidden rounded-xl bg-panel-solid p-1" onMouseLeave={() => setExportOpen(false)}>
                    {[
                      { href: api.reportUrl(scan.id, "md", baselineId ?? undefined), label: "Report (Markdown)", sub: baselineId ? "includes baseline comparison" : "violations, cycles, notes" },
                      { href: api.reportUrl(scan.id, "json", baselineId ?? undefined), label: "Report (JSON)", sub: "machine-readable snapshot" },
                      { href: api.configExportUrl(scan.repositoryId), label: "Rules (detangle.toml)", sub: "works with npx detangle check" },
                    ].map((x) => (
                      <a key={x.label} role="menuitem" href={x.href} onClick={() => setExportOpen(false)} className="block rounded-lg px-3 py-2 hover:bg-panel-2">
                        <div className="text-[13px] font-medium">{x.label}</div>
                        <div className="text-[11.5px] text-fg-3">{x.sub}</div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
            <IconButton label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </IconButton>
            {active &&
              (scanning ? (
                <Button variant="secondary" icon={<Square className="size-3.5 fill-current" />} onClick={cancelScan}>
                  Cancel <span className="mono text-fg-3 tabular-nums">{((performance.now() - scanning.started) / 1000).toFixed(1)}s</span>
                </Button>
              ) : (
                <Button variant="primary" icon={<Play className="size-3.5 fill-current" />} onClick={runScan}>
                  {scan ? "Rescan" : "Scan"}
                </Button>
              ))}
          </div>
        </header>
        {scanning && <div className="progress-indeterminate relative h-0.5 overflow-hidden bg-transparent" role="progressbar" aria-label="Scanning" />}

        {offline ? (
          <div className="p-6">
            <Notice level="error" title={offline.message}>{offline.hint}</Notice>
          </div>
        ) : repos === null ? null : !active ? (
          <Welcome onRegister={() => setRegisterOpen(true)} onRegistered={async (id) => (await loadRepos(), setActiveId(id))} />
        ) : (
          <>
            {/* Tabs */}
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 sm:px-3" role="tablist" aria-label="Workspace views">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cx(
                    "relative flex h-11 shrink-0 items-center gap-2 px-3 text-[13px] font-medium transition",
                    tab === t.id ? "text-fg" : "text-fg-3 hover:text-fg-2",
                  )}
                >
                  <t.icon className="size-4" aria-hidden />
                  {t.label}
                  {t.id === "violations" && violationCount > 0 && <Badge tone="danger">{violationCount}</Badge>}
                  {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-accent to-accent-2" />}
                </button>
              ))}
              {warnNotes.length > 0 && (
                <button onClick={() => setNotesOpen(!notesOpen)} className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-warn hover:bg-warn-soft" aria-expanded={notesOpen}>
                  <AlertTriangle className="size-3.5" /> {warnNotes.length} scan note{warnNotes.length > 1 ? "s" : ""}
                </button>
              )}
              {scan && !warnNotes.length && scan.notes.length > 0 && (
                <button onClick={() => setNotesOpen(!notesOpen)} className="ml-auto shrink-0 rounded-lg px-2.5 py-1 text-[12px] text-fg-3 hover:bg-panel-2" aria-expanded={notesOpen}>
                  {scan.notes.length} note{scan.notes.length > 1 ? "s" : ""}
                </button>
              )}
            </div>

            {(scanError || (notesOpen && scan?.notes.length)) && (
              <div className="space-y-2 border-b border-line p-3">
                {scanError && (
                  <Notice level="error" title={scanError.message} onClose={() => setScanError(null)}>
                    {scanError.hint}
                  </Notice>
                )}
                {notesOpen &&
                  scan?.notes.map((n, i) => (
                    <Notice key={i} level={n.level} title={n.message}>
                      {n.hint}
                    </Notice>
                  ))}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <main className="relative min-w-0 flex-1" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
                {tab === "rules" ? (
                  <RulesView repoId={active.id} scan={scan} onSaved={() => void runScan()} onSelectViolation={selectViolation} />
                ) : tab === "compare" ? (
                  <CompareView repoId={active.id} scan={scan} onSelectViolation={selectViolation} baselineId={baselineId} setBaselineId={setBaselineId} />
                ) : !scan ? (
                  scanLoading ? null : (
                    <EmptyState
                      icon={<FolderSearch className="size-6" />}
                      title={scanning ? "Scanning…" : "Ready to scan"}
                      action={!scanning && <Button variant="primary" icon={<Play className="size-3.5 fill-current" />} onClick={runScan}>Scan {active.name}</Button>}
                    >
                      The Detangle engine reads the import graph statically. No repository scripts, installs or builds are run.
                    </EmptyState>
                  )
                ) : tab === "graph" ? (
                  <GraphView scan={scan} state={graph} setState={setGraph} selected={graphSelectedId} onSelect={(id) => (id ? selectModule(id) : setSelection(null))} onSwitchToList={() => setTab("list")} />
                ) : tab === "list" ? (
                  <ListView scan={scan} selected={selection?.type === "module" ? selection.id : null} onSelect={selectModule} />
                ) : (
                  <ViolationsView scan={scan} selectedKey={selection?.type === "violation" ? selection.violation.key : null} onSelect={selectViolation} />
                )}
              </main>
              {scan && selection && (
                <div
                  className={cx(
                    "glass fixed inset-x-0 bottom-0 z-30 max-h-[70vh] rounded-t-2xl border-b-0",
                    tab === "rules" || tab === "compare"
                      ? "md:inset-x-auto md:top-14 md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:rounded-l-2xl md:shadow-2xl"
                      : "xl:static xl:z-auto xl:max-h-none xl:w-[380px] xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0",
                  )}
                >
                  <DetailPane scan={scan} selection={selection} onSelectModule={selectModule} onSelectViolation={selectViolation} onFocusGraph={focusGraph} onClose={() => setSelection(null)} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <RegisterModal open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={async (id) => (await loadRepos(), setActiveId(id), setRegisterOpen(false))} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} scan={scan} actions={actions} onModule={(id) => (selectModule(id), tab === "rules" || tab === "compare" ? setTab("graph") : null)} onViolation={selectViolation} />
    </div>
  );
}

function ScanMeta({ scan, root }: { scan: Scan | null; root: string }) {
  if (!scan) return <div className="mono truncate text-[11px] text-fg-3">{root}</div>;
  return (
    <div className="flex items-center gap-x-2 overflow-hidden text-[11px] whitespace-nowrap text-fg-3">
      <span title={new Date(scan.startedAt).toLocaleString()}>Scanned {timeAgo(scan.startedAt)}</span>
      <span aria-hidden>·</span>
      <span title="Engine time (scan + graph); total including rule check in parentheses">
        {ms(scan.engineMs.scan + scan.engineMs.graph)} <span className="hidden sm:inline">({ms(scan.durationMs)} total)</span>
      </span>
      <span aria-hidden className="hidden sm:inline">·</span>
      <span className="hidden items-center gap-1 sm:inline-flex" title={scan.source.commit ?? "Not a git checkout (git is never executed)"}>
        <GitBranch className="size-3" />
        {scan.source.commit ? `${scan.source.branch ?? "detached"}@${shortHash(scan.source.commit)}` : "no git"}
      </span>
      <span aria-hidden className="hidden md:inline">·</span>
      <span className="mono hidden md:inline" title="Policy hash: changes when rules change (comments ignored)">
        rules {scan.config.source === "file" ? scan.config.policyHash.slice(0, 8) : "built-in"}
      </span>
      <span aria-hidden className="hidden md:inline">·</span>
      <span className="hidden md:inline">detangle {scan.engineVersion}</span>
    </div>
  );
}

type Fixture = { name: string; path: string; description: string };

function useFixtures() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  useEffect(() => {
    fetch("/api/fixtures")
      .then((r) => (r.ok ? r.json() : []))
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);
  return fixtures;
}

function Welcome({ onRegister, onRegistered }: { onRegister: () => void; onRegistered: (id: string) => void }) {
  const fixtures = useFixtures();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const use = async (f: Fixture) => {
    setBusy(f.name);
    try {
      const r = await api.register(f.path, f.name);
      onRegistered(r.id);
    } catch (e) {
      setError(e as ApiFailure);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="scroll-thin flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-5 py-12 sm:py-20">
        <div className="rise flex flex-col items-start">
          <Logo size={44} />
          <h2 className="mt-6 text-[34px] leading-[1.1] font-semibold tracking-tight sm:text-[44px]">
            See your architecture.
            <br />
            <span className="gradient-text">Keep it that way.</span>
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-fg-2">
            Lattice maps every import in a JavaScript/TypeScript repository, explains cycles and boundary violations with the exact import path, and lets you design rules visually — previewed against the real engine before anything is saved.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" icon={<FolderSearch className="size-4" />} onClick={onRegister}>
              Register a repository
            </Button>
          </div>
        </div>
        {error && <div className="mt-6"><Notice level="error" title={error.message}>{error.hint}</Notice></div>}
        {fixtures.length > 0 && (
          <div className="mt-12">
            <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-fg-3 uppercase">
              <Sparkles className="size-3.5 text-accent" /> Or explore a bundled demo project
              <Badge>synthetic data</Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {fixtures.map((f, i) => (
                <button
                  key={f.name}
                  onClick={() => use(f)}
                  disabled={!!busy}
                  style={{ animationDelay: `${i * 40}ms` }}
                  className="rise glass group rounded-2xl p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/40"
                >
                  <div className="flex items-center gap-2">
                    {f.name === "clean-app" ? <CircleCheck className="size-4 text-ok" /> : <Network className="size-4 text-accent" />}
                    <span className="mono text-[13px] font-semibold">{f.name}</span>
                    {busy === f.name && <span className="text-[11px] text-fg-3">registering…</span>}
                  </div>
                  <p className="mt-1.5 text-[12.5px] text-fg-2">{f.description.replace(/^Synthetic fixture — (.)/, (_, c: string) => c.toUpperCase())}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RegisterModal({ open, onClose, onRegistered }: { open: boolean; onClose: () => void; onRegistered: (id: string) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const fixtures = useFixtures();
  useEffect(() => {
    if (open) (setError(null), setPath(""), setName(""));
  }, [open]);
  const submit = async (p = path, n = name) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.register(p, n || undefined);
      onRegistered(r.id);
    } catch (e) {
      setError(e as ApiFailure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Register a repository">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Project root (absolute path)" htmlFor="reg-path" error={error ? `${error.message}${error.hint ? ` ${error.hint}` : ""}` : undefined} hint="The folder containing package.json or detangle.toml. Lattice only reads inside registered roots.">
          <input id="reg-path" className={cx(inputCls, "mono")} placeholder="/home/you/code/web-app" value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Display name (optional)" htmlFor="reg-name">
          <input id="reg-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!path.trim()}>
            Register
          </Button>
        </div>
        {fixtures.length > 0 && (
          <div className="border-t border-line pt-4">
            <div className="mb-2 text-[12px] text-fg-3">Bundled demo projects (synthetic):</div>
            <div className="flex flex-wrap gap-1.5">
              {fixtures.map((f) => (
                <button type="button" key={f.name} className="mono rounded-md border border-line bg-panel-2 px-2 py-1 text-[11.5px] text-fg-2 hover:text-fg" onClick={() => submit(f.path, f.name)}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}


