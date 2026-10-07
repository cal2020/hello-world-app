// Run a program with an argument vector — never through a shell — with a
// timeout, cancellation, and a cap on how much output is kept in memory.

import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  input?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

const DEFAULT_MAX = 16 * 1024 * 1024;

export function exec(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false });
      return;
    }
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
      // Own process group, so cancelling also stops what the program started (checks).
      detached: true,
    });
    const max = opts.maxBytes ?? DEFAULT_MAX;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.on('data', (b: Buffer) => {
      if (outBytes + b.length > max) truncated = true;
      else out.push(b);
      outBytes += b.length;
    });
    child.stderr!.on('data', (b: Buffer) => {
      if (errBytes + b.length <= 256 * 1024) err.push(b);
      errBytes += b.length;
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        cancelled,
        truncated,
      });
    });
  });
}
