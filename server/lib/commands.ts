// Which shell commands an engine operation will run, read from `zit.toml` in
// the states involved, and whether the person has approved each exact command.
//
// Zit runs `[[check]]`, `[prepare]` and `[[derive]]` commands with `sh -c`
// (upstream src/evidence.rs, src/workspace.rs). Switchyard never builds a
// command itself: it only shows these, verbatim, and refuses to start the
// operation until every one has been approved once.

import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

export type CommandKind = 'check' | 'prepare' | 'derive';

export interface DeclaredCommand {
  kind: CommandKind;
  /** Check name, derived path, or "prepare". */
  name: string;
  run: string;
  /** Which state declared it: current (the governing state) or the change. */
  source: 'current' | 'change';
}

export interface ZitConfig {
  checks: Array<{ name: string; run: string; inputs: string[]; timeout: number | null }>;
  prepare: { run: string; inputs: string[] } | null;
  derive: Array<{ path: string; run: string }>;
}

export const EMPTY_CONFIG: ZitConfig = { checks: [], prepare: null, derive: [] };

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`zit.toml: ${what} must be a string`);
  return v;
};
const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`zit.toml: ${what} must be a list of strings`);
  return v as string[];
};

/**
 * Parse the parts of `zit.toml` that name commands. Throws with a message
 * that names the problem; Zit itself refuses the same file.
 */
export function parseZitConfig(text: string | null): ZitConfig {
  if (text === null) return EMPTY_CONFIG;
  const doc = parseToml(text) as Record<string, unknown>;
  const checks = (Array.isArray(doc.check) ? doc.check : doc.check === undefined ? [] : null) as Array<Record<string, unknown>> | null;
  if (checks === null) throw new Error('zit.toml: [[check]] must be an array of tables');
  const derives = (Array.isArray(doc.derive) ? doc.derive : doc.derive === undefined ? [] : null) as Array<Record<string, unknown>> | null;
  if (derives === null) throw new Error('zit.toml: [[derive]] must be an array of tables');
  const prep = doc.prepare as Record<string, unknown> | undefined;
  return {
    checks: checks.map((c, i) => ({
      name: str(c.name, `check ${i + 1} name`),
      run: str(c.run, `check ${i + 1} run`),
      inputs: strings(c.inputs, `check ${i + 1} inputs`),
      timeout: typeof c.timeout === 'number' ? c.timeout : null,
    })),
    prepare: prep ? { run: str(prep.run, 'prepare run'), inputs: strings(prep.inputs, 'prepare inputs') } : null,
    derive: derives.map((d, i) => ({ path: str(d.path, `derive ${i + 1} path`), run: str(d.run, `derive ${i + 1} run`) })),
  };
}

function fromConfig(config: ZitConfig, source: DeclaredCommand['source'], kinds: CommandKind[]): DeclaredCommand[] {
  const out: DeclaredCommand[] = [];
  if (kinds.includes('prepare') && config.prepare) out.push({ kind: 'prepare', name: 'prepare', run: config.prepare.run, source });
  if (kinds.includes('check')) for (const c of config.checks) out.push({ kind: 'check', name: c.name, run: c.run, source });
  if (kinds.includes('derive')) for (const d of config.derive) out.push({ kind: 'derive', name: d.path, run: d.run, source });
  return out;
}

function unique(commands: DeclaredCommand[]): DeclaredCommand[] {
  const seen = new Set<string>();
  return commands.filter((c) => {
    const key = approvalKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type Operation = 'materialise' | 'check' | 'accept' | 'retry';

/**
 * The commands an operation may run. `current` is the governing state's
 * config; `change` is the change's own (absent for materialise/retry).
 *  - materialise/retry: the `[prepare]` step of current (a fresh view of it).
 *  - check: the change's own checks, in a view of its state (which may prepare).
 *  - accept: current's checks and the change's, derive rules of both (they are
 *    rerun on the composed state), and prepare for the verification view.
 */
export function requiredCommands(op: Operation, current: ZitConfig, change: ZitConfig = EMPTY_CONFIG): DeclaredCommand[] {
  switch (op) {
    case 'materialise':
    case 'retry':
      return fromConfig(current, 'current', ['prepare']);
    case 'check':
      return fromConfig(change, 'change', ['prepare', 'check']);
    case 'accept':
      return unique([
        ...fromConfig(current, 'current', ['prepare', 'check', 'derive']),
        ...fromConfig(change, 'change', ['prepare', 'check', 'derive']),
      ]);
  }
}

/** Identity of an exact command: changing its name, kind or text needs a new approval. */
export function approvalKey(c: Pick<DeclaredCommand, 'kind' | 'name' | 'run'>): string {
  return createHash('sha256').update(`${c.kind}\0${c.name}\0${c.run}`).digest('hex').slice(0, 32);
}

export function unapproved(commands: DeclaredCommand[], approved: ReadonlySet<string>): DeclaredCommand[] {
  return commands.filter((c) => !approved.has(approvalKey(c)));
}
