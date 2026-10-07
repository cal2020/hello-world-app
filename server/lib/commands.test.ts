import { describe, expect, it } from 'vitest';
import { approvalKey, parseZitConfig, requiredCommands, unapproved } from './commands';

const CURRENT = `
[[check]]
name = "unit"
run = "npm test"

[prepare]
run = "npm ci"
inputs = ["package-lock.json"]

[[derive]]
path = "schema.json"
run = "node gen.js"
`;

const CHANGE = `
[[check]]
name = "unit"
run = "npm test"

[[check]]
name = "e2e"
run = "npx playwright test"
`;

describe('zit.toml commands', () => {
  it('parses checks, prepare and derive verbatim', () => {
    const c = parseZitConfig(CURRENT);
    expect(c.checks).toEqual([{ name: 'unit', run: 'npm test', inputs: [], timeout: null }]);
    expect(c.prepare).toEqual({ run: 'npm ci', inputs: ['package-lock.json'] });
    expect(c.derive).toEqual([{ path: 'schema.json', run: 'node gen.js' }]);
    expect(parseZitConfig(null)).toEqual({ checks: [], prepare: null, derive: [] });
  });

  it('refuses malformed files with a message naming the problem', () => {
    expect(() => parseZitConfig('[[check]]\nname = 1\nrun = "x"')).toThrow(/check 1 name/);
    expect(() => parseZitConfig('check = "x"')).toThrow(/array of tables/);
    expect(() => parseZitConfig('[[check]\n')).toThrow();
  });

  it('lists what each operation may run', () => {
    const cur = parseZitConfig(CURRENT);
    const own = parseZitConfig(CHANGE);
    expect(requiredCommands('materialise', cur).map((c) => c.run)).toEqual(['npm ci']);
    expect(requiredCommands('check', cur, own).map((c) => c.run)).toEqual(['npm test', 'npx playwright test']);
    // Accept: current's gate plus the change's own, deduplicated.
    const accept = requiredCommands('accept', cur, own);
    expect(accept.map((c) => `${c.kind}:${c.name}:${c.source}`)).toEqual([
      'prepare:prepare:current',
      'check:unit:current',
      'derive:schema.json:current',
      'check:e2e:change',
    ]);
  });

  it('an approval covers one exact command text', () => {
    const a = { kind: 'check' as const, name: 'unit', run: 'npm test' };
    expect(approvalKey(a)).toBe(approvalKey({ ...a }));
    expect(approvalKey(a)).not.toBe(approvalKey({ ...a, run: 'npm test; curl evil' }));
    expect(approvalKey(a)).not.toBe(approvalKey({ ...a, kind: 'derive' }));
    const cmds = requiredCommands('check', parseZitConfig(null), parseZitConfig(CHANGE));
    expect(unapproved(cmds, new Set([approvalKey(cmds[0]!)])).map((c) => c.name)).toEqual(['e2e']);
  });
});
