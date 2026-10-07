import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, FileDiff, Layers, Lock, Pencil, Play, Plus, RefreshCw, Save, ShieldCheck, Trash2, Unlink } from "lucide-react";
import type { ConfigRule, RuleDraft, RulePreview, RulesState, RuleTemplate, Scan, Severity, Violation } from "../../shared/types";
import { api, ApiFailure, type RuleEdit } from "../api";
import { Badge, Button, EmptyState, Field, Notice, Path, SeverityBadge, Segmented, cx, inputCls } from "./ui";

const templates: { id: RuleTemplate; title: string; blurb: string; icon: typeof Layers }[] = [
  { id: "isolate-siblings", title: "Isolate sibling folders", blurb: "Sub-folders of a folder may not import each other (e.g. features).", icon: Layers },
  { id: "forbid-path", title: "Forbid imports between paths", blurb: "Modules matching A may not import modules matching B.", icon: Ban },
  { id: "no-cycles", title: "No import cycles", blurb: "Report every import that sits on a cycle.", icon: RefreshCw },
  { id: "no-unresolved", title: "No unresolved imports", blurb: "Every import must resolve to a file or package.", icon: Unlink },
];

const blank = (t: RuleTemplate): RuleDraft => ({
  template: t,
  name: { "isolate-siblings": "no-cross-feature", "forbid-path": "no-ui-to-data", "no-cycles": "no-circular", "no-unresolved": "no-unresolved" }[t],
  severity: t === "no-cycles" ? "warn" : "error",
  comment: "",
});

function suggestFolders(scan: Scan | null): string[] {
  if (!scan) return [];
  const kids = new Map<string, Set<string>>();
  for (const m of scan.modules) {
    if (m.kind !== "local") continue;
    const parts = m.id.split("/");
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i).join("/");
      (kids.get(parent) ?? kids.set(parent, new Set()).get(parent)!).add(parts[i]);
    }
  }
  return [...kids.entries()].filter(([, s]) => s.size >= 2).map(([p]) => p).sort((a, b) => (kids.get(b)!.size - kids.get(a)!.size) || a.localeCompare(b)).slice(0, 30);
}

/** Client-side pattern check, labeled as approximate: the engine's preview is authoritative. */
function countMatches(scan: Scan | null, pattern?: string) {
  if (!scan || !pattern) return null;
  try {
    const re = new RegExp(pattern.replace(/\$\d/g, "[^/]+"));
    return scan.modules.filter((m) => m.kind === "local" && re.test(m.id)).length;
  } catch {
    return null;
  }
}

