import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareToBaseline, shortestPath } from "../../server/scan.ts";
import { sha256 } from "../../server/rules.ts";
import { tempCopy, tempService } from "./helpers.ts";

const SEARCH = "src/features/search/SearchPage.tsx";
const addImport = (root: string) => {
  const f = path.join(root, SEARCH);
  fs.writeFileSync(f, `import { lines } from "../cart/cartStore";\nvoid lines;\n${fs.readFileSync(f, "utf8")}`);
};
const removeImport = (root: string) => {
  const f = path.join(root, SEARCH);
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(`import { lines } from "../cart/cartStore";\nvoid lines;\n`, ""));
};

describe("rule preview and save use the real engine", () => {
  it("previews actual added violations and saves with a backup", async () => {
    const root = tempCopy("storefront");
    const s = tempService();
    const repo = s.register({ path: root });
    const edit = { op: "add", draft: { template: "forbid-path", name: "no-feature-to-api", severity: "error", fromPath: "^src/features/", toPath: "^src/api/" } } as const;
    const p = await s.previewRule(repo.id, edit);
    expect(p.ok).toBe(true);
    expect(p.added.map((v) => v.from).sort()).toEqual(["src/features/account/AccountPage.tsx", "src/features/catalog/useCatalog.ts", "src/features/search/searchIndex.ts"]);
    expect(p.ruleViolations).toHaveLength(3);
    expect(p.removed).toEqual([]);
    expect(p.diff).toContain("+name = 'no-feature-to-api'");
    const original = fs.readFileSync(path.join(root, "detangle.toml"), "utf8");
    const r = await s.saveRule(repo.id, edit, p.baseTextHash);
    expect(fs.readFileSync(r.backup!, "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(root, "detangle.toml"), "utf8")).toBe(p.proposedText);
    const scan = await s.scan(repo.id);
    expect(scan.violations.filter((v) => v.rule === "no-feature-to-api")).toHaveLength(3);
  });

  it("refuses to save over a file that changed after the preview", async () => {
    const root = tempCopy("storefront");
    const s = tempService();
    const repo = s.register({ path: root });
    const edit = { op: "delete", index: 0 } as const;
    const p = await s.previewRule(repo.id, edit);
    fs.appendFileSync(path.join(root, "detangle.toml"), "\n# someone else edited this\n");
    await expect(s.saveRule(repo.id, edit, p.baseTextHash)).rejects.toMatchObject({ code: "config-changed", status: 409 });
    expect(fs.readFileSync(path.join(root, "detangle.toml"), "utf8")).toContain("someone else edited this");
  });

  it("reports engine rejections in the preview instead of saving", async () => {
    const root = tempCopy("storefront");
    const s = tempService();
    const repo = s.register({ path: root });
    // Valid JS regex (\p without the u flag is a literal), invalid for the engine's regex dialect.
    const edit = { op: "add", draft: { template: "forbid-path", name: "bad", severity: "error", fromPath: "^src/\\p{Nope}", toPath: "x" } } as const;
    const p = await s.previewRule(repo.id, edit);
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/detangle\.toml \(proposed\).*invalid regex/);
    expect(p.error).not.toMatch(/lattice-preview/);
    await expect(s.saveRule(repo.id, edit, p.baseTextHash)).rejects.toMatchObject({ code: "config-rejected" });
  });

  it("creating the first rule keeps the engine's built-in checks", async () => {
    const root = tempCopy("cycle-app");
    const s = tempService();
    const repo = s.register({ path: root });
    const edit = { op: "add", draft: { template: "forbid-path", name: "orders-no-pricing", severity: "warn", fromPath: "^src/orders/", toPath: "^src/pricing/" } } as const;
    const p = await s.previewRule(repo.id, edit);
    expect(p.baseTextHash).toBeNull();
    expect(p.removed).toEqual([]); // built-in no-circular still runs
    expect(p.added.map((v) => v.rule)).toEqual(["orders-no-pricing"]);
    await s.saveRule(repo.id, edit, null);
    expect(fs.readFileSync(path.join(root, "detangle.toml"), "utf8")).toContain('name = "no-circular"');
  });
});

describe("baselines", () => {
  it("flags only the introduced violation, then reports it resolved (same policy)", async () => {
    const root = tempCopy("storefront");
    const s = tempService();
    const repo = s.register({ path: root });
    const first = await s.scan(repo.id);
    const b = s.createBaseline(repo.id, first.id, "before");
    addImport(root);
    const second = await s.scan(repo.id);
    const c1 = s.compare(b.id, second.id);
    expect(c1.samePolicy).toBe(true);
    expect(c1.items.filter((i) => i.status === "new").map((i) => [i.violation.rule, i.violation.from, i.violation.to])).toEqual([["no-cross-feature", SEARCH, "src/features/cart/cartStore.ts"]]);
    expect(c1.counts).toMatchObject({ new: 1, resolved: 0, "policy-changed": 0, unchanged: first.violations.length });
    // Removing the import resolves it: a baseline saved with it now shows it as resolved.
    const b2 = s.createBaseline(repo.id, second.id, "with import");
    removeImport(root);
    const third = await s.scan(repo.id);
    expect(s.compare(b.id, third.id).counts).toMatchObject({ new: 0, resolved: 0 });
    expect(s.compare(b2.id, third.id).counts).toMatchObject({ new: 0, resolved: 1 });
    expect(third.source.graphFingerprint).toBe(first.source.graphFingerprint);
  });

  it("does not misreport a configuration change as a code fix", async () => {
    const root = tempCopy("storefront");
    const s = tempService();
    const repo = s.register({ path: root });
    const first = await s.scan(repo.id);
    const b = s.createBaseline(repo.id, first.id, "before");
    const rules = s.rules(repo.id);
    const ui = rules.rules.find((r) => r.name === "ui-is-leaf")!;
    const p = await s.previewRule(repo.id, { op: "delete", index: ui.index });
    await s.saveRule(repo.id, { op: "delete", index: ui.index }, p.baseTextHash);
    const after = await s.scan(repo.id);
    const c = s.compare(b.id, after.id);
    expect(c.samePolicy).toBe(false);
    expect(c.changedRules).toEqual(["ui-is-leaf"]);
    expect(c.counts.resolved).toBe(0);
    expect(c.items.filter((i) => i.status === "policy-changed").map((i) => i.violation.rule)).toEqual(["ui-is-leaf"]);
  });

  it("ignores comment-only edits when comparing policies", () => {
    const base = { id: "b", schemaVersion: 1, repositoryId: "r", name: "x", createdAt: "", scanId: "s", source: { commit: null, branch: null, graphFingerprint: "f" }, violations: [] };
    const cfg = { source: "file" as const, path: "detangle.toml", textHash: sha256("a"), policyHash: "p", ruleHashes: { r1: "h" } };
    const scan = { ...base, startedAt: "", config: { ...cfg, textHash: sha256("b") }, violations: [], modules: [], edges: [], cycles: [], notes: [], cyclesIgnoreTypeOnly: true, durationMs: 0, engineMs: { scan: 0, graph: 0 }, engineVersion: "", counts: {} } as never;
    expect(compareToBaseline({ ...base, config: cfg }, scan).samePolicy).toBe(true);
  });
});

describe("shortest path", () => {
  it("finds the shortest chain and respects the type-only switch", async () => {
    const s = tempService();
    const repo = s.register({ path: tempCopy("clean-app") });
    const scan = await s.scan(repo.id);
    const p = shortestPath(scan.edges, "src/main.ts", "src/lib/text.ts");
    expect(p.hops.map((h) => h.to)).toEqual(["src/ui/greeting.ts", "src/lib/text.ts"]);
    expect(shortestPath(scan.edges, "src/ui/greeting.ts", "src/data/user.ts", { includeTypeOnly: false }).found).toBe(false);
    expect(shortestPath(scan.edges, "src/lib/text.ts", "src/main.ts").found).toBe(false);
  });
});

describe("access control and failures", () => {
  it("rejects invalid registration paths with actionable errors", () => {
    const s = tempService();
    const file = path.join(os.tmpdir(), `lattice-file-${process.pid}`);
    fs.writeFileSync(file, "x");
    const noPkg = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-nopkg-"));
    const cases: [unknown, string][] = [
      ["", "path-required"],
      ["relative/path", "path-not-absolute"],
      ["/definitely/not/here", "path-missing"],
      [file, "path-not-directory"],
      ["/", "path-too-broad"],
      [os.homedir(), "path-too-broad"],
      [noPkg, "path-not-project"],
    ];
    for (const [p, code] of cases) expect(() => s.register({ path: p }), String(p)).toThrow(expect.objectContaining({ code }));
  });

  it("does not follow symlinks out of the root and leaves outside modules out", async () => {
    const root = tempCopy("clean-app");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-outside-"));
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    fs.symlinkSync(outside, path.join(root, "src/linked"));
    fs.appendFileSync(path.join(root, "src/main.ts"), 'import { secret } from "./linked/secret";\nvoid secret;\n');
    const s = tempService();
    const repo = s.register({ path: root });
    const scan = await s.scan(repo.id);
    expect(scan.notes.map((n) => n.code)).toContain("symlink-outside-root");
    expect(scan.modules.every((m) => !m.id.includes("secret") || m.kind === "unresolved")).toBe(true);
    expect(scan.modules.every((m) => !m.id.startsWith("..") && !m.id.startsWith("/"))).toBe(true);
  });

  it("blocks bundler-config evaluation unless explicitly allowed", async () => {
    const root = tempCopy("clean-app");
    fs.writeFileSync(path.join(root, "detangle.toml"), '[options]\nvite_config = "vite.config.js"\n');
    const s = tempService();
    const repo = s.register({ path: root });
    await expect(s.scan(repo.id)).rejects.toMatchObject({ code: "config-evaluation-blocked" });
  });

  it("turns a broken repository config into an actionable error", async () => {
    const root = tempCopy("clean-app");
    fs.writeFileSync(path.join(root, "detangle.toml"), "[[forbidden]]\nname = 'x'\nto = { pathx = 'a' }\n");
    const s = tempService();
    const repo = s.register({ path: root });
    const err = await s.scan(repo.id).catch((e) => e);
    expect(err.code).toBe("engine-failed");
    expect(err.message).toMatch(/unknown field `pathx`/);
    expect(err.hint).toMatch(/detangle\.toml/);
  });

  it("cancels a running scan", async () => {
    const s = tempService();
    const repo = s.register({ path: tempCopy("storefront") });
    const c = new AbortController();
    const p = s.scan(repo.id, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "engine-cancelled" });
    expect(s.isScanning(repo.id)).toBe(false);
  });
});
