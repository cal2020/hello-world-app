// Local JSON persistence with a schema version and atomic writes.
// Layout: <dataDir>/store.json (repositories, scan index, baselines) and <dataDir>/scans/<id>.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Baseline, Repository, Scan, ScanSummary } from "../shared/types.ts";
import { STORE_SCHEMA_VERSION } from "../shared/types.ts";
import { summarize } from "./scan.ts";

interface StoreFile {
  schemaVersion: number;
  repositories: Repository[];
  scans: ScanSummary[];
  baselines: Baseline[];
}

const KEEP_SCANS_PER_REPO = 12;
const ID_RE = /^[0-9a-f-]{36}$/;

export class Store {
  private data: StoreFile;
  private file: string;

  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, "scans"), { recursive: true });
    this.file = path.join(dir, "store.json");
    this.data = this.load();
  }

  private load(): StoreFile {
    if (!fs.existsSync(this.file)) return { schemaVersion: STORE_SCHEMA_VERSION, repositories: [], scans: [], baselines: [] };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile;
    if (raw.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new Error(`Stored data uses schema ${raw.schemaVersion}, expected ${STORE_SCHEMA_VERSION}. Run \`npm run reset\` to start fresh.`);
    }
    return raw;
  }

  private write(file: string, value: unknown) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  private save() {
    this.write(this.file, this.data);
  }

  repositories() {
    return this.data.repositories;
  }
  repository(id: string) {
    return this.data.repositories.find((r) => r.id === id) ?? null;
  }
  addRepository(r: Repository) {
    this.data.repositories.push(r);
    this.save();
  }
  updateRepository(id: string, patch: Partial<Pick<Repository, "name" | "allowConfigEvaluation">>) {
    const r = this.repository(id);
    if (!r) return null;
    Object.assign(r, patch);
    this.save();
    return r;
  }
  removeRepository(id: string) {
    for (const s of this.data.scans.filter((s) => s.repositoryId === id)) this.deleteScanFile(s.id);
    this.data.repositories = this.data.repositories.filter((r) => r.id !== id);
    this.data.scans = this.data.scans.filter((s) => s.repositoryId !== id);
    this.data.baselines = this.data.baselines.filter((b) => b.repositoryId !== id);
    this.save();
  }

  scans(repositoryId: string) {
    return this.data.scans.filter((s) => s.repositoryId === repositoryId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  scan(id: string): Scan | null {
    if (!ID_RE.test(id)) return null;
    const f = path.join(this.dir, "scans", `${id}.json`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8")) as Scan;
  }
  addScan(s: Scan) {
    this.write(path.join(this.dir, "scans", `${s.id}.json`), s);
    this.data.scans.push(summarize(s));
    // Keep recent scans, plus any scan a baseline points at.
    const pinned = new Set(this.data.baselines.map((b) => b.scanId));
    const old = this.scans(s.repositoryId).slice(KEEP_SCANS_PER_REPO).filter((x) => !pinned.has(x.id));
    for (const o of old) this.deleteScanFile(o.id);
    const drop = new Set(old.map((o) => o.id));
    this.data.scans = this.data.scans.filter((x) => !drop.has(x.id));
    this.save();
  }
  private deleteScanFile(id: string) {
    if (!ID_RE.test(id)) return;
    fs.rmSync(path.join(this.dir, "scans", `${id}.json`), { force: true });
  }

  baselines(repositoryId: string) {
    return this.data.baselines.filter((b) => b.repositoryId === repositoryId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  baseline(id: string) {
    return this.data.baselines.find((b) => b.id === id) ?? null;
  }
  addBaseline(b: Baseline) {
    this.data.baselines.push(b);
    this.save();
  }
  removeBaseline(id: string) {
    this.data.baselines = this.data.baselines.filter((b) => b.id !== id);
    this.save();
  }
}
