import { useState } from "react";
import { FolderGit2, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import type { RepoListItem } from "../api";
import { api, ApiFailure } from "../api";
import { timeAgo } from "../lib/format";
import { Button, Field, Modal, Notice, Toggle, cx, inputCls } from "./ui";
import { Logo } from "./Logo";

export function Sidebar({ repos, activeId, onSelect, onRegister, onChanged }: { repos: RepoListItem[]; activeId: string | null; onSelect: (id: string) => void; onRegister: () => void; onChanged: () => void }) {
  const [settingsFor, setSettingsFor] = useState<RepoListItem | null>(null);
  return (
    <nav aria-label="Repositories" className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo />
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight">Lattice</div>
          <div className="text-[10.5px] text-fg-3">architecture inspector</div>
        </div>
      </div>
      <div className="flex items-center justify-between px-4 pt-2 pb-1.5">
        <span className="text-[11px] font-semibold tracking-wider text-fg-3 uppercase">Repositories</span>
        <button onClick={onRegister} aria-label="Register repository" className="rounded-md p-1 text-fg-3 hover:bg-panel-2 hover:text-fg">
          <Plus className="size-4" />
        </button>
      </div>
      <ul className="scroll-thin flex-1 space-y-0.5 overflow-auto px-2">
        {repos.map((r) => {
          const s = r.latestScan;
          return (
            <li key={r.id} className="group relative">
              <button
                onClick={() => onSelect(r.id)}
                aria-current={r.id === activeId ? "page" : undefined}
                className={cx("flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition", r.id === activeId ? "bg-accent-soft" : "hover:bg-panel-2")}
              >
                <FolderGit2 className={cx("mt-0.5 size-4 shrink-0", r.id === activeId ? "text-accent" : "text-fg-3")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{r.name}</span>
                  <span className="block truncate text-[11px] text-fg-3">
                    {r.scanning ? (
                      <span className="inline-flex items-center gap-1 text-accent">
                        <Loader2 className="size-3 animate-spin" /> scanning
                      </span>
                    ) : s ? (
                      <>
                        {s.counts.localModules} modules ·{" "}
                        <span className={s.counts.errors ? "text-danger" : s.counts.warnings ? "text-warn" : "text-ok"}>
                          {s.counts.errors + s.counts.warnings + s.counts.info} findings
                        </span>{" "}
                        · {timeAgo(s.startedAt)}
                      </>
                    ) : (
                      "not scanned"
                    )}
                  </span>
                </span>
              </button>
              <button
                aria-label={`Settings for ${r.name}`}
                onClick={() => setSettingsFor(r)}
                className="absolute top-2 right-1.5 rounded-md p-1 text-fg-3 opacity-0 transition group-hover:opacity-100 hover:bg-panel-2 hover:text-fg focus:opacity-100"
              >
                <Settings className="size-3.5" />
              </button>
            </li>
          );
        })}
        {repos.length === 0 && <li className="px-3 py-2 text-[12px] text-fg-3">No repositories yet.</li>}
      </ul>
      <div className="border-t border-line p-3 text-[10.5px] leading-relaxed text-fg-3">
        Analysis by <a className="underline hover:text-fg" href="https://github.com/debug-diary-1/detangle" target="_blank" rel="noreferrer">Detangle</a> (MIT/Apache-2.0). Runs locally; nothing leaves this machine.
      </div>
      {settingsFor && <RepoSettings repo={settingsFor} onClose={() => setSettingsFor(null)} onChanged={onChanged} />}
    </nav>
  );
}

function RepoSettings({ repo, onClose, onChanged }: { repo: RepoListItem; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(repo.name);
  const [allow, setAllow] = useState(repo.allowConfigEvaluation);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const save = async () => {
    try {
      await api.updateRepo(repo.id, { name, allowConfigEvaluation: allow });
      onChanged();
      onClose();
    } catch (e) {
      setError(e as ApiFailure);
    }
  };
  return (
    <Modal open onClose={onClose} title="Repository settings">
      <div className="space-y-4">
        <Field label="Display name" htmlFor="repo-name">
          <input id="repo-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <div>
          <div className="text-[12px] font-medium text-fg-2">Root</div>
          <div className="mono mt-1 text-[12px] break-all text-fg">{repo.root}</div>
        </div>
        <div className="rounded-xl border border-warn/30 bg-warn-soft p-3">
          <Toggle checked={allow} onChange={setAllow} label="Allow bundler config evaluation" />
          <p className="mt-1.5 text-[12px] text-fg-2">
            Only matters when detangle.toml names vite_config, webpack_config or babel_config: the engine then runs that JavaScript with Node to read aliases. Off by default — enable only for repositories you trust.
          </p>
        </div>
        {error && <Notice level="error" title={error.message}>{error.hint}</Notice>}
        <div className="flex items-center justify-between gap-2 pt-1">
          {confirm ? (
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" />}
              onClick={async () => {
                await api.removeRepo(repo.id);
                onChanged();
                onClose();
              }}
            >
              Remove “{repo.name}” and its scans
            </Button>
          ) : (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
              Unregister
            </Button>
          )}
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
        <p className="text-[11px] text-fg-3">Unregistering deletes Lattice's scans and baselines for this repository. Files in the repository are never touched.</p>
      </div>
    </Modal>
  );
}
