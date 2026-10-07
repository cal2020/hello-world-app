import { describe, expect, it } from 'vitest';
import { describeResource, heldWith, overlaps, parseResource, resourceText, validateResourceInput } from './resource';

describe('resource text form (mirrors Zit src/resource.rs)', () => {
  it('round-trips files, symbols and module-level code', () => {
    for (const s of ['src/a.rs', 'src/a.rs#Foo', 'src/a.rs#', 'C%23/a.cs', 'C%23/a.cs#Foo', '100%25%23.md']) {
      expect(resourceText(parseResource(s))).toBe(s);
    }
    expect(parseResource('a.rs#')).toEqual({ kind: 'top', path: 'a.rs' });
    expect(parseResource('C%23/a.cs')).toEqual({ kind: 'file', path: 'C#/a.cs' });
  });

  it('distinct symbols in one file do not overlap; a whole file overlaps everything in it', () => {
    const foo = parseResource('a.rs#foo');
    expect(overlaps(foo, parseResource('a.rs#bar'))).toBe(false);
    expect(overlaps(foo, parseResource('a.rs#'))).toBe(false);
    expect(overlaps(parseResource('a.rs'), foo)).toBe(true);
    expect(overlaps(parseResource('a.rs#'), parseResource('a.rs'))).toBe(true);
    expect(overlaps(parseResource('a.rs'), parseResource('b.rs'))).toBe(false);
  });

  it('a type holds its methods for claims, not the other way round for writes', () => {
    expect(heldWith(parseResource('a.rs#Cart'), parseResource('a.rs#Cart::total'))).toBe(true);
    expect(heldWith(parseResource('a.rs#Cart::total'), parseResource('a.rs#Cart'))).toBe(true);
    expect(heldWith(parseResource('a.rs#Cart'), parseResource('a.rs#Carton::x'))).toBe(false);
    expect(overlaps(parseResource('a.rs#Cart'), parseResource('a.rs#Cart::total'))).toBe(false);
  });

  it('describes resources for people', () => {
    expect(describeResource('src/a.ts#price')).toBe('src/a.ts › price');
    expect(describeResource('src/a.ts#')).toBe('src/a.ts (module code)');
  });
});

describe('validateResourceInput', () => {
  it('accepts relative files and symbols', () => {
    for (const ok of ['src/lib.rs', 'src/lib.rs#price', 'src/lib.rs#', 'README.md', 'a/b/Cart.ts#Cart::total']) {
      expect(validateResourceInput(ok)).toBeNull();
    }
  });
  it('rejects paths that escape or look like flags, with a fix-it message', () => {
    expect(validateResourceInput('')).toMatch(/Enter a path/);
    expect(validateResourceInput('/etc/passwd')).toMatch(/relative/);
    expect(validateResourceInput('../secret')).toMatch(/inside the repository/);
    expect(validateResourceInput('src/../../x')).toMatch(/inside the repository/);
    expect(validateResourceInput('--force')).toMatch(/cannot start/);
    expect(validateResourceInput('a//b')).toMatch(/empty/);
    expect(validateResourceInput('a.rs#two words')).toMatch(/spaces/);
    expect(validateResourceInput('a\nb')).toMatch(/one line/);
    expect(validateResourceInput('C:\\x')).toMatch(/relative/);
  });
});
