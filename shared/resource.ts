// Zit's resource model (upstream src/resource.rs), mirrored for display-side
// overlap analysis only. Claims and acceptance are always decided by the
// engine; this module never decides whether a change may land.

export type Resource =
  | { kind: 'file'; path: string }
  | { kind: 'symbol'; path: string; name: string }
  | { kind: 'top'; path: string };

const unescape = (path: string) => path.replaceAll('%23', '#').replaceAll('%25', '%');

export function parseResource(text: string): Resource {
  const hash = text.indexOf('#');
  if (hash < 0) return { kind: 'file', path: unescape(text) };
  const path = unescape(text.slice(0, hash));
  const name = text.slice(hash + 1);
  return name === '' ? { kind: 'top', path } : { kind: 'symbol', path, name };
}

export function resourceText(r: Resource): string {
  const path = r.path.replaceAll('%', '%25').replaceAll('#', '%23');
  switch (r.kind) {
    case 'file':
      return path;
    case 'symbol':
      return `${path}#${r.name}`;
    case 'top':
      return `${path}#`;
  }
}

function same(a: Resource, b: Resource): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false;
  return a.kind !== 'symbol' || a.name === (b as { name: string }).name;
}

/** Equal, or one is a whole file containing the other (upstream `overlaps`). */
export function overlaps(a: Resource, b: Resource): boolean {
  if (same(a, b)) return true;
  const whole = a.kind === 'file' || b.kind === 'file';
  return whole && a.path === b.path;
}

/** As `overlaps`, and a type also holds its methods (upstream `held_with`). */
export function heldWith(a: Resource, b: Resource): boolean {
  const member = (x: Resource, y: Resource) =>
    x.kind === 'symbol' && y.kind === 'symbol' && x.path === y.path && y.name.startsWith(`${x.name}::`);
  return overlaps(a, b) || member(a, b) || member(b, a);
}

/** Human-readable label: `src/a.ts › price`, `src/a.ts (module code)`, `src/a.ts`. */
export function describeResource(text: string): string {
  const r = parseResource(text);
  if (r.kind === 'file') return r.path;
  if (r.kind === 'top') return `${r.path} (module code)`;
  return `${r.path} › ${r.name}`;
}

const SYMBOL_NAME = /^[^\s#\0]{1,200}$/;

/**
 * Validate a resource typed by a person before it is passed to `zit claim`.
 * Paths must be relative to the repository root and stay inside it. Returns
 * an error message, or null when the text is acceptable.
 */
export function validateResourceInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'Enter a path such as src/lib.rs or src/lib.rs#price.';
  if (trimmed.length > 400) return 'That resource is too long (400 characters at most).';
  if (trimmed.startsWith('-')) return 'A resource cannot start with “-”.';
  if (/[\0\r\n]/.test(trimmed)) return 'A resource must be on one line.';
  const hash = trimmed.indexOf('#');
  const path = hash < 0 ? trimmed : trimmed.slice(0, hash);
  const name = hash < 0 ? '' : trimmed.slice(hash + 1);
  if (path === '') return 'Start with a file path, relative to the repository root.';
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return 'Use a path relative to the repository root, not an absolute path.';
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return 'A resource must stay inside the repository (“..” is not allowed).';
  if (parts.some((p) => p === '' || p === '.')) return 'Remove empty or “.” segments from the path.';
  if (name !== '' && !SYMBOL_NAME.test(name)) return 'Symbol names cannot contain spaces or another “#”.';
  return null;
}
