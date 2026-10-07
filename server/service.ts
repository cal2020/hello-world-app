// Application service: orchestrates registration, scans, rule previews/saves, baselines
// and exports. HTTP-free so it can be tested directly.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Baseline, Repository, RulePreview, RulesState, Scan, Violation } from "../shared/types.ts";
import { STORE_SCHEMA_VERSION } from "../shared/types.ts";
import * as engine from "./engine.ts";
import { EngineError } from "./engine.ts";
import { applyEdit, configVersion, listRules, sha256, unsupportedReason, type RuleEdit } from "./rules.ts";
import { preflight, UserError, validateRootCandidate } from "./roots.ts";
import { buildScan, compareToBaseline, readGitRevision, toViolation } from "./scan.ts";
import { Store } from "./store.ts";
import { parse as parseToml } from "smol-toml";

export class Service {
  readonly store: Store;
  private running = new Map<string, AbortController>();
  private starterCache: string | null = null;

  constructor(readonly dataDir: string) {
    this.store = new Store(dataDir);
  }

  // ---- Repositories ----------------------------------------------------------

  register(input: { path: unknown; name?: unknown }): Repository {
    const root = validateRootCandidate(input.path);
    const existing = this.store.repositories().find((r) => r.root === root);
    if (existing) return existing;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : path.basename(root);
    const repo: Repository = { id: crypto.randomUUID(), name, root, registeredAt: new Date().toISOString(), allowConfigEvaluation: false };
    this.store.addRepository(repo);
    return repo;
  }

  repo(id: string): Repository {
    const r = this.store.repository(id);
    if (!r) throw new UserError("That repository is not registered.", "repo-unknown", "Pick a repository from the sidebar.", 404);
    return r;
  }

  // ---- Scans -----------------------------------------------------------------

  isScanning(repoId: string) {
    return this.running.has(repoId);
  }

  cancelScan(repoId: string): boolean {
    const c = this.running.get(repoId);
    c?.abort();
    return !!c;
  }

  async scan(repoId: string, signal?: AbortSignal): Promise<Scan> {
    const repo = this.repo(repoId);
    if (this.running.has(repoId)) throw new UserError("A scan of this repository is already running.", "scan-running", "Wait for it to finish or cancel it.", 409);
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.running.set(repoId, controller);
    try {
      const started = Date.now();
      const pre = preflight(repo.root, repo.allowConfigEvaluation);
      const [a, c, version] = await Promise.all([
        engine.analyze(repo.root, pre.configPath, { signal: controller.signal }),
        engine.check(repo.root, pre.configPath, { signal: controller.signal }),
        engine.engineVersion(),
      ]);
      const notes = [...pre.notes];
      for (const line of new Set([...engine.engineNotes(a.stderr), ...engine.engineNotes(c.stderr)])) {
        notes.push({ level: "info", code: "engine-note", message: line });
      }
      const scan = buildScan({
        repositoryId: repo.id,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        engineVersion: version,
        analysis: a.analysis,
        checkViolations: c.violations,
        config: configVersion(pre.configText, pre.configPath ? "detangle.toml" : null, version),
        configText: pre.configText,
        git: readGitRevision(repo.root),
        notes,
      });
      this.store.addScan(scan);
      return scan;
    } catch (e) {
      throw asUserError(e);
    } finally {
      this.running.delete(repoId);
    }
  }

  latestScan(repoId: string): Scan | null {
    const s = this.store.scans(repoId)[0];
    return s ? this.store.scan(s.id) : null;
  }

  getScan(id: string): Scan {
    const s = this.store.scan(id);
    if (!s) throw new UserError("That scan no longer exists.", "scan-unknown", "Run a new scan.", 404);
    return s;
  }

  // ---- Rules -----------------------------------------------------------------

  private configFile(repo: Repository) {
    return path.join(repo.root, "detangle.toml");
  }

