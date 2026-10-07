// HTTP surface of the adapter. Local-only by construction:
//  - binds to loopback (see main.ts);
//  - answers only requests whose Host is localhost (defeats DNS rebinding);
//  - state-changing requests must be JSON, carry `X-Switchyard: 1`, and come
//    from this origin — a cross-site page cannot send that header without a
//    CORS preflight, and this server never grants one.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { HttpError, type Service } from './lib/service';

const MAX_BODY = 64 * 1024;

export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^(\[::1\]|localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/i.exec(host.trim());
  return m !== null;
}

export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true; // Not sent by browsers for same-origin GET; non-browser clients.
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === (host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid-json', 'The request body must be a JSON object.');
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

type Handler = (p: Record<string, string>, body: Record<string, unknown>, url: URL) => Promise<unknown> | unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  status?: number;
}

function route(method: string, path: string, handler: Handler, status?: number): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return '([A-Za-z0-9_-]{1,64})';
    })}$`,
  );
  return { method, pattern, keys, handler, status };
}

export function routes(svc: Service): Route[] {
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return [
    route('GET', '/api/engine', (_p, _b, url) => svc.engineInfo(url.searchParams.get('refresh') === '1')),
    route('GET', '/api/repos', () => svc.repos()),
    route('POST', '/api/repos', (_p, b) => svc.register(s(b.path) ?? '', b.demo === true), 201),
    route('DELETE', '/api/repos/:repo', async (p) => (await svc.unregister(p.repo!), { ok: true })),
    route('POST', '/api/repos/:repo/init', async (p) => (await svc.initRepo(p.repo!), { ok: true })),
    route('GET', '/api/repos/:repo/state', async (p) => ({ ...(await svc.state(p.repo!)), jobs: svc.activeJobs(p.repo!) })),
    route('GET', '/api/repos/:repo/changes/:change', (p) => svc.inspectChange(p.repo!, p.change!)),
    route('GET', '/api/repos/:repo/workspaces/:ws/diff', (p) => svc.workspaceDiff(p.repo!, p.ws!)),
    route('POST', '/api/repos/:repo/tasks', (p, b) => svc.createTask(p.repo!, b), 201),
    route('PATCH', '/api/repos/:repo/tasks/:task', (p, b) => svc.updateTask(p.repo!, p.task!, b)),
    route('POST', '/api/repos/:repo/workspaces/:ws/claim', (p, b) => svc.claim(p.repo!, p.ws!, b.resources)),
    route('POST', '/api/repos/:repo/workspaces/:ws/record', (p, b) => svc.record(p.repo!, p.ws!, b.summary)),
    route('POST', '/api/repos/:repo/workspaces/:ws/dispose', (p, b) => svc.dispose(p.repo!, p.ws!, b.confirm)),
    route('POST', '/api/repos/:repo/changes/:change/check', (p, b) => svc.startCheck(p.repo!, p.change!, b.rerun), 202),
    route('POST', '/api/repos/:repo/changes/:change/accept', (p, b) => svc.startAccept(p.repo!, p.change!, b.expectedCurrent), 202),
    route('POST', '/api/repos/:repo/changes/:change/retry', (p) => svc.retry(p.repo!, p.change!)),
    route('POST', '/api/repos/:repo/changes/:change/discard', (p, b) => svc.discard(p.repo!, p.change!, b.confirm)),
    route('POST', '/api/repos/:repo/approvals', (p, b) => svc.approve(p.repo!, b.keys, b.changeId)),
    route('DELETE', '/api/repos/:repo/approvals/:key', async (p) => (await svc.revokeApproval(p.repo!, p.key!), { ok: true })),
    route('GET', '/api/repos/:repo/checks', (p) => svc.checkHistory(p.repo!)),
    route('POST', '/api/repos/:repo/operations/:op/dismiss', async (p) => (await svc.dismissOperation(p.repo!, p.op!), { ok: true })),
    route('GET', '/api/jobs/:job', (p) => svc.job(p.job!)),
    route('POST', '/api/jobs/:job/cancel', (p) => svc.cancelJob(p.job!)),
  ];
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

async function serveStatic(res: ServerResponse, root: string, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(root, rel);
  if (!file.startsWith(root + sep) && file !== root) return send(res, 404, { error: 'not-found', message: 'Not found.' });
  let info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) {
    file = join(root, 'index.html'); // SPA fallback
    info = await stat(file).catch(() => null);
    if (!info) return send(res, 404, { error: 'not-built', message: 'The web UI is not built. Run `npm run build`, or use `npm run dev`.' });
  }
  const body = await readFile(file);
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': CSP,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
}

export function handler(svc: Service, opts: { staticRoot: string | null; log: (msg: string) => void }) {
  const table = routes(svc);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host;
    if (!isLocalHost(host)) return send(res, 403, { error: 'forbidden-host', message: 'Switchyard only answers to localhost.' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method', message: 'Not allowed.' });
        if (!opts.staticRoot) return send(res, 404, { error: 'not-found', message: 'In development, open the Vite dev server instead.' });
        return await serveStatic(res, opts.staticRoot, url.pathname);
      }
      if (method !== 'GET') {
        if (req.headers['x-switchyard'] !== '1') throw new HttpError(403, 'forbidden', 'Missing the X-Switchyard header.');
        if (!sameOrigin(req.headers.origin, host)) throw new HttpError(403, 'forbidden-origin', 'Cross-origin requests are not accepted.');
        const type = req.headers['content-type'] ?? '';
        if (!/^application\/json\b/i.test(type) && method !== 'DELETE') throw new HttpError(415, 'json-only', 'Send JSON.');
      }
      for (const r of table) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!]));
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        const result = await r.handler(params, body, url);
        return send(res, r.status ?? 200, result ?? { ok: true });
      }
      throw new HttpError(404, 'not-found', 'No such endpoint.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      opts.log(`[error] ${method} ${url.pathname}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return send(res, 500, { error: 'internal', message: 'Something went wrong inside Switchyard. Details are in the server log.' });
    }
  };
}
