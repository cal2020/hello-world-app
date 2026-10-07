// Local HTTP service. Binds to loopback, rejects cross-origin and DNS-rebinding requests,
// and serves the built UI in production.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { RuleDraft } from "../shared/types.ts";
import { markdownReport, jsonReport } from "./report.ts";
import { asUserError, Service } from "./service.ts";
import { UserError } from "./roots.ts";
import type { RuleEdit } from "./rules.ts";
import { shortestPath } from "./scan.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

export function buildServer(opts: { dataDir: string; port: number; devOrigins?: string[]; serveUi?: boolean }) {
  const service = new Service(opts.dataDir);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, ...(opts.devOrigins ?? []).map((o) => new URL(o).host)]);
  const allowedOrigins = new Set([`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`, ...(opts.devOrigins ?? [])]);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host)) return reply.code(403).send({ error: "Unexpected Host header.", code: "host-rejected" });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "Cross-origin requests are not allowed.", code: "origin-rejected" });
    if (req.method !== "GET" && req.headers["x-lattice"] !== "1") {
      return reply.code(403).send({ error: "Missing request header.", code: "csrf-rejected" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const fastifyErr = err as { statusCode?: number; message: string };
    if (!(err instanceof UserError) && fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply.code(fastifyErr.statusCode).send({ error: "The request was not understood.", code: "bad-request", hint: fastifyErr.message });
    }
    const e = asUserError(err);
    reply.code(e.status).send({ error: e.message, code: e.code, hint: e.hint });
  });

  const body = (req: FastifyRequest) => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const param = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k] ?? "");

  /** Aborts long operations when the browser cancels the request. */
  const requestSignal = (req: FastifyRequest, reply: FastifyReply) => {
    const c = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) c.abort();
    });
    req.raw.on("aborted", () => c.abort());
    return c.signal;
  };

  const parseEdit = (b: Record<string, unknown>): RuleEdit => {
    const op = b.op;
    const draft = b.draft as RuleDraft | undefined;
    const index = typeof b.index === "number" ? b.index : -1;
    if (op === "add" && draft) return { op, draft };
    if (op === "update" && draft && index >= 0) return { op, index, draft };
    if (op === "delete" && index >= 0) return { op, index };
    throw new UserError("The rule edit is incomplete.", "edit-invalid");
  };

  app.get("/api/health", async () => ({ ok: true }));

  // Bundled demo projects (synthetic), offered as one-click registrations.
  app.get("/api/fixtures", async () => {
    const dir = path.join(appRoot, "fixtures");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "package.json")))
      .map((d) => {
        let description = "";
        try {
          description = JSON.parse(fs.readFileSync(path.join(dir, d.name, "package.json"), "utf8")).description ?? "";
        } catch {
          /* ignore */
        }
        return { name: d.name, path: path.join(dir, d.name), description };
      });
  });

  app.get("/api/repos", async () =>
    service.store.repositories().map((r) => ({ ...r, scanning: service.isScanning(r.id), latestScan: service.store.scans(r.id)[0] ?? null })),
  );
  app.post("/api/repos", async (req) => service.register(body(req) as { path: unknown; name?: unknown }));
  app.patch("/api/repos/:id", async (req) => {
    const b = body(req);
    service.repo(param(req, "id"));
    const patch: { name?: string; allowConfigEvaluation?: boolean } = {};
    if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
    if (typeof b.allowConfigEvaluation === "boolean") patch.allowConfigEvaluation = b.allowConfigEvaluation;
    return service.store.updateRepository(param(req, "id"), patch);
  });
  app.delete("/api/repos/:id", async (req) => {
    service.repo(param(req, "id"));
    service.store.removeRepository(param(req, "id"));
    return { ok: true };
  });

  app.post("/api/repos/:id/scan", async (req, reply) => service.scan(param(req, "id"), requestSignal(req, reply)));
  app.post("/api/repos/:id/scan/cancel", async (req) => ({ cancelled: service.cancelScan(param(req, "id")) }));
  app.get("/api/repos/:id/scans", async (req) => service.store.scans(param(req, "id")));
  app.get("/api/repos/:id/scans/latest", async (req) => service.latestScan(param(req, "id")));
  app.get("/api/scans/:id", async (req) => service.getScan(param(req, "id")));
  app.get("/api/scans/:id/path", async (req) => {
    const q = req.query as Record<string, string>;
    const scan = service.getScan(param(req, "id"));
    if (!q.from || !q.to) throw new UserError("Pick both modules to explain a path.", "path-args");
    return shortestPath(scan.edges, q.from, q.to, { includeTypeOnly: q.types !== "0" });
  });

  app.get("/api/repos/:id/rules", async (req) => service.rules(param(req, "id")));
  app.post("/api/repos/:id/rules/preview", async (req, reply) => service.previewRule(param(req, "id"), parseEdit(body(req)), requestSignal(req, reply)));
  app.post("/api/repos/:id/rules/save", async (req) => {
    const b = body(req);
    return service.saveRule(param(req, "id"), parseEdit(b), typeof b.baseTextHash === "string" ? b.baseTextHash : null);
  });
  app.get("/api/repos/:id/config/export", async (req, reply) => {
    const state = service.rules(param(req, "id"));
    const text = state.exists ? state.text : await service.starterConfig();
    reply.header("content-disposition", 'attachment; filename="detangle.toml"').type("application/toml; charset=utf-8");
    return text;
  });

  app.get("/api/repos/:id/baselines", async (req) => service.store.baselines(param(req, "id")).map(({ violations, ...b }) => ({ ...b, violationCount: violations.length })));
  app.post("/api/repos/:id/baselines", async (req) => {
    const b = body(req);
    const { violations, ...rest } = service.createBaseline(param(req, "id"), String(b.scanId ?? ""), b.name);
    return { ...rest, violationCount: violations.length };
  });
  app.delete("/api/baselines/:id", async (req) => {
    service.store.removeBaseline(param(req, "id"));
    return { ok: true };
  });
  app.get("/api/baselines/:id/compare/:scanId", async (req) => service.compare(param(req, "id"), param(req, "scanId")));

  app.get("/api/scans/:id/report", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const scan = service.getScan(param(req, "id"));
    const repo = service.repo(scan.repositoryId);
    const comparison = q.baseline ? service.compare(q.baseline, scan.id) : null;
    const stamp = scan.startedAt.slice(0, 10);
    const slug = repo.name.replace(/[^A-Za-z0-9_-]+/g, "-");
    if (q.format === "md") {
      reply.header("content-disposition", `attachment; filename="${slug}-architecture-${stamp}.md"`).type("text/markdown; charset=utf-8");
      return markdownReport(repo, scan, comparison);
    }
    reply.header("content-disposition", `attachment; filename="${slug}-architecture-${stamp}.json"`).type("application/json");
    return JSON.stringify(jsonReport(repo, scan, comparison, q.root === "1"), null, 2);
  });

  if (opts.serveUi) {
    const dist = path.join(appRoot, "dist");
    if (fs.existsSync(dist)) {
      app.register(fastifyStatic, { root: dist });
      app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found", code: "not-found" }) : reply.sendFile("index.html")));
    }
  }
  return { app, service };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT ?? 4318);
  const host = process.env.HOST ?? "127.0.0.1";
  const dataDir = path.resolve(process.env.LATTICE_DATA ?? path.join(appRoot, ".lattice-data"));
  const dev = process.env.NODE_ENV !== "production";
  const { app } = buildServer({ dataDir, port, devOrigins: dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : [], serveUi: !dev });
  app.listen({ port, host }).then(() => {
    console.log(`Lattice service on http://${host}:${port}${dev ? " (API; UI on http://127.0.0.1:5173)" : ""}`);
    console.log(`Data: ${dataDir}`);
  });
}
