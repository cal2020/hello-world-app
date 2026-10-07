// Read-only git queries: repository discovery, file contents at a revision,
// diffs and the accepted line for display. Nothing here writes refs or files;
// `GIT_OPTIONAL_LOCKS=0` keeps even index refreshes out of workspaces.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MainlineEntry } from '../../shared/api';
import { exec } from './exec';

const env = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });

async function git(cwd: string, args: string[], maxBytes?: number) {
  return exec('git', args, { cwd, env: env(), timeoutMs: 30_000, maxBytes });
}

export async function gitVersion(): Promise<string | null> {
  try {
    const r = await git(process.cwd(), ['--version']);
    return /git version (\S+)/.exec(r.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Zit needs `git merge-tree --write-tree`, from git 2.38. */
export function gitSupported(version: string | null): boolean {
  if (!version) return false;
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10));
  return major! > 2 || (major === 2 && minor! >= 38);
}

export interface RepoInfo {
  toplevel: string;
  gitDir: string;
}

/** The working tree root and common git dir of a non-bare repository at `path`. */
export async function repoInfo(path: string): Promise<RepoInfo | null> {
  const r = await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (r.code !== 0) return null;
  const [toplevel, gitDir] = r.stdout.trim().split('\n');
  if (!toplevel || !gitDir) return null;
  return { toplevel, gitDir };
}

export async function zitCurrent(repo: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/zit/current']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `refs/zit/current.lock` left behind by an interrupted ref update. */
export async function currentLock(repo: string): Promise<string | null> {
  const info = await repoInfo(repo);
  if (!info) return null;
  const lock = join(info.gitDir, 'refs', 'zit', 'current.lock');
  return existsSync(lock) ? lock : null;
}

const REV = /^[0-9a-f]{7,64}$|^refs\/zit\/current$/;

/** A file's content at a revision, or null when the file does not exist there. */
export async function fileAt(repo: string, rev: string, path: string): Promise<string | null> {
  if (!REV.test(rev)) throw new Error(`not a revision: ${rev}`);
  const r = await git(repo, ['cat-file', '-p', `${rev}:${path}`], 1024 * 1024);
  if (r.code !== 0) return null;
  return r.stdout;
}

export const MAX_DIFF_BYTES = 200_000;

function bound(text: string): { diff: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_DIFF_BYTES) return { diff: text, truncated: false };
  return { diff: Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
}

/** What a change did relative to its first parent, as Zit's web view shows it. */
export async function changeDiff(repo: string, parent: string | null, id: string): Promise<{ diff: string; truncated: boolean }> {
  if (!REV.test(id) || (parent && !REV.test(parent))) throw new Error('not a revision');
  const args = parent ? ['diff', '--no-color', '--no-ext-diff', parent, id] : ['show', '--no-color', '--no-ext-diff', '--format=', id];
  const r = await git(repo, args, MAX_DIFF_BYTES + 4096);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'git diff failed');
  const b = bound(r.stdout);
  return { diff: b.diff, truncated: b.truncated || r.truncated };
}

/** Live edits in a workspace against its base, without touching its index. */
export async function workspaceDiff(path: string): Promise<{ diff: string; untracked: string[]; truncated: boolean }> {
  const excludes = join(dirname(path), 'git', 'zit-ignore');
  const config = ['-c', 'core.checkStat=minimal', '-c', 'core.trustctime=false'];
  if (existsSync(excludes)) config.push('-c', `core.excludesFile=${excludes}`);
  const d = await git(path, [...config, 'diff', '--no-color', '--no-ext-diff', 'HEAD'], MAX_DIFF_BYTES + 4096);
  if (d.code !== 0) throw new Error(d.stderr.trim() || 'git diff failed');
  const u = await git(path, [...config, 'ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = u.stdout.split('\0').filter(Boolean).slice(0, 500);
  const b = bound(d.stdout);
  return { diff: b.diff, untracked, truncated: b.truncated || d.truncated };
}

/** Accepted history on current's first-parent line, newest first. */
export async function mainline(repo: string, limit = 24): Promise<MainlineEntry[]> {
  const r = await git(repo, [
    'log',
    '--first-parent',
    `-n${limit}`,
    '--format=%H%x00%P%x00%an%x00%ct%x00%s%x00%(trailers:key=Zit-Change,valueonly,separator=)%x01',
    'refs/zit/current',
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\x01')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [id, parents, agent, time, subject, zitChange] = rec.split('\0');
      return {
        id: id!,
        subject: subject ?? '',
        agent: agent ?? '',
        time: parseInt(time ?? '0', 10),
        composed: (parents ?? '').trim().split(/\s+/).length > 1 || Boolean(zitChange?.trim()),
      };
    });
}
