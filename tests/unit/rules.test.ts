import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { applyEdit, draftToToml, listRules, tableToDraft, unsupportedReason } from "../../server/rules.ts";
import { FIXTURES } from "./helpers.ts";

const storefront = fs.readFileSync(path.join(FIXTURES, "storefront/detangle.toml"), "utf8");

describe("structured rules <-> TOML", () => {
  it("round-trips every template", () => {
    const drafts = [
      { template: "isolate-siblings", name: "iso", severity: "error", parentFolder: "src/features", comment: "Keep 'em apart" },
      { template: "forbid-path", name: "fp", severity: "warn", fromPath: "^src/ui/", fromPathNot: "\\.test\\.ts$", toPath: "^src/(api|db)/" },
      { template: "no-cycles", name: "nc", severity: "info", via: "^src/shared/" },
      { template: "no-unresolved", name: "nu", severity: "error" },
    ] as const;
    for (const d of drafts) {
      const table = (parse(draftToToml(d)).forbidden as Record<string, unknown>[])[0];
      const back = tableToDraft(table).draft!;
      expect(back).toMatchObject({ ...d, comment: "comment" in d ? d.comment : undefined });
    }
  });

  it("escapes regex characters in folder names", () => {
    const toml = draftToToml({ template: "isolate-siblings", name: "x", severity: "error", parentFolder: "src/(legacy).v2" });
    expect(toml).toContain("^src/\\(legacy\\)\\.v2/([^/]+)/");
  });

  it("recognizes the editable rules in the storefront config", () => {
    const rules = listRules(storefront);
    expect(rules.map((r) => [r.name, r.editable, r.draft?.template])).toEqual([
      ["no-circular", true, "no-cycles"],
      ["not-to-unresolvable", true, "no-unresolved"],
      ["no-cross-feature", true, "isolate-siblings"],
      ["ui-is-leaf", true, "forbid-path"],
    ]);
  });
});

describe("text-level edits preserve the rest of the file", () => {
  it("adding a rule appends it and keeps every comment and setting", () => {
    const next = applyEdit(storefront, { op: "add", draft: { template: "no-unresolved", name: "extra", severity: "warn" } });
    expect(next.startsWith(storefront.trimEnd())).toBe(true);
    for (const line of storefront.split("\n").filter((l) => l.startsWith("#"))) expect(next).toContain(line);
  });

  it("updating a rule replaces only that table and keeps its leading comment", () => {
    const rules = listRules(storefront);
    const target = rules.find((r) => r.name === "no-cross-feature")!;
    const next = applyEdit(storefront, { op: "update", index: target.index, draft: { ...target.draft!, severity: "warn" } });
    expect(next).toContain("# Features are vertical slices: they may use shared code, never each other.\n[[forbidden]]\nname = 'no-cross-feature'\nseverity = 'warn'");
    expect(next).toContain("# The design system must stay app-agnostic.");
    const before = parse(storefront) as Record<string, unknown>;
    const after = parse(next) as Record<string, unknown>;
    expect(after.options).toEqual(before.options);
    expect((after.forbidden as unknown[]).length).toBe(4);
  });

  it("deleting a rule removes it with its comment and nothing else", () => {
    const next = applyEdit(storefront, { op: "delete", index: 3 });
    expect(next).not.toContain("ui-is-leaf");
    expect(next).not.toContain("# The design system must stay app-agnostic.");
    expect(next).toContain("# Features are vertical slices");
    expect(next.trimEnd().endsWith("to = { path = '^src/features/', path_not = '^src/features/$1/' }")).toBe(true);
  });

  it("refuses to restructure inline-array rules", () => {
    const inline = `forbidden = [{ name = "a", to = { circular = true } }]\n`;
    expect(unsupportedReason(inline)).toMatch(/inline array/);
    expect(() => applyEdit(inline, { op: "add", draft: { template: "no-unresolved", name: "b", severity: "error" } })).toThrow(/can't be edited visually/);
  });

  it("refuses an edit when a multi-line string hides a header", () => {
    const tricky = `[[forbidden]]\nname = "a"\ncomment = """\n[[forbidden]]\n"""\nto = { circular = true }\n`;
    expect(listRules(tricky)).toHaveLength(1);
    const next = applyEdit(tricky, { op: "delete", index: 0 });
    expect(parse(next)).toEqual({});
  });

  it("rejects duplicate names and invalid drafts with actionable messages", () => {
    expect(() => applyEdit(storefront, { op: "add", draft: { template: "no-unresolved", name: "ui-is-leaf", severity: "error" } })).toThrow(/already exists/);
    expect(() => applyEdit(storefront, { op: "add", draft: { template: "forbid-path", name: "x", severity: "error", fromPath: "^src/(", toPath: "a" } })).toThrow(/Source path/);
    expect(() => applyEdit(storefront, { op: "add", draft: { template: "isolate-siblings", name: "bad name!", severity: "error", parentFolder: "src" } })).toThrow(/Name/);
  });
});
