// Switchyard server entry point. Configuration comes from the environment;
// see .env.example.

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from './http';
import { Service } from './lib/service';
import { Store } from './lib/store';
import { findZit } from './lib/zit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const host = env.SWITCHYARD_HOST ?? '127.0.0.1';
const port = parseInt(env.SWITCHYARD_PORT ?? '4780', 10);
const dataDir = resolve(env.SWITCHYARD_DATA_DIR ?? join(root, '.switchyard'));
const zitHome = resolve(env.ZIT_HOME ?? join(homedir(), '.zit'));
const allowedRoots = (env.SWITCHYARD_ALLOWED_ROOTS ?? '').split(':').filter(Boolean).map((p) => resolve(p));
const dist = join(root, 'dist');
const production = env.NODE_ENV === 'production';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK.has(host) && env.SWITCHYARD_ALLOW_NON_LOOPBACK !== '1') {
  console.error(`Refusing to listen on ${host}: Switchyard runs repository commands and binds to loopback only. Set SWITCHYARD_ALLOW_NON_LOOPBACK=1 to override (not recommended).`);
  process.exit(1);
}

const store = new Store(dataDir);
const service = new Service({ store, projectRoot: root, zitBin: findZit(root), zitHome, dataDir, allowedRoots });
await service.start();
const engine = await service.engineInfo();

const server = createServer(handler(service, { staticRoot: production && existsSync(dist) ? dist : null, log: (m) => console.error(m) }));
server.listen(port, host, () => {
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  console.log(`Switchyard API on ${url}${production ? '' : '  (UI: http://localhost:5173 via Vite)'}`);
  console.log(`  data: ${dataDir}`);
  console.log(`  zit:  ${engine.bin ?? 'not found'} ${engine.version ?? ''}  ZIT_HOME=${zitHome}`);
  if (engine.problem) console.log(`  ⚠ ${engine.problem}`);
  console.log(`  copy-on-write: ${engine.copyOnWrite.supported ? 'yes' : 'no (plain checkouts)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
