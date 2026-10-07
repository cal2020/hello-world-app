import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service } from "../../server/service.ts";

export const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures");

/** Copies a fixture into a disposable temp dir so tests can edit it freely. */
export function tempCopy(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-test-"));
  const dest = path.join(dir, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return fs.realpathSync(dest);
}

export function tempService(): Service {
  return new Service(fs.mkdtempSync(path.join(os.tmpdir(), "lattice-data-")));
}
