// TEMPORARY development helper (removed before hand-off): ?ct=<s> starts the
// close-up clock at <s> seconds, ?cf=<s> freezes it there.
const params = new URLSearchParams(window.location.search);
const start = params.get('ct');
const frozen = params.get('cf');
let first: number | null = null;

export function debugTime(t: number): number {
  if (frozen !== null) return Number(frozen);
  if (start === null) return t;
  if (first === null) first = t;
  return Number(start) + (t - first);
}