  private readConfig(repo: Repository): string | null {
    const f = this.configFile(repo);
    if (!fs.existsSync(f)) return null;
    if (fs.lstatSync(f).isSymbolicLink()) throw new UserError("detangle.toml is a symlink; refusing to follow it.", "config-symlink");
    return fs.readFileSync(f, "utf8");
  }

  rules(repoId: string): RulesState {
    const repo = this.repo(repoId);
    const text = this.readConfig(repo);
    if (text === null) {
      return { path: "detangle.toml", exists: false, textHash: null, text: "", rules: [], unsupported: null, usesBuiltinRules: true };
    }
    let unsupported: string | null = null;
    let rules: RulesState["rules"] = [];
    try {
      unsupported = unsupportedReason(text);
      rules = listRules(text);
    } catch (e) {
      unsupported = (e as Error).message;
    }
    return { path: "detangle.toml", exists: true, textHash: sha256(text), text, rules, unsupported, usesBuiltinRules: false };
  }

  /** The engine's own starter config (equivalent to its built-in rules), generated in an empty temp project. */
  async starterConfig(): Promise<string> {
    if (this.starterCache) return this.starterCache;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-init-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"starter","private":true}');
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) =>
        execFile(engine.enginePath(), ["init", dir], { timeout: 15_000, env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" } }, (err) => (err ? reject(err) : resolve())),
      );
      this.starterCache = fs.readFileSync(path.join(dir, "detangle.toml"), "utf8");
      return this.starterCache;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async proposedText(repo: Repository, edit: RuleEdit): Promise<{ current: string | null; proposed: string }> {
    const current = this.readConfig(repo);
    if (current === null && edit.op !== "add") throw new UserError("There is no detangle.toml yet.", "config-missing", "Add a rule to create one.");
    // A new file starts from the engine's starter rules so the built-in checks keep running.
    const base = current ?? (await this.starterConfig());
    return { current, proposed: applyEdit(base, edit) };
  }

  private guardEvaluation(repo: Repository, text: string) {
    const opts = ((parseToml(text) as Record<string, unknown>).options ?? {}) as Record<string, unknown>;
    const keys = ["vite_config", "webpack_config", "babel_config"].filter((k) => k in opts);
    if (keys.length && !repo.allowConfigEvaluation) {
      throw new UserError(`The config names ${keys.join(", ")}, which the engine would execute.`, "config-evaluation-blocked", "Enable “Allow bundler config evaluation” for this repository if you trust it.");
    }
  }

  private async checkWith(repo: Repository, text: string | null, signal?: AbortSignal) {
    if (text === null) return (await engine.check(repo.root, null, { signal })).violations.map(toViolation);
    this.guardEvaluation(repo, text);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-preview-"));
    const f = path.join(dir, "detangle.toml");
    try {
      fs.writeFileSync(f, text);
      return (await engine.check(repo.root, f, { signal })).violations.map(toViolation);
    } catch (e) {
      if (e instanceof EngineError) throw new EngineError(e.message.split(f).join("detangle.toml (proposed)"), e.code, "");
      throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async previewRule(repoId: string, edit: RuleEdit, signal?: AbortSignal): Promise<RulePreview> {
    const repo = this.repo(repoId);
    const { current, proposed } = await this.proposedText(repo, edit);
    const diff = createTwoFilesPatch("detangle.toml", "detangle.toml", current ?? "", proposed, current === null ? "(new file)" : "current", "proposed", { context: 3 });
    const base = { proposedText: proposed, diff, baseTextHash: current === null ? null : sha256(current) };
    let before: Violation[];
    let after: Violation[];
    try {
      [before, after] = await Promise.all([this.checkWith(repo, current, signal), this.checkWith(repo, proposed, signal)]);
    } catch (e) {
      const err = asUserError(e);
      if (err.code === "engine-failed") {
        return { ok: false, error: err.message, ...base, added: [], removed: [], changed: [], unchangedCount: 0, ruleViolations: [], affectedModules: [] };
      }
      throw err;
    }
    const beforeByKey = new Map(before.map((v) => [v.key, v]));
    const beforeKeys = new Set(beforeByKey.keys());
    const afterKeys = new Set(after.map((v) => v.key));
    const name = edit.op === "delete" ? null : edit.draft.name;
    const ruleViolations = name ? after.filter((v) => v.rule === name) : [];
    return {
      ok: true,
      ...base,
      added: after.filter((v) => !beforeKeys.has(v.key)),
      removed: before.filter((v) => !afterKeys.has(v.key)),
      changed: after.filter((v) => beforeByKey.get(v.key) && beforeByKey.get(v.key)!.severity !== v.severity).map((v) => ({ before: beforeByKey.get(v.key)!, after: v })),
      unchangedCount: after.filter((v) => beforeKeys.has(v.key)).length,
      ruleViolations,
      affectedModules: [...new Set(ruleViolations.flatMap((v) => [v.from, ...(v.to ? [v.to] : [])]))].sort(),
    };
  }

  async saveRule(repoId: string, edit: RuleEdit, baseTextHash: string | null): Promise<{ backup: string | null; textHash: string }> {
    const repo = this.repo(repoId);
    const { current, proposed } = await this.proposedText(repo, edit);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== baseTextHash) {
      throw new UserError("detangle.toml changed since you previewed this edit.", "config-changed", "Preview again to see the latest file before saving.", 409);
    }
    // The engine must accept the result before it's written.
    try {
      await this.checkWith(repo, proposed);
    } catch (e) {
      const err = asUserError(e);
      throw new UserError(`The engine rejected the new configuration: ${err.message}`, "config-rejected", "Adjust the rule and preview again.");
    }
    let backup: string | null = null;
    const file = this.configFile(repo);
    if (current !== null) {
      const dir = path.join(this.dataDir, "backups", repo.id);
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, `detangle.toml.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`);
      fs.writeFileSync(backup, current);
    }
    const tmp = `${file}.lattice-${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, proposed, { flag: "wx" });
    fs.renameSync(tmp, file);
    return { backup, textHash: sha256(proposed) };
  }

  // ---- Baselines ----------------------------------------------------------------

  createBaseline(repoId: string, scanId: string, name: unknown): Baseline {
    this.repo(repoId);
    const scan = this.getScan(scanId);
    if (scan.repositoryId !== repoId) throw new UserError("That scan belongs to another repository.", "scan-mismatch");
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : `Baseline ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;
    const b: Baseline = { id: crypto.randomUUID(), schemaVersion: STORE_SCHEMA_VERSION, repositoryId: repoId, name: label, createdAt: new Date().toISOString(), scanId, source: scan.source, config: scan.config, violations: scan.violations };
    this.store.addBaseline(b);
    return b;
  }

  compare(baselineId: string, scanId: string) {
    const b = this.store.baseline(baselineId);
    if (!b) throw new UserError("That baseline no longer exists.", "baseline-unknown", undefined, 404);
    return compareToBaseline(b, this.getScan(scanId));
  }
}

export function asUserError(e: unknown): UserError {
  if (e instanceof UserError) return e;
  if (e instanceof EngineError) {
    const hints: Record<string, string> = {
      "engine-missing": "Reinstall dependencies with npm ci so the Detangle binary for this platform is present.",
      "engine-timeout": "Exclude generated or vendored folders in detangle.toml [options] exclude, then scan again.",
      "engine-cancelled": "",
      "engine-failed": "Check detangle.toml for the error above, then scan again.",
      "engine-output": "Try again; if it persists, run `npx detangle check` in the repository to see the engine's own output.",
    };
    return new UserError(e.message, e.code, hints[e.code] || undefined, e.code === "engine-cancelled" ? 499 : 422);
  }
  console.error(e);
  return new UserError("Something went wrong while processing the request.", "internal", "Check the service console for details.", 500);
}
