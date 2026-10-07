import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff';

const DIFF = `diff --git a/src/pricing.js b/src/pricing.js
index 1111111..2222222 100644
--- a/src/pricing.js
+++ b/src/pricing.js
@@ -6,3 +6,3 @@ export function subtotal(items) {
 export function tax(cents, rate) {
-  return Math.round(cents * rate);
+  return Math.floor(cents * rate);
 }
diff --git a/src/discount.js b/src/discount.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/discount.js
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
\\ No newline at end of file
`;

describe('parseDiff', () => {
  it('reads files, statuses, counts and line numbers', () => {
    const files = parseDiff(DIFF);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ newPath: 'src/pricing.js', status: 'modified', additions: 1, deletions: 1 });
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 6, 6],
      ['del', 7, null],
      ['add', null, 7],
      ['ctx', 8, 8],
    ]);
    expect(files[1]).toMatchObject({ oldPath: null, newPath: 'src/discount.js', status: 'added', additions: 2, deletions: 0 });
    expect(files[1]!.hunks[0]!.lines.at(-1)!.kind).toBe('meta');
  });

  it('returns nothing for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
