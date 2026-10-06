#!/usr/bin/env node
// Test runner for the browser engine. Loads every src/*.js (filename order) into this context the way
// the bundled page does, then every test/*.test.js, and runs the registered tests.
//
//   node test/run.mjs                 run everything
//   node test/run.mjs guards kernel   run tests whose file or name contains any filter
//   node test/run.mjs --list          list tests
//
// Test files are classic scripts with these globals: test(name, fn), skip(name, reason), assert
// (node:assert/strict), golden(name) -> parsed golden/<name>.json, ROOT (browser/ directory).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const filters = args.filter((a) => !a.startsWith("--"));

function loadDir(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => path.join(dir, f));
}

for (const file of loadDir(path.join(ROOT, "src"), /^\d\d_.*\.js$/)) {
  vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
}

const tests = [];
let currentFile = "";
const goldenCache = new Map();
globalThis.ROOT = ROOT;
globalThis.assert = assert;
globalThis.test = (name, fn) => tests.push({ file: currentFile, name, fn });
globalThis.skip = (name, reason) => tests.push({ file: currentFile, name, skip: reason || "skipped" });
globalThis.golden = (name) => {
  if (!goldenCache.has(name)) {
    const p = path.join(ROOT, "golden", name.endsWith(".json") ? name : name + ".json");
    if (!fs.existsSync(p)) throw new Error(`golden file missing: ${p} (run: python golden/gen_all.py)`);
    goldenCache.set(name, JSON.parse(fs.readFileSync(p, "utf8")));
  }
  return goldenCache.get(name);
};

for (const file of loadDir(path.join(ROOT, "test"), /\.test\.js$/)) {
  currentFile = path.basename(file);
  vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
}

const selected = tests.filter((t) => !filters.length || filters.some((f) => t.file.includes(f) || t.name.includes(f)));
if (listOnly) {
  for (const t of selected) console.log(`${t.file} :: ${t.name}${t.skip ? "  [skip]" : ""}`);
  process.exit(0);
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const t0 = performance.now();
for (const t of selected) {
  if (t.skip) { skipped++; continue; }
  try {
    await t.fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ t, err });
    process.stdout.write("F");
    continue;
  }
  process.stdout.write(".");
}
process.stdout.write("\n");
for (const { t, err } of failures) {
  console.log(`\nFAIL ${t.file} :: ${t.name}\n${err && err.stack ? err.stack.split("\n").slice(0, 12).join("\n") : err}`);
}
const ms = Math.round(performance.now() - t0);
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped in ${ms} ms`);
process.exit(failed ? 1 : 0);
