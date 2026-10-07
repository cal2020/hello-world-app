import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, LANG_INFO } from '../../src/i18n/languages';
import { placeholders, requiredPluralCategories, validateLocale } from '../../src/i18n/validate';
import type { MessageTree } from '../../src/i18n/translator';

const localeDir = fileURLToPath(new URL('../../src/i18n/locales/', import.meta.url));
const read = (lang: string) => JSON.parse(readFileSync(`${localeDir}${lang}.json`, 'utf8')) as MessageTree;
/** Keys whose translation may legitimately equal the English text (checked international terms). */
const allowIdentical = (lang: string) => {
  const path = fileURLToPath(new URL(`./identical-allowlist/${lang}.json`, import.meta.url));
  return new Set(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : []);
};
const english = read('en');

describe('locale completeness', () => {
  it('ships a locale file for every supported language', () => {
    for (const lang of LANGS) expect(existsSync(`${localeDir}${lang}.json`), `${lang}.json`).toBe(true);
  });

  for (const lang of LANGS.filter((l) => l !== 'en')) {
    it(`${lang}: same keys, placeholders and plural forms as English, nothing left in English`, () => {
      if (!existsSync(`${localeDir}${lang}.json`)) return; // reported by the test above
      const issues = validateLocale(english, read(lang), LANG_INFO[lang].tag, allowIdentical(lang));
      expect(issues.map((i) => `${i.kind} ${i.key}: ${i.detail}`)).toEqual([]);
    });
  }
});

describe('locale validator', () => {
  const en: MessageTree = {
    a: 'Hello {name}',
    list: ['one item'],
    count: { one: '{count} cell', other: '{count} cells' },
    s: { synonyms: ['x', 'y'] },
    sym: '{n} nm',
  };

  it('accepts a complete translation', () => {
    const ok: MessageTree = {
      a: 'Bonjour {name}',
      list: ['un élément'],
      count: { one: '{count} cellule', many: '{count} de cellules', other: '{count} cellules' },
      s: { synonyms: ['z'] },
      sym: '{n} nm',
    };
    expect(validateLocale(en, ok, 'fr')).toEqual([]);
  });

  it('reports missing keys, lost placeholders, missing plural categories and English leftovers', () => {
    const bad: MessageTree = { a: 'Hello {name}', list: ['x', 'y'], count: { other: '{count} клеток' }, s: { synonyms: [] }, extra: 'z' };
    const kinds = validateLocale(en, bad, 'ru').map((i) => `${i.kind}:${i.key}`);
    expect(kinds).toContain('identical:a');
    expect(kinds).toContain('array-length:list');
    expect(kinds).toContain('plural:count.one');
    expect(kinds).toContain('plural:count.few');
    expect(kinds).toContain('plural:count.many');
    expect(kinds).toContain('empty:s.synonyms');
    expect(kinds).toContain('missing:sym');
    expect(kinds).toContain('extra:extra');
  });

  it('lets units be plural objects where the grammar needs it', () => {
    const units: MessageTree = { units: { molecules: '{n} molecules' } };
    const fr: MessageTree = { units: { molecules: { one: '{n} molécule', many: '{n} de molécules', other: '{n} molécules' } } };
    expect(validateLocale(units, fr, 'fr')).toEqual([]);
    const missing: MessageTree = { units: { molecules: { one: '{n} molécule', other: '{n} molécules' } } };
    expect(validateLocale(units, missing, 'fr').map((i) => i.key)).toEqual(['units.molecules.many']);
  });

  it('extracts placeholders', () => {
    expect(placeholders('{b} and {a} and {b}')).toEqual(['a', 'b']);
  });

  it('knows the plural categories of each supported language', () => {
    expect(requiredPluralCategories('ru')).toEqual(expect.arrayContaining(['one', 'few', 'many', 'other']));
    expect(requiredPluralCategories('zh-Hans')).toEqual(['other']);
    expect(requiredPluralCategories('sr-Latn')).toEqual(expect.arrayContaining(['one', 'few', 'other']));
  });
});

describe('plural-aware units', () => {
  it('picks the grammatical form for large compact numbers', async () => {
    const { createTranslator } = await import('../../src/i18n/translator');
    const messages: MessageTree = {
      units: { molecules: { one: '{n} molécule', many: '{n} de molécules', other: '{n} molécules' } },
    };
    const t = createTranslator('fr', messages, english);
    expect(t.formatQuantity({ value: 1e9, unit: 'molecules' })).toBe('1 milliard de molécules');
    expect(t.formatQuantity({ value: 10000, unit: 'molecules' })).toMatch(/^10\s000 molécules$/);
    expect(t.formatQuantity({ value: 1, unit: 'molecules' })).toBe('1 molécule');
  });
});
