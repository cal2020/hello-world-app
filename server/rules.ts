// Structured architecture rules <-> detangle.toml text.
// Edits are made at the text level, one [[forbidden]] block at a time, so unrelated
// settings and comments survive. Every edit is verified by re-parsing: if anything other
// than the targeted rule changed, the edit is refused instead of saved.

import crypto from "node:crypto";
import { parse as parseToml } from "smol-toml";
import type { ConfigRule, ConfigVersion, RuleDraft, Severity } from "../shared/types.ts";
import { UserError } from "./roots.ts";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so hashes ignore key order and formatting. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const RULE_KINDS = ["forbidden", "allowed", "required"] as const;
type RuleKind = (typeof RULE_KINDS)[number];

export function ruleKey(kind: RuleKind, table: Record<string, unknown>, index: number): string {
  return typeof table.name === "string" ? table.name : kind === "allowed" ? "not-in-allowed" : `${kind}#${index}`;
}

/** Version of the rule policy used for a scan: what a baseline comparison needs to detect config changes. */
export function configVersion(text: string | null, configPath: string | null, engineVersion: string): ConfigVersion {
  if (text === null) {
    return { source: "builtin", path: null, textHash: null, policyHash: sha256(`builtin@${engineVersion}`).slice(0, 16), ruleHashes: {} };
  }
  const parsed = parseToml(text) as Record<string, unknown>;
  const ruleHashes: Record<string, string> = {};
  for (const kind of RULE_KINDS) {
    const list = Array.isArray(parsed[kind]) ? (parsed[kind] as Record<string, unknown>[]) : [];
    list.forEach((t, i) => {
      const k = ruleKey(kind, t, i);
      ruleHashes[k] = sha256(canonical({ kind, t, k })).slice(0, 16);
    });
  }
  // Everything that isn't a rule (options, groups, allowed_severity…) can change every result.
  const rest = Object.fromEntries(Object.entries(parsed).filter(([k]) => !(RULE_KINDS as readonly string[]).includes(k)));
  ruleHashes["[options]"] = sha256(canonical(rest)).slice(0, 16);
  return { source: "file", path: configPath, textHash: sha256(text), policyHash: sha256(canonical(parsed)).slice(0, 16), ruleHashes };
}

// ---- Text blocks ------------------------------------------------------------

