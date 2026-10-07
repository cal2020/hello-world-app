import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server/index.ts";
import { FIXTURES } from "./helpers.ts";

const make = () => buildServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "lattice-http-")), port: 4318 }).app;
const ok = { host: "127.0.0.1:4318" };

describe("local service protections", () => {
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await make().inject({ method: "GET", url: "/api/repos", headers: { host: "evil.example:4318" } });
    expect(r.statusCode).toBe(403);
  });
  it("rejects cross-origin requests", async () => {
    const r = await make().inject({ method: "GET", url: "/api/repos", headers: { ...ok, origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
  });
  it("requires the custom header on mutations", async () => {
    const r = await make().inject({ method: "POST", url: "/api/repos", headers: ok, payload: { path: FIXTURES } });
    expect(r.json().code).toBe("csrf-rejected");
  });
  it("registers, scans and exports a relative-path report", async () => {
    const app = make();
    const h = { ...ok, "x-lattice": "1" };
    const repo = (await app.inject({ method: "POST", url: "/api/repos", headers: h, payload: { path: path.join(FIXTURES, "boundary-app") } })).json();
    const scan = (await app.inject({ method: "POST", url: `/api/repos/${repo.id}/scan`, headers: h, payload: {} })).json();
    expect(scan.violations).toHaveLength(1);
    const md = await app.inject({ method: "GET", url: `/api/scans/${scan.id}/report?format=md`, headers: ok });
    expect(md.headers["content-disposition"]).toMatch(/attachment/);
    expect(md.body).toContain("`src/features/checkout/view.ts` → `src/features/cart/store.ts`");
    const json = (await app.inject({ method: "GET", url: `/api/scans/${scan.id}/report?format=json`, headers: ok })).json();
    expect(JSON.stringify(json)).not.toContain(FIXTURES);
    expect(json.scan.config.policyHash).toBe(scan.config.policyHash);
    const cfg = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/config/export`, headers: ok });
    expect(cfg.body).toContain("no-cross-feature");
  });
  it("returns actionable errors for bad input", async () => {
    const r = await make().inject({ method: "POST", url: "/api/repos", headers: { ...ok, "x-lattice": "1" }, payload: { path: "nope" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "path-not-absolute" });
  });
});
