// Disposable repositories and an in-process Switchyard for integration tests.
// Everything lives under a fresh temp directory — repositories, ZIT_HOME and
// Switchyard's data — so tests can never touch a person's own repositories.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, RepoState } from '../shared/api';
import { handler } from '../server/http';
import { Service } from '../server/lib/service';
import { Store } from '../server/lib/store';
import { findZit } from '../server/lib/zit';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const zitBin = findZit(projectRoot);

export interface Harness {
  root: string;
  zitHome: string;
  dataDir: string;
  base: string;
  service: Service;
  api: <T = unknown>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  ok: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startHarness(opts: { staticRoot?: string } = {}): Promise<Harness> {
  if (!zitBin) throw new Error('Zit is not installed; run `npm run setup:zit`.');
  const root = await mkdtemp(join(tmpdir(), 'switchyard-it-'));
  const zitHome = join(root, 'zit-home');
  const dataDir = join(root, 'data');
  await mkdir(zitHome, { recursive: true });
  const env = { ...process.env, ZIT_HOME: zitHome, ZIT_AGENT: 'tester' };
  let server: Server;
  const h = { root, zitHome, dataDir, base: '' } as Harness;

  const boot = async () => {
    const service = new Service({ store: new Store(dataDir), projectRoot, zitBin, zitHome, dataDir, allowedRoots: [root], env });
    await service.start();
    server = createServer(handler(service, { staticRoot: opts.staticRoot ?? null, log: () => {} }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    h.base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    h.service = service;
  };
  await boot();

  h.api = async (method, path, body) => {
    const r = await fetch(`${h.base}${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-switchyard': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as never };
  };
  h.ok = async (method, path, body) => {
    const r = await h.api(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as never;
  };
  h.restart = async () => {
    await h.service.drain();
    await new Promise((r) => server.close(r));
    await boot();
  };
  h.close = async () => {
    await h.service.drain();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  };
  return h;
}

export const PRICING = `// Prices are integers in cents.

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

export function tax(cents, rate) {
  return Math.round(cents * rate);
}

export function total(items, rate) {
  const sub = subtotal(items);
  return sub + tax(sub, rate);
}

export function formatTotal(cents) {
  return (cents / 100).toFixed(2);
}
`;

export const PRICING_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { tax } from '../src/pricing.js';
test('tax rounds half up', () => assert.equal(tax(1005, 0.0825), 83));
`;

/** A small repository with a `node --test` check, initialised for Zit. */
export async function makeRepo(h: Harness, name: string, extra: Record<string, string> = {}): Promise<string> {
  const path = join(h.root, name);
  const files: Record<string, string> = {
    'package.json': '{ "type": "module" }\n',
    'README.md': `# ${name}\n`,
    'src/pricing.js': PRICING,
    'test/pricing.test.js': PRICING_TEST,
    'zit.toml': '[[check]]\nname = "unit"\nrun = "node --test"\n',
    ...extra,
  };
  for (const [f, c] of Object.entries(files)) {
    await mkdir(dirname(join(path, f)), { recursive: true });
    await writeFile(join(path, f), c);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return path;
}

export async function edit(path: string, file: string, fn: (s: string) => string) {
  const full = join(path, file);
  let before = '';
  try {
    before = await readFile(full, 'utf8');
  } catch {
    /* new file */
  }
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, fn(before));
}

export const settle = () => new Promise((r) => setTimeout(r, 2200));

export async function waitJob(h: Harness, id: string, timeoutMs = 60_000): Promise<Job> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const job = await h.ok<Job>('GET', `/api/jobs/${id}`);
    if (job.state !== 'running') return job;
    if (Date.now() > end) throw new Error(`job ${id} still running`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export const state = (h: Harness, repo: string) => h.ok<RepoState>('GET', `/api/repos/${repo}/state`);
