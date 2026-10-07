import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handler, isLocalHost, sameOrigin } from './http';
import { Service } from './lib/service';
import { Store } from './lib/store';

describe('request guards', () => {
  it('accepts only loopback host names', () => {
    for (const h of ['localhost', 'localhost:4780', '127.0.0.1:5173', '[::1]:4780']) expect(isLocalHost(h)).toBe(true);
    for (const h of [undefined, 'evil.com', 'localhost.evil.com', '127.0.0.1.nip.io:80', '10.0.0.2:4780']) expect(isLocalHost(h)).toBe(false);
  });
  it('compares origins exactly', () => {
    expect(sameOrigin('http://127.0.0.1:4780', '127.0.0.1:4780')).toBe(true);
    expect(sameOrigin(undefined, '127.0.0.1:4780')).toBe(true);
    expect(sameOrigin('http://evil.com', '127.0.0.1:4780')).toBe(false);
    expect(sameOrigin('null', '127.0.0.1:4780')).toBe(false);
  });
});

describe('HTTP handler', () => {
  let server: Server;
  let base = '';
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sy-http-'));
    const svc = new Service({ store: new Store(dir), projectRoot: dir, zitBin: null, zitHome: join(dir, 'zit'), dataDir: dir, allowedRoots: [] });
    await svc.start();
    server = createServer(handler(svc, { staticRoot: null, log: () => {} }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const post = (path: string, headers: Record<string, string>, body = '{}') => fetch(`${base}${path}`, { method: 'POST', headers, body });

  it('rejects mutations without the custom header, from another origin, or not as JSON', async () => {
    expect((await post('/api/repos', { 'content-type': 'application/json' })).status).toBe(403);
    expect((await post('/api/repos', { 'content-type': 'application/json', 'x-switchyard': '1', origin: 'http://evil.com' })).status).toBe(403);
    expect((await post('/api/repos', { 'content-type': 'text/plain', 'x-switchyard': '1' })).status).toBe(415);
  });

  it('validates repository paths with actionable messages', async () => {
    const h = { 'content-type': 'application/json', 'x-switchyard': '1' };
    const relative = await (await post('/api/repos', h, JSON.stringify({ path: 'code/shop' }))).json();
    expect(relative.message).toMatch(/absolute path/);
    const missing = await (await post('/api/repos', h, JSON.stringify({ path: join(dir, 'nope') }))).json();
    expect(missing.message).toMatch(/No directory/);
    const notRepo = await (await post('/api/repos', h, JSON.stringify({ path: tmpdir() }))).json();
    expect(notRepo.error).toMatch(/not-a-repo|invalid-path/);
  });

  it('answers unknown endpoints and bad JSON without leaking internals', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const bad = await post('/api/repos', { 'content-type': 'application/json', 'x-switchyard': '1' }, '{not json');
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe('The request body must be a JSON object.');
  });

  it('reports a missing engine clearly', async () => {
    const e = await (await fetch(`${base}/api/engine`)).json();
    expect(e.found).toBe(false);
    expect(e.problem).toMatch(/setup:zit/);
  });
});
