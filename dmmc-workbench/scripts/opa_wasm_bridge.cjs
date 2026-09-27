#!/usr/bin/env node
// Line-oriented bridge used by the Python "wasm" OPA backend outside the browser.
// Same file (opa-wasm-browser.esm.js) and the same compiled modules as the browser build.
// stdin: {"module": "<file>", "entrypoint": "<pkg/rule>", "input": {...}} per line
// stdout: {"result": <opa-wasm result set>} or {"error": "..."} per line
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Load the exact bytes that scripts/build_web.py ships as vendor/opa-wasm-browser.esm.js. A data: URL is
// always parsed as an ES module, so this works on every Node 18+ (no reliance on module-syntax detection).
const ESM = path.join(__dirname, "..", "web", "node_modules", "@open-policy-agent", "opa-wasm", "dist", "opa-wasm-browser.esm.js");
const lib = import("data:text/javascript;base64," + fs.readFileSync(ESM).toString("base64")).then((m) => m.default);

const dir = process.argv[2];
const cache = new Map();

async function policy(module) {
  if (!cache.has(module)) {
    const { loadPolicy } = await lib;
    const p = await loadPolicy(fs.readFileSync(path.join(dir, module)));
    p.setData({});
    cache.set(module, p);
  }
  return cache.get(module);
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(async () => {
    try {
      const msg = JSON.parse(line);
      const p = await policy(msg.module);
      process.stdout.write(JSON.stringify({ result: p.evaluate(msg.input, msg.entrypoint) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + "\n");
    }
  });
});
