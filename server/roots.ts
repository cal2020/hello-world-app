// Registered-root access control and pre-scan checks. The service only reads inside
// roots the user registered explicitly, never follows symlinks out of them, and never
// executes repository code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ScanNote } from "../shared/types.ts";

export class UserError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/** Validates a path the user wants to register and returns its canonical form. */
export function validateRootCandidate(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new UserError("Enter the absolute path of a project folder.", "path-required");
  }
  const raw = input.trim();
  if (raw.length > 4096 || raw.includes("\0")) throw new UserError("That path is not valid.", "path-invalid");
  if (!path.isAbsolute(raw)) {
    throw new UserError("Use an absolute path, for example /home/you/projects/web-app.", "path-not-absolute");
  }
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw new UserError(`Nothing exists at ${raw}.`, "path-missing", "Check the spelling, or create the folder first.");
  }
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw new UserError(`${raw} is a file, not a folder.`, "path-not-directory", "Register the project folder that contains package.json.");
  if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) {
    throw new UserError("Refusing to scan a filesystem root or your home folder.", "path-too-broad", "Register a single project folder instead.");
  }
  const hasPkg = fs.existsSync(path.join(real, "package.json"));
  const hasCfg = fs.existsSync(path.join(real, "detangle.toml"));
  if (!hasPkg && !hasCfg) {
    // Without one of these the engine would walk up and treat an ancestor as the project root,
    // which could be outside the registered folder.
    throw new UserError(
      "This folder has no package.json or detangle.toml, so it isn't a project root.",
      "path-not-project",
      "Register the folder that contains package.json (the engine uses it to locate the project root).",
    );
  }
  return real;
}

/** Resolves a root-relative path and guarantees it stays inside the root. */
export function insideRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith("..") || path.isAbsolute(relBack)) throw new UserError("Path is outside the registered repository.", "path-outside-root", undefined, 403);
  return abs;
}

const CONFIG_EVAL_KEYS = ["vite_config", "webpack_config", "babel_config"];
const WALK_LIMIT = 50_000;

export interface Preflight {
  notes: ScanNote[];
  configPath: string | null;
  configText: string | null;
  configEvaluationKeys: string[];
}

/** Checks that make a scan explainable before the engine runs. Reads only inside the root. */
export function preflight(root: string, allowConfigEvaluation: boolean): Preflight {
  const notes: ScanNote[] = [];
  if (!fs.existsSync(root)) {
    throw new UserError("The registered folder no longer exists.", "root-missing", "Remove the repository or restore the folder.", 404);
  }
  if (fs.realpathSync(root) !== root) {
    throw new UserError("The registered folder now resolves somewhere else (it became a symlink).", "root-moved", "Remove and re-register the repository.");
  }

  const configPath = path.join(root, "detangle.toml");
  let configText: string | null = null;
  let configEvaluationKeys: string[] = [];
  if (fs.existsSync(configPath)) {
    const lst = fs.lstatSync(configPath);
    if (lst.isSymbolicLink()) throw new UserError("detangle.toml is a symlink; refusing to follow it.", "config-symlink", "Replace it with a regular file.");
    configText = fs.readFileSync(configPath, "utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(configText) as Record<string, unknown>;
    } catch (e) {
      throw new UserError(`detangle.toml is not valid TOML: ${(e as Error).message.split("\n")[0]}`, "config-invalid", "Fix the file, then scan again.");
    }
    const options = (parsed.options ?? {}) as Record<string, unknown>;
    configEvaluationKeys = CONFIG_EVAL_KEYS.filter((k) => k in options);
    if (configEvaluationKeys.length && !allowConfigEvaluation) {
      throw new UserError(
        `detangle.toml names ${configEvaluationKeys.join(", ")}; the engine would run that JavaScript to read aliases.`,
        "config-evaluation-blocked",
        "Scans never execute repository code by default. If you trust this repository, enable “Allow bundler config evaluation” in its settings.",
      );
    }
    if (configEvaluationKeys.length) {
      notes.push({ level: "warn", code: "config-evaluated", message: `Bundler configs (${configEvaluationKeys.join(", ")}) were evaluated with Node because you allowed it for this repository.` });
    }
  } else {
    notes.push({
      level: "info",
      code: "builtin-rules",
      message: "No detangle.toml: the engine's built-in rules were used (cycles, unresolved imports, undeclared packages, orphans…).",
      hint: "Add a rule to create detangle.toml with your own architecture boundaries.",
    });
  }
  for (const other of ["detangle.config.js", ".dependency-cruiser.js", ".dependency-cruiser.cjs"]) {
    if (fs.existsSync(path.join(root, other))) {
      notes.push({ level: "info", code: "unsupported-config", message: `${other} was found but is not used: only detangle.toml is read, so JavaScript configs are never executed.` });
    }
  }

  // Dependency installation affects how npm imports resolve.
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>;
      const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
      if (declared.length && !fs.existsSync(path.join(root, "node_modules"))) {
        notes.push({
          level: "warn",
          code: "deps-not-installed",
          message: `package.json declares ${declared.length} package(s) but node_modules is missing, so imports of those packages may show as unresolved.`,
          hint: "Install dependencies (npm ci / pnpm install) yourself, then scan again. Scans never run installs.",
        });
      }
    } catch {
      notes.push({ level: "warn", code: "package-json-invalid", message: "package.json could not be parsed; package classification may be wrong." });
    }
  }

  // Walk without following links: find symlinks that point outside the root, and whether TS files lack a tsconfig.
  const escaping: string[] = [];
  let tsFiles = 0;
  let visited = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++visited > WALK_LIMIT) {
        truncated = true;
        break;
      }
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(full);
          const rel = path.relative(root, target);
          if (rel.startsWith("..") || path.isAbsolute(rel)) escaping.push(path.relative(root, full));
        } catch {
          /* dangling link: harmless */
        }
      } else if (e.isDirectory()) {
        stack.push(full);
      } else if (/\.(m|c)?tsx?$/.test(e.name)) {
        tsFiles++;
      }
    }
    if (truncated) break;
  }
  if (escaping.length) {
    notes.push({
      level: "warn",
      code: "symlink-outside-root",
      message: `${escaping.length} symlink(s) point outside the repository and were not followed: ${escaping.slice(0, 5).join(", ")}${escaping.length > 5 ? "…" : ""}`,
      hint: "Imports through these links are excluded from the graph; files outside the root are never read.",
    });
  }
  if (truncated) notes.push({ level: "info", code: "preflight-truncated", message: `Pre-scan checks stopped after ${WALK_LIMIT.toLocaleString()} entries; the engine scan itself is not limited by this.` });
  if (tsFiles > 0 && !fs.existsSync(path.join(root, "tsconfig.json"))) {
    notes.push({
      level: "info",
      code: "no-tsconfig",
      message: "TypeScript files were found but there is no tsconfig.json at the root, so path aliases (compilerOptions.paths) can't be resolved.",
      hint: "If imports like @/lib show as unresolved, add the tsconfig or declare aliases in detangle.toml [options].",
    });
  }
  return { notes, configPath: configText === null ? null : configPath, configText, configEvaluationKeys };
}
