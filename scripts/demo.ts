// Scripted demo on a disposable repository. No agent or API credentials.
//
//   npm run demo         create .demo/acme-shop and four tasks in it
//   npm run demo:reset   dispose the demo's Zit workspaces and delete .demo/
//
// It drives Switchyard's own HTTP API — the running server if one answers on
// SWITCHYARD_PORT, otherwise an in-process one — and plays the part of the
// coding tools by editing files inside each Zit workspace.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, RepoState, Task } from '../shared/api';
import type { Claimed, Recorded } from '../shared/engine-types';
import { handler } from '../server/http';
import { Service } from '../server/lib/service';
import { Store } from '../server/lib/store';
import { findZit } from '../server/lib/zit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = join(root, '.demo');
const repoPath = join(demoDir, 'acme-shop');
const port = parseInt(process.env.SWITCHYARD_PORT ?? '4780', 10);
const dataDir = resolve(process.env.SWITCHYARD_DATA_DIR ?? join(root, '.switchyard'));
const zitHome = resolve(process.env.ZIT_HOME ?? join(homedir(), '.zit'));

const say = (m: string) => console.log(`\x1b[36m›\x1b[0m ${m}`);

// ── API client ─────────────────────────────────────────────────────────────

let base = '';
const local: { close: (() => Promise<void>) | null } = { close: null };

async function connect() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/engine`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      base = `http://127.0.0.1:${port}`;
      say(`Using the running Switchyard server on port ${port}.`);
      return;
    }
  } catch {
    /* not running */
  }
  const store = new Store(dataDir);
  const svc = new Service({ store, projectRoot: root, zitBin: findZit(root), zitHome, dataDir, allowedRoots: [] });
  await svc.start();
  const server: Server = createServer(handler(svc, { staticRoot: null, log: console.error }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  local.close = () => new Promise((r) => server.close(() => r()));
  say('No server running; using an in-process Switchyard (same API).');
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-switchyard': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json()) as T & { message?: string };
  if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${data.message ?? r.status}`), { status: r.status, data });
  return data;
}

async function waitJob(id: string): Promise<Job> {
  for (;;) {
    const job = await api<Job>('GET', `/api/jobs/${id}`);
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── Fixture repository ─────────────────────────────────────────────────────

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'acme-shop', private: true, type: 'module' }, null, 2)}\n`,
  'README.md': '# Acme Shop\n\nA tiny pricing library used by the Switchyard demo. Synthetic data.\n',
  'src/pricing.js': `// Prices are integers in cents.

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
`,
  'test/pricing.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { subtotal, tax, total } from '../src/pricing.js';

const cart = [
  { unitCents: 250, quantity: 2 },
  { unitCents: 505, quantity: 1 },
];

test('subtotal adds line items', () => assert.equal(subtotal(cart), 1005));
test('tax rounds half up to whole cents', () => assert.equal(tax(1005, 0.0825), 83));
test('total includes tax', () => assert.equal(total(cart, 0.0825), 1088));
`,
  'test/format.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTotal } from '../src/pricing.js';

test('formats cents as a decimal amount', () => assert.equal(formatTotal(1234), '12.34'));
`,
  'scripts/check-format.mjs': `// Fails when a source file has tabs or trailing spaces.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
let bad = 0;
for (const dir of ['src', 'test']) {
  for (const f of readdirSync(dir)) {
    readFileSync(join(dir, f), 'utf8').split('\\n').forEach((line, i) => {
      if (/\\t|\\s+$/.test(line)) { console.log(\`\${dir}/\${f}:\${i + 1}: tab or trailing space\`); bad++; }
    });
  }
}
console.log(bad ? \`\${bad} formatting problem(s)\` : 'formatting ok');
process.exit(bad ? 1 : 0);
`,
  'zit.toml': `# Checks Zit runs, in an isolated view, before a change may land.
[[check]]
name = "unit"
run = "node --test"

[[check]]
name = "format"
run = "node scripts/check-format.mjs"
inputs = ["src", "test", "scripts"]
`,
};

function sh(cwd: string, ...args: string[]) {
  return execFileSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function createRepo() {
  if (existsSync(repoPath)) throw new Error(`${repoPath} already exists. Run \`npm run demo:reset\` first.`);
  await mkdir(repoPath, { recursive: true });
  for (const [file, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(repoPath, file)), { recursive: true });
    await writeFile(join(repoPath, file), content);
  }
  sh(repoPath, 'git', 'init', '-q', '-b', 'main');
  sh(repoPath, 'git', 'config', 'user.name', 'Demo Maintainer');
  sh(repoPath, 'git', 'config', 'user.email', 'demo@example.invalid');
  sh(repoPath, 'git', 'add', '-A');
  sh(repoPath, 'git', 'commit', '-q', '-m', 'Acme Shop: pricing library (synthetic demo)');
}

async function edit(path: string, file: string, change: (s: string) => string) {
  const full = join(path, file);
  const before = existsSync(full) ? await readFile(full, 'utf8') : '';
  const after = change(before);
  if (after === before) throw new Error(`demo edit to ${file} changed nothing`);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, after);
}

