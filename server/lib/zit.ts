// Adapter over the Zit CLI (`zit --json …`). Every call names the exact
// subcommand and flags verified against Zit 0.1.1's src/main.rs. Text the
// person typed (intents, summaries) is passed as a single `--flag=value`
// argument, never interpreted.

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Change, ChangeRow, Claimed, Detail, Outcome, Overview, Recorded, Verdict, Workspace } from '../../shared/engine-types';
import { exec, type ExecResult } from './exec';

export class ZitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly kind: 'engine' | 'not-initialised' | 'unknown-revision' | 'unknown-workspace' | 'timeout' | 'cancelled' | 'missing' = 'engine',
  ) {
    super(message);
  }
}

/** First supported release line. Output shapes were verified on 0.1.1. */
export const SUPPORTED = /^0\.1\.\d+$/;

export function findZit(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ZIT_BIN) return existsSync(env.ZIT_BIN) ? env.ZIT_BIN : null;
  const local = join(projectRoot, '.tools', 'bin', 'zit');
  if (existsSync(local)) return local;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'zit'))) return join(dir, 'zit');
  }
  return null;
}

const DEFAULT_TIMEOUT = 60_000;
/** Checks and accept run the repository's checks; Zit's own per-check default is 30 minutes. */
export const LONG_TIMEOUT = 35 * 60_000;

function cleanError(r: ExecResult): string {
  const text = r.stderr.trim() || r.stdout.trim() || `zit exited with code ${r.code}`;
  return text
    .split('\n')
    .map((l) => l.replace(/^zit: /, ''))
    .join('\n')
    .slice(0, 2000);
}

function classify(message: string): ZitError['kind'] {
  if (/not initialised/.test(message)) return 'not-initialised';
  if (/unknown revision/.test(message)) return 'unknown-revision';
  if (/unknown workspace/.test(message)) return 'unknown-workspace';
  return 'engine';
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Exit codes that still carry a JSON answer (1 = refused/failed/rejected). */
  answerCodes?: number[];
}

export class Zit {
  constructor(
    readonly bin: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async version(): Promise<string> {
    const r = await exec(this.bin, ['--version'], { cwd: process.cwd(), env: this.env, timeoutMs: 10_000 });
    const m = /zit\s+(\S+)/.exec(r.stdout);
    if (r.code !== 0 || !m) throw new ZitError(`could not read the Zit version: ${cleanError(r)}`, r.code);
    return m[1]!;
  }

  private async json<T>(repo: string, args: string[], opts: CallOptions = {}): Promise<T> {
    const r = await exec(this.bin, ['--json', ...args], {
      cwd: repo,
      env: this.env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
      signal: opts.signal,
    });
    if (r.cancelled) throw new ZitError('cancelled', null, 'cancelled');
    if (r.timedOut) throw new ZitError(`zit ${args[0]} did not finish in time and was stopped`, null, 'timeout');
    const ok = [0, ...(opts.answerCodes ?? [])];
    if (r.code === null || !ok.includes(r.code)) {
      const message = cleanError(r);
      throw new ZitError(message, r.code, classify(message));
    }
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new ZitError(`zit ${args[0]} returned output Switchyard could not read`, r.code);
    }
  }

  init(repo: string): Promise<{ current: string }> {
    return this.json(repo, ['init']);
  }

  status(repo: string): Promise<Overview> {
    return this.json(repo, ['status']);
  }

  show(repo: string, change: string): Promise<Detail> {
    return this.json(repo, ['show', '--', change]);
  }

  materialise(repo: string, w: { intent: string; agent: string; session: string }): Promise<Workspace> {
    return this.json(repo, ['materialise', `--intent=${w.intent}`, `--agent=${w.agent}`, `--session=${w.session}`], { timeoutMs: LONG_TIMEOUT });
  }

  claim(repo: string, workspace: string, resources: string[]): Promise<Claimed> {
    return this.json(repo, ['claim', `--workspace=${workspace}`, '--', ...resources], { answerCodes: [1] });
  }

  record(repo: string, workspace: string, summary: string): Promise<Recorded> {
    const args = ['record', `--workspace=${workspace}`];
    if (summary.trim()) args.push(`--summary=${summary}`);
    return this.json(repo, args);
  }

  check(repo: string, change: string, rerun: boolean, signal?: AbortSignal): Promise<Verdict[]> {
    const args = ['check', ...(rerun ? ['--rerun'] : []), '--', change];
    return this.json(repo, args, { signal, timeoutMs: LONG_TIMEOUT, answerCodes: [1] });
  }

  accept(repo: string, change: string, signal?: AbortSignal): Promise<Outcome> {
    return this.json(repo, ['accept', '--', change], { signal, timeoutMs: LONG_TIMEOUT, answerCodes: [1] });
  }

  retry(repo: string, change: string): Promise<Workspace> {
    return this.json(repo, ['retry', '--', change], { timeoutMs: LONG_TIMEOUT });
  }

  discard(repo: string, change: string): Promise<{ discarded: string[] }> {
    return this.json(repo, ['discard', '--', change]);
  }

  dispose(repo: string, workspace: string): Promise<{ disposed: string[] }> {
    return this.json(repo, ['dispose', '--', workspace]);
  }
}

export type { Change, ChangeRow };