export function RulesView({ repoId, scan, onSaved, onSelectViolation }: { repoId: string; scan: Scan | null; onSaved: () => void; onSelectViolation: (v: Violation) => void }) {
  const [state, setState] = useState<RulesState | null>(null);
  const [loadError, setLoadError] = useState<ApiFailure | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; draft: RuleDraft } | null>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfigRule | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = async () => {
    try {
      setState(await api.rules(repoId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e as ApiFailure);
    }
  };
  useEffect(() => {
    setState(null);
    setEditing(null);
    setPreview(null);
    void load();
  }, [repoId]);

  const edit: RuleEdit | null = useMemo(() => {
    if (!editing) return null;
    return editing.index === null ? { op: "add", draft: editing.draft } : { op: "update", index: editing.index, draft: editing.draft };
  }, [editing]);
  const editKey = edit ? JSON.stringify(edit) : null;
  const previewCurrent = !!preview && previewFor === editKey;

  const runPreview = async (e: RuleEdit | null = edit) => {
    if (!e) return;
    abort.current?.abort();
    const c = new AbortController();
    abort.current = c;
    setBusy("preview");
    setError(null);
    setSaved(null);
    try {
      const p = await api.previewRule(repoId, e, c.signal);
      setPreview(p);
      setPreviewFor(JSON.stringify(e));
    } catch (err) {
      if ((err as ApiFailure).code !== "cancelled") setError(err as ApiFailure);
    } finally {
      if (abort.current === c) setBusy(null);
    }
  };

  const save = async (e: RuleEdit | null = edit) => {
    if (!e || !preview) return;
    setBusy("save");
    setError(null);
    try {
      const r = await api.saveRule(repoId, e, preview.baseTextHash);
      setSaved(r.backup ? `Saved. Previous file backed up to ${r.backup}` : "Created detangle.toml.");
      setEditing(null);
      setPreview(null);
      setConfirmDelete(null);
      await load();
      onSaved();
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(null);
    }
  };

  const startDelete = async (r: ConfigRule) => {
    setConfirmDelete(r);
    setEditing(null);
    await runPreview({ op: "delete", index: r.index });
  };

  if (loadError) return <div className="p-4"><Notice level="error" title={loadError.message}>{loadError.hint}</Notice></div>;
  if (!state) return <div className="p-6 text-[13px] text-fg-3">Loading rules…</div>;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(280px,360px)_1fr]">
      {/* Rule list */}
      <div className={cx("scroll-thin min-h-0 overflow-auto border-line p-4 lg:border-r", editing && "hidden lg:block")}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Architecture rules</h2>
            <p className="mono text-[11.5px] text-fg-3">{state.exists ? "detangle.toml" : "built-in rules (no detangle.toml)"}</p>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={!!state.unsupported}
            onClick={() => {
              setEditing({ index: null, draft: blank("isolate-siblings") });
              setPreview(null);
              setConfirmDelete(null);
            }}
          >
            New rule
          </Button>
        </div>
        {state.unsupported && <Notice level="warn" title="Visual editing is disabled for this file">{state.unsupported}</Notice>}
        {saved && <div className="mb-3"><Notice level="info" title={saved} onClose={() => setSaved(null)} /></div>}
        {state.usesBuiltinRules && (
          <Notice level="info" title="Using the engine's built-in rules">
            Cycles, unresolved imports, undeclared packages, dev-dependency use, test imports and orphans are checked. Saving your first rule creates detangle.toml with these defaults plus your rule.
          </Notice>
        )}
        <ul className="mt-3 space-y-2">
          {state.rules.map((r) => (
            <li key={`${r.kind}-${r.index}`} className={cx("glass rounded-xl p-3 transition", editing?.index === r.index && r.kind === "forbidden" && "!border-accent")}>
              <div className="flex items-center gap-2">
                {r.severity && <SeverityBadge severity={r.severity} />}
                <span className="mono truncate text-[12.5px] font-semibold">{r.name ?? `${r.kind} #${r.index + 1}`}</span>
                {r.kind !== "forbidden" && <Badge>{r.kind}</Badge>}
                <div className="ml-auto flex shrink-0 gap-0.5">
                  {r.editable ? (
                    <>
                      <button aria-label={`Edit ${r.name}`} className="rounded-md p-1.5 text-fg-3 hover:bg-panel-2 hover:text-fg" onClick={() => (setEditing({ index: r.index, draft: { ...r.draft!, comment: r.draft!.comment ?? "" } }), setPreview(null), setConfirmDelete(null))}>
                        <Pencil className="size-3.5" />
                      </button>
                      <button aria-label={`Delete ${r.name}`} className="rounded-md p-1.5 text-fg-3 hover:bg-danger-soft hover:text-danger" onClick={() => startDelete(r)}>
                        <Trash2 className="size-3.5" />
                      </button>
                    </>
                  ) : (
                    <span title={r.notEditableReason} className="p-1.5 text-fg-3">
                      <Lock className="size-3.5" aria-label={r.notEditableReason} />
                    </span>
                  )}
                </div>
              </div>
              {r.comment && <p className="mt-1.5 line-clamp-2 text-[12px] text-fg-2">{r.comment}</p>}
              <RuleSummary table={r.table} />
              {!r.editable && r.notEditableReason && <p className="mt-1.5 text-[11px] text-fg-3">{r.notEditableReason}</p>}
            </li>
          ))}
        </ul>
        {state.exists && state.rules.length === 0 && <p className="mt-4 text-[12.5px] text-fg-3">This detangle.toml has no rules yet.</p>}
        {state.exists && (
          <details className="mt-4">
            <summary className="cursor-pointer text-[12px] text-fg-3 hover:text-fg">View raw detangle.toml</summary>
            <pre className="mono scroll-thin mt-2 max-h-80 overflow-auto rounded-xl border border-line bg-panel-2 p-3 text-[11.5px] leading-relaxed">{state.text}</pre>
          </details>
        )}
      </div>

      {/* Editor + preview */}
      <div className="scroll-thin min-h-0 overflow-auto p-4">
        {!editing && !confirmDelete && (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Design a boundary" action={!state.unsupported && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ index: null, draft: blank("isolate-siblings") })}>New rule</Button>}>
            Rules are built with structured controls, previewed against the real engine, and saved to detangle.toml only after you review the diff.
          </EmptyState>
        )}

        {confirmDelete && (
          <div className="mx-auto max-w-3xl space-y-4">
            <h2 className="text-[16px] font-semibold">Delete rule “{confirmDelete.name}”</h2>
            {error && <Notice level="error" title={error.message}>{error.hint}</Notice>}
            {busy === "preview" && <Progress label="Running the engine with the rule removed…" />}
            {preview && <PreviewPanel preview={preview} onSelectViolation={onSelectViolation} />}
            <div className="flex gap-2">
              <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy === "save"} disabled={!preview?.ok || busy !== null} onClick={() => save({ op: "delete", index: confirmDelete.index })}>
                Delete from detangle.toml
              </Button>
              <Button variant="ghost" onClick={() => (setConfirmDelete(null), setPreview(null))}>Cancel</Button>
            </div>
          </div>
        )}

        {editing && (
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">{editing.index === null ? "New rule" : `Edit “${state.rules.find((r) => r.kind === "forbidden" && r.index === editing.index)?.name}”`}</h2>
              <Button variant="ghost" size="sm" onClick={() => (setEditing(null), setPreview(null))}>Cancel</Button>
            </div>
            {editing.index === null && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Rule type">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={editing.draft.template === t.id}
                    onClick={() => setEditing({ index: null, draft: { ...blank(t.id), comment: editing.draft.comment } })}
                    className={cx(
                      "flex gap-3 rounded-xl border p-3 text-left transition",
                      editing.draft.template === t.id ? "border-accent bg-accent-soft" : "border-line bg-panel-2 hover:border-line-strong",
                    )}
                  >
                    <t.icon className={cx("mt-0.5 size-4 shrink-0", editing.draft.template === t.id ? "text-accent" : "text-fg-3")} />
                    <span>
                      <span className="block text-[13px] font-medium">{t.title}</span>
                      <span className="block text-[12px] text-fg-2">{t.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <DraftForm draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} scan={scan} />
            {error && <Notice level="error" title={error.message}>{error.hint}</Notice>}
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<Play className="size-4" />} loading={busy === "preview"} onClick={() => runPreview()}>
                Preview with engine
              </Button>
              <Button variant="primary" icon={<Save className="size-4" />} loading={busy === "save"} disabled={!previewCurrent || !preview?.ok || busy !== null} onClick={() => save()}>
                {state.exists ? "Save to detangle.toml" : "Create detangle.toml"}
              </Button>
              {!previewCurrent && preview && <span className="text-[12px] text-warn">The rule changed since the preview — preview again to save.</span>}
              {!preview && <span className="text-[12px] text-fg-3">Saving requires a current preview.</span>}
            </div>
            {busy === "preview" && <Progress label="Running the engine with the proposed configuration…" />}
            {preview && previewCurrent && <PreviewPanel preview={preview} onSelectViolation={onSelectViolation} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status">
      <div className="progress-indeterminate relative h-1 overflow-hidden rounded-full bg-panel-2" />
      <p className="text-[12px] text-fg-3">{label}</p>
    </div>
  );
}

function RuleSummary({ table }: { table: Record<string, unknown> }) {
  const fmt = (o: unknown) =>
    o && typeof o === "object"
      ? Object.entries(o as Record<string, unknown>)
          .map(([k, v]) => `${k} = ${typeof v === "string" ? `'${v}'` : JSON.stringify(v)}`)
          .join(", ")
      : null;
  const rows = (["module", "from", "to"] as const).map((k) => [k, fmt(table[k])] as const).filter(([, v]) => v);
  if (!rows.length) return null;
  return (
    <dl className="mt-2 space-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px]">
          <dt className="w-9 shrink-0 text-fg-3">{k}</dt>
          <dd className="mono min-w-0 break-all text-fg-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DraftForm({ draft, onChange, scan }: { draft: RuleDraft; onChange: (d: RuleDraft) => void; scan: Scan | null }) {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...draft, [k]: v });
  const folders = useMemo(() => suggestFolders(scan), [scan]);
  const MatchHint = ({ p }: { p?: string }) => {
    const n = countMatches(scan, p);
    return n === null ? null : <span>{p ? `Pattern matches ~${n} module${n === 1 ? "" : "s"} in the last scan (approximate; the engine preview is authoritative).` : null}</span>;
  };
  return (
    <div className="glass space-y-4 rounded-2xl p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Rule name" htmlFor="rule-name" hint="Letters, digits and dashes. Shown on every violation.">
          <input id="rule-name" className={cx(inputCls, "mono")} value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={64} />
        </Field>
        <Field label="Severity">
          <Segmented<Severity>
            label="Severity"
            value={draft.severity}
            onChange={(v) => set("severity", v)}
            options={[
              { value: "error", label: "Error", title: "Fails detangle check (CI)" },
              { value: "warn", label: "Warn" },
              { value: "info", label: "Info" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
      </div>

      {draft.template === "isolate-siblings" && (
        <Field label="Parent folder" htmlFor="rule-parent" hint={draft.parentFolder ? <>Each folder under <span className="mono">{draft.parentFolder}/</span> may import itself and anything outside, but not its siblings.</> : "e.g. src/features — pick from the suggestions."}>
          <input id="rule-parent" list="folder-suggestions" className={cx(inputCls, "mono")} placeholder="src/features" value={draft.parentFolder ?? ""} onChange={(e) => set("parentFolder", e.target.value)} />
          <datalist id="folder-suggestions">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {folders.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {folders.slice(0, 8).map((f) => (
                <button key={f} onClick={() => set("parentFolder", f)} className={cx("mono rounded-md border px-2 py-0.5 text-[11.5px] transition", draft.parentFolder === f ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel-2 text-fg-2 hover:text-fg")}>
                  {f}/
                </button>
              ))}
            </div>
          )}
        </Field>
      )}

      {draft.template === "forbid-path" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-line p-3">
            <div className="text-[12px] font-semibold text-fg">Source modules</div>
            <Field label="Path matches (regex)" htmlFor="from-path" hint={<MatchHint p={draft.fromPath} />}>
              <input id="from-path" className={cx(inputCls, "mono")} placeholder="^src/ui/" value={draft.fromPath ?? ""} onChange={(e) => set("fromPath", e.target.value)} />
            </Field>
            <Field label="Except paths matching" htmlFor="from-path-not">
              <input id="from-path-not" className={cx(inputCls, "mono")} placeholder="\.test\.ts$" value={draft.fromPathNot ?? ""} onChange={(e) => set("fromPathNot", e.target.value)} />
            </Field>
          </div>
          <div className="space-y-3 rounded-xl border border-danger/25 p-3">
            <div className="text-[12px] font-semibold text-danger">May not import</div>
            <Field label="Path matches (regex)" htmlFor="to-path" hint={<MatchHint p={draft.toPath} />}>
              <input id="to-path" className={cx(inputCls, "mono")} placeholder="^src/data/" value={draft.toPath ?? ""} onChange={(e) => set("toPath", e.target.value)} />
            </Field>
            <Field label="Except paths matching" htmlFor="to-path-not" hint="$1…$9 refer to capture groups of the source pattern.">
              <input id="to-path-not" className={cx(inputCls, "mono")} placeholder="^src/data/types\.ts$" value={draft.toPathNot ?? ""} onChange={(e) => set("toPathNot", e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      {draft.template === "no-cycles" && (
        <Field label="Only cycles passing through (optional regex)" htmlFor="via" hint="Leave empty to report every cycle. Type-only imports are excluded unless options.cycles_ignore_type_only = false.">
          <input id="via" className={cx(inputCls, "mono")} placeholder="^src/shared/" value={draft.via ?? ""} onChange={(e) => set("via", e.target.value)} />
        </Field>
      )}

      <Field label="Reason (shown with each violation)" htmlFor="rule-comment">
        <input id="rule-comment" className={inputCls} placeholder="Features talk through shared contracts, never directly." value={draft.comment ?? ""} onChange={(e) => set("comment", e.target.value)} maxLength={500} />
      </Field>
    </div>
  );
}

function PreviewPanel({ preview, onSelectViolation }: { preview: RulePreview; onSelectViolation: (v: Violation) => void }) {
  const [showDiff, setShowDiff] = useState(true);
  const diffLines = preview.diff.split("\n").slice(4);
  return (
    <div className="rise space-y-4">
      {!preview.ok ? (
        <Notice level="error" title="The engine rejected this configuration">
          <pre className="mono mt-1 text-[11.5px] whitespace-pre-wrap">{preview.error}</pre>
        </Notice>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PStat label="New violations" value={preview.added.length} tone={preview.added.length ? "text-danger" : "text-fg"} />
          <PStat label="Would disappear" value={preview.removed.length} tone={preview.removed.length ? "text-ok" : "text-fg"} />
          <PStat label="Severity changes" value={preview.changed.length} tone={preview.changed.length ? "text-warn" : "text-fg"} />
          <PStat label="Unchanged" value={preview.unchangedCount} />
        </div>
      )}
      {preview.ok && (
        <p className="flex items-center gap-1.5 text-[12px] text-fg-3">
          <Check className="size-3.5 text-ok" /> Actual results from <span className="mono">detangle check</span> run with the proposed file, compared with the current one.
        </p>
      )}

      {preview.ok && preview.affectedModules.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-fg-2">Affected paths for this rule ({preview.ruleViolations.length} violation{preview.ruleViolations.length === 1 ? "" : "s"})</h3>
          <ul className="space-y-1">
            {preview.ruleViolations.slice(0, 50).map((v) => (
              <li key={v.key}>
                <button onClick={() => onSelectViolation(v)} className="flex w-full items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-left hover:border-accent/40">
                  <Path value={v.from} className="max-w-[45%]" />
                  {v.to && (
                    <>
                      <span className="text-fg-3">→</span>
                      <Path value={v.to} />
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.ok && preview.removed.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-fg-2">No longer reported</h3>
          <ul className="space-y-1">
            {preview.removed.slice(0, 30).map((v) => (
              <li key={v.key} className="flex items-center gap-2 rounded-lg border border-ok/20 bg-ok-soft px-2.5 py-1.5 text-[12px]">
                <span className="mono font-semibold">{v.rule}</span>
                <Path value={v.from} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-line">
        <button className="flex w-full items-center gap-2 bg-panel-2 px-3 py-2 text-left text-[12px] font-medium" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
          <FileDiff className="size-3.5 text-accent" /> Proposed change to detangle.toml
          <span className="ml-auto text-fg-3">{showDiff ? "Hide" : "Show"}</span>
        </button>
        {showDiff && (
          <pre className="mono scroll-thin max-h-96 overflow-auto bg-panel-solid py-2 text-[11.5px] leading-relaxed">
            {diffLines.map((l, i) => (
              <div
                key={i}
                className={cx(
                  "px-3",
                  l.startsWith("+") ? "bg-ok-soft text-ok" : l.startsWith("-") ? "bg-danger-soft text-danger" : l.startsWith("@@") ? "text-accent" : l.startsWith("\\") ? "text-fg-3 italic" : "text-fg-2",
                )}
              >
                {l || " "}
              </div>
            ))}
          </pre>
        )}
      </section>
    </div>
  );
}

function PStat({ label, value, tone = "text-fg" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5">
      <div className={cx("text-[20px] font-semibold tabular-nums", tone)}>{value}</div>
      <div className="text-[11.5px] text-fg-3">{label}</div>
    </div>
  );
}