/** Zit reuses a workspace's live write set for 2 s; let it see fresh edits. */
const settle = () => new Promise((r) => setTimeout(r, 2200));

// ── Steps ──────────────────────────────────────────────────────────────────

async function demo() {
  await connect();
  const engine = await api<{ found: boolean; problem: string | null }>('GET', '/api/engine');
  if (!engine.found) throw new Error(engine.problem ?? 'Zit is not available. Run `npm run setup:zit`.');

  say(`Creating a disposable repository at ${repoPath}`);
  await createRepo();
  const repo = await api<{ id: string }>('POST', '/api/repos', { path: repoPath, demo: true });
  await api('POST', `/api/repos/${repo.id}/init`, {});

  // Approve exactly the demo repository's declared check commands.
  let state = await api<RepoState>('GET', `/api/repos/${repo.id}/state`);
  const keys = state.commands.current.map((c) => c.key);
  await api('POST', `/api/repos/${repo.id}/approvals`, { keys });
  say(`Approved the demo's own zit.toml commands: ${state.commands.current.map((c) => `“${c.run}”`).join(', ')}`);

  const task = async (title: string, owner: string, notes: string) => {
    const t = await api<Task>('POST', `/api/repos/${repo.id}/tasks`, { title, owner, notes });
    state = await api<RepoState>('GET', `/api/repos/${repo.id}/state`);
    const ws = state.tasks.find((v) => v.id === t.id)!.primaryWorkspace!;
    say(`Task “${title}” → ${owner}, workspace ${ws.id}`);
    return { task: t, ws };
  };
  const claim = (ws: string, resources: string[]) => api<Claimed>('POST', `/api/repos/${repo.id}/workspaces/${ws}/claim`, { resources });
  const record = (ws: string, summary: string) => api<Recorded>('POST', `/api/repos/${repo.id}/workspaces/${ws}/record`, { summary });
  const check = async (change: string) => waitJob((await api<Job>('POST', `/api/repos/${repo.id}/changes/${change}/check`, {})).id);

  // 1. Alice: a new module in new files. Independent of everyone else.
  const alice = await task('Add bulk discount', 'alice', 'Orders of 10+ units get 5% off. Separate module.');
  await claim(alice.ws.id, ['src/discount.js']);
  await edit(alice.ws.path, 'src/discount.js', () => `// 5% off line items with 10 or more units.\nexport function bulkDiscount(item) {\n  return item.quantity >= 10 ? Math.round(item.unitCents * item.quantity * 0.05) : 0;\n}\n`);
  await edit(alice.ws.path, 'test/discount.test.js', () => `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { bulkDiscount } from '../src/discount.js';\n\ntest('no discount under 10 units', () => assert.equal(bulkDiscount({ unitCents: 100, quantity: 9 }), 0));\ntest('5% from 10 units', () => assert.equal(bulkDiscount({ unitCents: 100, quantity: 10 }), 50));\n`);
  const a = await record(alice.ws.id, 'Added bulkDiscount() in its own module with tests; pricing.js untouched.');

  // 2. Bob: currency formatting — edits formatTotal in src/pricing.js.
  const bob = await task('Show prices with a currency symbol', 'bob', 'Storefront wants “$12.34”, not “12.34”.');
  await claim(bob.ws.id, ['src/pricing.js#formatTotal']);
  await edit(bob.ws.path, 'src/pricing.js', (s) => s.replace('return (cents / 100).toFixed(2);', () => 'return `$${(cents / 100).toFixed(2)}`;'));
  await edit(bob.ws.path, 'test/format.test.js', (s) => s.replace("'12.34'", "'$12.34'").replace('as a decimal amount', 'with a dollar sign'));
  const b = await record(bob.ws.id, 'formatTotal() now prefixes “$”; updated its test.');

  // 3. Carol: tax rounding — also edits src/pricing.js (a different function), and breaks a test.
  const carol = await task('Round tax down to whole cents', 'carol', 'Finance asked for truncation. Check with them about the existing test.');
  await claim(carol.ws.id, ['src/pricing.js#tax']);
  await edit(carol.ws.path, 'src/pricing.js', (s) => s.replace('return Math.round(cents * rate);', 'return Math.floor(cents * rate);'));
  const c = await record(carol.ws.id, 'tax() truncates instead of rounding, per finance.');

  for (const [who, rec] of [['alice', a], ['bob', b], ['carol', c]] as const) {
    const job = await check(rec.change!.id);
    say(`Checks on ${who}'s change ${rec.change!.id.slice(0, 8)}: ${job.run?.status} — ${job.run?.message}`);
  }

  // 4. Dana: still editing. Her claim on carol's function is refused by Zit.
  const dana = await task('Document the pricing rules', 'dana', 'README section on tax and discounts.');
  const refused = await claim(dana.ws.id, ['src/pricing.js#tax']);
  say(`Dana claims src/pricing.js#tax → ${refused.claim}${refused.claim === 'refused' ? ` (held by ${[...new Set(refused.held.map((h) => `${h.by.agent}'s ${h.by.kind}`))].join(', ')})` : ''}`);
  await claim(dana.ws.id, ['README.md']);
  await edit(dana.ws.path, 'README.md', (s) => `${s}\n## Pricing rules\n\n- Prices are integers in cents.\n- Tax is computed on the subtotal.\n`);
  await settle();

  state = await api<RepoState>('GET', `/api/repos/${repo.id}/state`);
  say('Board:');
  for (const t of state.tasks) console.log(`    ${t.lane.padEnd(13)} ${t.owner.padEnd(6)} ${t.title}`);
  for (const o of state.overlaps) {
    const n = (id: string) => state.tasks.find((t) => t.id === id)?.owner;
    console.log(`    overlap (${o.level}): ${n(o.a)} ↔ ${n(o.b)} on ${o.shared.map((s) => `${s.a} / ${s.b}`).join('; ')}`);
  }
  console.log(`\nOpen Switchyard (npm run dev → http://localhost:5173, or npm start → http://127.0.0.1:${port}) and pick “acme-shop”.`);
  console.log('Try: accept alice’s change, then bob’s (Zit composes it onto the new current); carol’s stays blocked by its failing check.');
}

async function reset() {
  if (existsSync(join(repoPath, '.git'))) {
    const zit = findZit(root);
    if (zit) {
      // Only this repository's workspaces and caches (Zit keys its storage per repository).
      try {
        sh(repoPath, zit, 'dispose', '--all');
        sh(repoPath, zit, 'clean', '--force');
        say('Removed the demo repository’s Zit workspaces and caches.');
      } catch (e) {
        say(`Zit cleanup skipped: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  await connect();
  const repos = await api<Array<{ id: string; path: string }>>('GET', '/api/repos');
  for (const r of repos.filter((r) => r.path === repoPath || r.path.startsWith(`${demoDir}/`))) {
    await api('DELETE', `/api/repos/${r.id}`);
    say(`Unregistered ${r.path}`);
  }
  await rm(demoDir, { recursive: true, force: true });
  say(`Deleted ${demoDir}`);
}

try {
  await (process.argv.includes('--reset') ? reset() : demo());
} catch (e) {
  console.error(`\x1b[31m✗\x1b[0m ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await local.close?.();
}
