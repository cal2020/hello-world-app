// Builds the pinned Zit release from crates.io into ./.tools/bin/zit.
// Zit is GPL-2.0-only and is used as a separate program; see NOTICE.md.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZIT_VERSION = '0.1.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, '.tools');

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (cargo.status !== 0) {
  console.error('cargo was not found. Install Rust 1.88+ (https://rustup.rs), or download a Zit release binary and set ZIT_BIN to its path.');
  process.exit(1);
}
console.log(`Building zit ${ZIT_VERSION} with ${cargo.stdout.trim()} into ${tools} …`);
const r = spawnSync('cargo', ['install', 'zit', '--version', `=${ZIT_VERSION}`, '--locked', '--root', tools], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const bin = join(tools, 'bin', 'zit');
if (!existsSync(bin)) {
  console.error(`cargo finished but ${bin} is missing.`);
  process.exit(1);
}
const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
console.log(`Installed ${v.stdout.trim()} at ${bin}`);
