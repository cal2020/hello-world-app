import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, SCHEMA_VERSION, Store } from './store';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('persists across instances and writes a versioned file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sy-store-'));
    const a = new Store(dir);
    await a.load();
    await a.update((d) => void d.repos.push({ id: 'r1', name: 'x', path: '/x', addedAt: 1, demo: false }));
    const b = new Store(dir);
    await b.load();
    expect(b.snapshot.repos.map((r) => r.id)).toEqual(['r1']);
    expect(JSON.parse(await readFile(join(dir, 'switchyard.json'), 'utf8')).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('serialises concurrent updates without losing any', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sy-store-'));
    const s = new Store(dir);
    await s.load();
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.update((d) => void d.tasks.push({ id: `t${i}`, repoId: 'r', title: 't', owner: 'o', notes: '', createdAt: i, changeIds: [] }))));
    const again = new Store(dir);
    await again.load();
    expect(again.snapshot.tasks).toHaveLength(25);
  });

  it('refuses a file from a newer version instead of overwriting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sy-store-'));
    await writeFile(join(dir, 'switchyard.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
    await expect(new Store(dir).load()).rejects.toThrow(/schema version/);
  });

  it('migrates a version-0 file and fills missing fields', () => {
    const d = migrate({ repos: [{ id: 'r' }], tasks: [{ id: 't' }] });
    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(d.tasks[0]!.changeIds).toEqual([]);
    expect(d.approvals).toEqual([]);
  });
});
