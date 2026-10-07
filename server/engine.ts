// Adapter around the Detangle CLI (the analysis engine). It runs the binary that the
// `detangle` npm package installs — never a shell — and returns its JSON output.
// Display code never talks to the engine directly.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export interface EngineDependency {
  module: string;
  specifier: string;
  types: string[];
  circular: boolean;
}
export interface EngineModule {
  id: string;
  kind: "local" | "npm" | "core" | "unresolved";
  fanIn: number;
  fanOut: number;
  instability: number;
  cycle: number | null;
  dependencies: EngineDependency[];
}
export interface EngineViolation {
  rule: string;
  severity: "error" | "warn" | "info" | "off";
  comment: string | null;
  scope: "module" | "folder" | "group";
  from: string;
  to: string | null;
  cycle: string[];
  imports: { from: string; specifier: string; to: string }[];
}
export interface EngineAnalysis {
  summary: {
    modules: number;
    dependencies: number;
    cycles: number;
    errors: number;
    warnings: number;
    info: number;
    timings: { scan_ms: number; graph_ms: number };
  };
  modules: EngineModule[];
  cycles: string[][];
  violations: EngineViolation[];
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: "engine-missing" | "engine-failed" | "engine-timeout" | "engine-cancelled" | "engine-output",
    public readonly stderr = "",
  ) {
    super(message);
  }
}

export function enginePath(): string {
  if (process.env.DETANGLE_BIN) return process.env.DETANGLE_BIN;
  // binary.js is not in the package's export map, so load it by file path.
  const pkgDir = path.dirname(require.resolve("detangle"));
  const { binaryPath } = require(path.join(pkgDir, "binary.js")) as { binaryPath: () => string | null };
  const bin = binaryPath();
  if (!bin) throw new EngineError(`No Detangle binary is available for ${process.platform}-${process.arch}.`, "engine-missing");
  return bin;
}

interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_OUTPUT = 256 * 1024 * 1024;

function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bin = enginePath();
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: MAX_OUTPUT,
        timeout: opts.timeoutMs ?? 120_000,
        signal: opts.signal,
        // A minimal environment: no colors, and nothing the engine could use to evaluate repo config by accident.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown };
          if (e.name === "AbortError" || opts.signal?.aborted) return reject(new EngineError("Scan cancelled.", "engine-cancelled"));
          if (e.killed && e.signal === "SIGTERM") return reject(new EngineError("The engine did not finish within the time limit.", "engine-timeout"));
          if (typeof e.code !== "number") return reject(new EngineError(`Couldn't start the analysis engine: ${e.message}`, "engine-missing"));
          return resolve({ stdout, stderr, exitCode: e.code });
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
    child.stdin?.end();
  });
}

function parseJson<T>(r: RunResult, what: string): T {
  if (r.exitCode > 1) throw new EngineError(cleanStderr(r.stderr) || `${what} failed (exit ${r.exitCode})`, "engine-failed", r.stderr);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new EngineError(`The engine returned unreadable output for ${what}.`, "engine-output", r.stderr);
  }
}

export function cleanStderr(s: string): string {
  return s.replace(/^error:\s*/m, "").trim();
}

/** Non-error lines on stderr (notes about tsconfig fallbacks and similar). */
export function engineNotes(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("error:"));
}

export interface AnalyzeResult {
  analysis: EngineAnalysis;
  stderr: string;
}

/** Whole-project graph with metrics, cycles and rule violations (`detangle graph -f json --externals`). */
export async function analyze(root: string, configPath: string | null, opts: RunOptions = {}): Promise<AnalyzeResult> {
  const args = ["graph", root, "-f", "json", "--externals"];
  if (configPath) args.push("--config", configPath);
  const r = await run(args, opts);
  return { analysis: parseJson<EngineAnalysis>(r, "analysis"), stderr: r.stderr };
}

/** Rule results exactly as `detangle check -f json` reports them (the CI gate). */
export async function check(root: string, configPath: string | null, opts: RunOptions = {}): Promise<{ violations: EngineViolation[]; exitCode: number; stderr: string }> {
  const args = ["check", root, "-f", "json"];
  if (configPath) args.push("--config", configPath);
  const r = await run(args, opts);
  return { violations: parseJson<EngineViolation[]>(r, "check"), exitCode: r.exitCode, stderr: r.stderr };
}

let cachedVersion: string | null = null;
export async function engineVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const r = await run(["--version"], { timeoutMs: 10_000 });
  cachedVersion = r.stdout.trim().replace(/^detangle\s+/, "") || "unknown";
  return cachedVersion;
}