const HEADER = /^\s*\[\[?\s*([A-Za-z0-9_.\-"' ]+?)\s*\]\]?\s*(#.*)?$/;

interface Block {
  kind: string;
  /** First line of the block including attached leading comments. */
  start: number;
  headerLine: number;
  /** Exclusive end line (trailing blank/comment lines belong to the next block). */
  end: number;
}

/** Locates table headers line by line, skipping multi-line strings. */
function findBlocks(lines: string[]): { blocks: Block[]; firstHeader: number } {
  const headers: { line: number; name: string; isArray: boolean }[] = [];
  let inMulti: string | null = null;
  lines.forEach((line, i) => {
    if (inMulti) {
      if (line.includes(inMulti)) inMulti = null;
      return;
    }
    for (const q of ['"""', "'''"]) {
      const count = line.split(q).length - 1;
      if (count % 2 === 1) inMulti = q;
    }
    const m = HEADER.exec(line);
    if (m && !line.includes("=")) headers.push({ line: i, name: m[1].trim(), isArray: /^\s*\[\[/.test(line) });
  });
  const blocks: Block[] = headers.map((h, idx) => {
    const next = idx + 1 < headers.length ? headers[idx + 1].line : lines.length;
    let end = next;
    // Trailing comments/blank lines describe the next block (or stand alone at the end of the file).
    while (end - 1 > h.line && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
    let start = h.line;
    while (start - 1 >= 0 && /^\s*#/.test(lines[start - 1])) start--;
    return { kind: h.isArray ? h.name : `[${h.name}]`, start, headerLine: h.line, end };
  });
  return { blocks, firstHeader: headers.length ? headers[0].line : lines.length };
}

function parseOrThrow(text: string, what: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new UserError(`${what} is not valid TOML: ${(e as Error).message.split("\n")[0]}`, "toml-invalid", "Fix the file by hand, then reload.");
  }
}

/** Why the structured editor must not rewrite this file, if anything. */
export function unsupportedReason(text: string): string | null {
  const parsed = parseOrThrow(text, "detangle.toml");
  const lines = text.split("\n");
  const { blocks } = findBlocks(lines);
  for (const kind of RULE_KINDS) {
    const list = parsed[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `“${kind}” is not an array of tables.`;
    const located = blocks.filter((b) => b.kind === kind).length;
    if (located !== list.length) {
      return `The ${kind} rules are written as an inline array, which the visual editor can't rewrite without reformatting the file.`;
    }
  }
  return null;
}

// ---- Drafts <-> tables -------------------------------------------------------

const SEVERITIES: Severity[] = ["error", "warn", "info", "off"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.:]{0,63}$/;

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tomlString(s: string): string {
  if (!s.includes("'") && !/[\n\r]/.test(s)) return `'${s}'`;
  return JSON.stringify(s); // JSON escapes are valid TOML basic-string escapes
}

function inlineTable(fields: [string, string | boolean | string[] | Record<string, string[]> | undefined][]): string | null {
  const parts: string[] = [];
  for (const [k, v] of fields) {
    if (v === undefined || v === "") continue;
    if (typeof v === "boolean") parts.push(`${k} = ${v}`);
    else if (typeof v === "string") parts.push(`${k} = ${tomlString(v)}`);
    else if (Array.isArray(v)) parts.push(`${k} = [${v.map(tomlString).join(", ")}]`);
    else parts.push(`${k} = { ${Object.entries(v).map(([kk, vv]) => `${kk} = [${vv.map(tomlString).join(", ")}]`).join(", ")} }`);
  }
  return parts.length ? `{ ${parts.join(", ")} }` : null;
}

export function validateDraft(d: RuleDraft): string[] {
  const errs: string[] = [];
  if (!NAME_RE.test(d.name ?? "")) errs.push("Name: use 1–64 letters, digits, dashes or dots, starting with a letter or digit (e.g. no-cross-feature).");
  if (!SEVERITIES.includes(d.severity)) errs.push("Severity must be error, warn, info or off.");
  if (d.comment && d.comment.length > 500) errs.push("Reason: keep it under 500 characters.");
  const re = (label: string, v?: string) => {
    if (!v) return;
    if (v.length > 500) errs.push(`${label}: pattern too long.`);
    try {
      // The engine's regex dialect is authoritative; this catches obvious typos early.
      new RegExp(v.replace(/\$\d/g, "x"));
    } catch (e) {
      errs.push(`${label}: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`);
    }
  };
  switch (d.template) {
    case "isolate-siblings": {
      const f = (d.parentFolder ?? "").trim().replace(/^\.?\/+|\/+$/g, "");
      if (!f) errs.push("Pick the folder whose sub-folders must stay isolated (e.g. src/features).");
      else if (f.includes("..") || f.startsWith("/")) errs.push("Folder must be a path inside the repository.");
      break;
    }
    case "forbid-path":
      if (!d.fromPath && !d.fromPathNot) errs.push("Source: describe which modules the rule applies to.");
      if (!d.toPath && !d.toPathNot) errs.push("Destination: describe which imports are forbidden.");
      re("Source path", d.fromPath);
      re("Source exception", d.fromPathNot);
      re("Destination path", d.toPath);
      re("Destination exception", d.toPathNot);
      break;
    case "no-cycles":
      re("Via", d.via);
      break;
    case "no-unresolved":
      break;
    default:
      errs.push("Unknown rule type.");
  }
  return errs;
}

export function draftToToml(d: RuleDraft): string {
  const lines = ["[[forbidden]]", `name = ${tomlString(d.name)}`, `severity = ${tomlString(d.severity)}`];
  if (d.comment?.trim()) lines.push(`comment = ${tomlString(d.comment.trim())}`);
  switch (d.template) {
    case "isolate-siblings": {
      const f = escapeRegex((d.parentFolder ?? "").trim().replace(/^\.?\/+|\/+$/g, ""));
      lines.push(`from = { path = ${tomlString(`^${f}/([^/]+)/`)} }`);
      lines.push(`to = { path = ${tomlString(`^${f}/`)}, path_not = ${tomlString(`^${f}/$1/`)} }`);
      break;
    }
    case "forbid-path": {
      const from = inlineTable([["path", d.fromPath], ["path_not", d.fromPathNot]]);
      const to = inlineTable([["path", d.toPath], ["path_not", d.toPathNot]]);
      if (from) lines.push(`from = ${from}`);
      if (to) lines.push(`to = ${to}`);
      break;
    }
    case "no-cycles":
      lines.push(`to = ${inlineTable([["circular", true], ["via", d.via]])}`);
      break;
    case "no-unresolved":
      lines.push("to = { could_not_resolve = true }");
      break;
  }
  return lines.join("\n");
}

const onlyKeys = (o: unknown, keys: string[]) =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Recognizes tables the visual editor produces (or equivalent hand-written ones). */
export function tableToDraft(t: Record<string, unknown>): { draft: RuleDraft | null; reason?: string } {
  const allowedTop = ["name", "severity", "comment", "from", "to"];
  if (!onlyKeys(t, allowedTop)) return { draft: null, reason: `Uses settings the visual editor doesn't cover (${Object.keys(t).filter((k) => !allowedTop.includes(k)).join(", ")}).` };
  if (typeof t.name !== "string") return { draft: null, reason: "Unnamed rules can't be edited visually; give it a name in the file." };
  const sev = (str(t.severity) ?? "error") as Severity;
  const base = { name: t.name, severity: sev, comment: str(t.comment) };
  const from = (t.from ?? {}) as Record<string, unknown>;
  const to = (t.to ?? {}) as Record<string, unknown>;
  if (!t.from && onlyKeys(to, ["circular", "via"]) && to.circular === true) {
    return { draft: { ...base, template: "no-cycles", via: str(to.via) } };
  }
  if (!t.from && onlyKeys(to, ["could_not_resolve"]) && to.could_not_resolve === true) {
    return { draft: { ...base, template: "no-unresolved" } };
  }
  if (onlyKeys(from, ["path"]) && onlyKeys(to, ["path", "path_not"])) {
    const m = /^\^(.+)\/\(\[\^\/\]\+\)\/$/.exec(str(from.path) ?? "");
    if (m && to.path === `^${m[1]}/` && to.path_not === `^${m[1]}/$1/`) {
      return { draft: { ...base, template: "isolate-siblings", parentFolder: m[1].replace(/\\(.)/g, "$1") } };
    }
  }
  if (onlyKeys(from, ["path", "path_not"]) && onlyKeys(to, ["path", "path_not"]) && [from.path, from.path_not, to.path, to.path_not].every((v) => v === undefined || typeof v === "string")) {
    return { draft: { ...base, template: "forbid-path", fromPath: str(from.path), fromPathNot: str(from.path_not), toPath: str(to.path), toPathNot: str(to.path_not) } };
  }
  return { draft: null, reason: "Uses conditions the visual editor doesn't cover; edit it in detangle.toml." };
}

export function listRules(text: string): ConfigRule[] {
  const parsed = parseOrThrow(text, "detangle.toml");
  const out: ConfigRule[] = [];
  for (const kind of RULE_KINDS) {
    const list = Array.isArray(parsed[kind]) ? (parsed[kind] as Record<string, unknown>[]) : [];
    list.forEach((t, index) => {
      const { draft, reason } = kind === "forbidden" ? tableToDraft(t) : { draft: null, reason: `${kind} rules are shown read-only.` };
      out.push({
        kind,
        index,
        name: str(t.name) ?? null,
        severity: str(t.severity) ?? null,
        comment: str(t.comment) ?? null,
        table: JSON.parse(JSON.stringify(t)),
        editable: !!draft,
        draft,
        notEditableReason: reason,
      });
    });
  }
  return out;
}

// ---- Edits -------------------------------------------------------------------

export type RuleEdit = { op: "add"; draft: RuleDraft } | { op: "update"; index: number; draft: RuleDraft } | { op: "delete"; index: number };

/** Applies one edit to the forbidden rules and verifies nothing else changed. */
export function applyEdit(text: string, edit: RuleEdit): string {
  const reason = unsupportedReason(text);
  if (reason) throw new UserError(`This detangle.toml can't be edited visually: ${reason}`, "config-unsupported", "Edit the file by hand; scans and previews still work.");
  const before = parseOrThrow(text, "detangle.toml");
  const beforeRules = Array.isArray(before.forbidden) ? (before.forbidden as Record<string, unknown>[]) : [];
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  if (edit.op !== "delete") {
    const errs = validateDraft(edit.draft);
    if (errs.length) throw new UserError(errs.join(" "), "rule-invalid");
    const dup = beforeRules.findIndex((r) => r.name === edit.draft.name);
    if (dup !== -1 && !(edit.op === "update" && dup === edit.index)) {
      throw new UserError(`A rule named “${edit.draft.name}” already exists.`, "rule-duplicate", "Choose a different name.");
    }
  }

  let next: string;
  if (edit.op === "add") {
    const body = draftToToml(edit.draft).split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    next = [...lines, ...(lines.length ? [""] : []), ...body, ""].join(nl);
  } else {
    const { blocks } = findBlocks(lines);
    const forbiddenBlocks = blocks.filter((b) => b.kind === "forbidden");
    const target = forbiddenBlocks[edit.index];
    if (!target || edit.index >= beforeRules.length) throw new UserError("That rule no longer exists in detangle.toml.", "rule-missing", "Reload the rules.");
    if (edit.op === "update") {
      const { draft } = tableToDraft(beforeRules[edit.index]);
      if (!draft) throw new UserError("This rule uses settings the visual editor doesn't cover.", "rule-not-editable", "Edit it in detangle.toml by hand.");
      // Keep the rule's leading comments; replace the table text itself.
      const replacement = draftToToml(edit.draft).split("\n");
      next = [...lines.slice(0, target.headerLine), ...replacement, ...lines.slice(target.end)].join(nl);
    } else {
      let start = target.start;
      let end = target.end;
      // Remove one separating blank line so deletions don't leave gaps.
      if (end < lines.length && lines[end]?.trim() === "") end++;
      else if (start > 0 && lines[start - 1].trim() === "") start--;
      next = [...lines.slice(0, start), ...lines.slice(end)].join(nl);
    }
  }

  // Verify: everything except the targeted rule is unchanged.
  const after = parseOrThrow(next, "The edited file");
  const afterRules = Array.isArray(after.forbidden) ? (after.forbidden as Record<string, unknown>[]) : [];
  const strip = (o: Record<string, unknown>) => canonical({ ...o, forbidden: undefined });
  const want = [...beforeRules];
  const draftTable = () => (parseToml(draftToToml((edit as { draft: RuleDraft }).draft)).forbidden as Record<string, unknown>[])[0];
  if (edit.op === "add") want.push(draftTable());
  if (edit.op === "update") want[edit.index] = draftTable();
  if (edit.op === "delete") want.splice(edit.index, 1);
  if (strip(before) !== strip(after) || canonical(afterRules) !== canonical(want)) {
    throw new UserError("The edit would have changed more than the selected rule, so it was not applied.", "edit-unsafe", "Edit detangle.toml by hand for this change.");
  }
  return next;
}
