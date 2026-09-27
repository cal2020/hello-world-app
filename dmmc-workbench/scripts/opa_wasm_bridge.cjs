#!/usr/bin/env node
// Line-oriented bridge used by the Python "wasm" OPA backend outside the browser.
// Same library (@open-policy-agent/opa-wasm) and the same compiled modules as the browser build.
// stdin: {"module": "<file>", "entrypoint": "<pkg/rule>", "input": {...}} per line
// stdout: {"result": <opa-wasm result set>} or {"error": "..."} per line
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadPolicy } = require(path.join(__dirname, "..", "web", "node_modules", "@open-policy-agent", "opa-wasm"));

const dir = process.argv[2];
const cache = new Map();

async function policy(module) {
  if (!cache.has(module)) {
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
