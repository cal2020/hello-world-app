// Switchyard's own data: registered repositories, task annotations, command
// approvals, check history and the operation journal. Engine state (workspaces,
// changes, claims, status) is never stored here.
//
// One versioned JSON file, written whole to a temp file and renamed, so a crash
// leaves either the old or the new file, never half of one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovedCommand, CheckRun, Operation, Repo, Task } from '../../shared/api';

export const SCHEMA_VERSION = 1;
const MAX_CHECK_RUNS = 400;
const MAX_OPERATIONS = 400;

export interface StoreData {
  schemaVersion: number;
  repos: Repo[];
  tasks: Task[];
  approvals: ApprovedCommand[];
  checkRuns: CheckRun[];
  operations: Operation[];
}

export const emptyData = (): StoreData => ({ schemaVersion: SCHEMA_VERSION, repos: [], tasks: [], approvals: [], checkRuns: [], operations: [] });

/** Bring an older file up to date, or refuse one written by a newer version. */
export function migrate(raw: unknown): StoreData {
  if (typeof raw !== 'object' || raw === null) throw new Error('state file is not a JSON object');
  const data = raw as Partial<StoreData>;
  const version = data.schemaVersion ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`state file has schema version ${version}; this Switchyard understands up to ${SCHEMA_VERSION}. Upgrade Switchyard or point SWITCHYARD_DATA_DIR elsewhere.`);
  }
  const out = emptyData();
  out.repos = Array.isArray(data.repos) ? data.repos : [];
  out.tasks = Array.isArray(data.tasks) ? data.tasks.map((t) => ({ ...t, changeIds: Array.isArray(t.changeIds) ? t.changeIds : [] })) : [];
  out.approvals = Array.isArray(data.approvals) ? data.approvals : [];
  out.checkRuns = Array.isArray(data.checkRuns) ? data.checkRuns : [];
  out.operations = Array.isArray(data.operations) ? data.operations : [];
  return out;
}

export class Store {
  private data: StoreData = emptyData();
  private writing: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, 'switchyard.json');
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = emptyData();
        return;
      }
      throw e;
    }
    this.data = migrate(JSON.parse(text));
  }

  /** A read-only snapshot. Mutate through `update`. */
  get snapshot(): Readonly<StoreData> {
    return this.data;
  }

  /** Apply `fn` and persist. Writes are serialised in call order. */
  update<T>(fn: (d: StoreData) => T): Promise<T> {
    const result = fn(this.data);
    this.data.checkRuns = this.data.checkRuns.slice(-MAX_CHECK_RUNS);
    this.data.operations = this.data.operations.slice(-MAX_OPERATIONS);
    const body = JSON.stringify(this.data, null, 2);
    const write = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writing = write.catch(() => {});
    return write.then(() => result);
  }
}
