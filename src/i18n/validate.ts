import type { MessageTree } from './translator';

/**
 * Locale completeness checks shared by the unit tests and the translation
 * tool (scripts/i18n.ts). A locale passes when it has exactly the English
 * keys, keeps every {placeholder}, provides every plural category its
 * language needs, and leaves no English sentence untranslated.
 */

export type IssueKind = 'missing' | 'extra' | 'type' | 'placeholder' | 'plural' | 'identical' | 'empty' | 'array-length';

export interface LocaleIssue {
  kind: IssueKind;
  key: string;
  detail: string;
}

type Node = string | string[] | MessageTree;

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** An object whose keys are all plural categories, including "other". */
export function isPluralObject(node: Node | undefined): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length > 0 && keys.includes('other') && keys.every((k) => PLURAL_CATEGORIES.has(k) && typeof node[k] === 'string');
}

export function placeholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1]))].sort();
}

/**
 * Whether an untranslated (identical to English) string is acceptable without
 * an explicit allowance: symbols, numbers, units and acronyms such as "ATP" or
 * "TTAGGG" read the same in every language.
 */
export function looksLanguageNeutral(text: string): boolean {
  const stripped = text.replace(/\{\w+\}/g, ' ');
  return !/[a-z]{4,}/.test(stripped);
}

export function requiredPluralCategories(tag: string): string[] {
  return new Intl.PluralRules(tag).resolvedOptions().pluralCategories as string[];
}

/** Keys whose arrays are language-specific lists (their length may differ). */
function isFreeLengthArray(key: string): boolean {
  return key.endsWith('.synonyms');
}

export function validateLocale(
  english: MessageTree,
  locale: MessageTree,
  tag: string,
  allowIdentical: ReadonlySet<string> = new Set(),
): LocaleIssue[] {
  const issues: LocaleIssue[] = [];
  const required = requiredPluralCategories(tag);

  const compareString = (key: string, en: string, value: string) => {
    if (!value.trim()) {
      issues.push({ kind: 'empty', key, detail: 'empty string' });
      return;
    }
    const want = placeholders(en).join(',');
    const got = placeholders(value).join(',');
    if (want !== got) issues.push({ kind: 'placeholder', key, detail: `expected {${want}} but found {${got}}` });
    if (value === en && !looksLanguageNeutral(en) && !allowIdentical.has(key)) {
      issues.push({ kind: 'identical', key, detail: `still English: "${en.slice(0, 80)}"` });
    }
  };

  const walk = (prefix: string, en: Node, value: Node | undefined) => {
    if (value === undefined) {
      issues.push({ kind: 'missing', key: prefix, detail: 'missing' });
      return;
    }
    if (typeof en === 'string') {
      if (typeof value !== 'string') issues.push({ kind: 'type', key: prefix, detail: 'expected a string' });
      else compareString(prefix, en, value);
      return;
    }
    if (Array.isArray(en)) {
      if (!Array.isArray(value)) {
        issues.push({ kind: 'type', key: prefix, detail: 'expected a list' });
        return;
      }
      if (isFreeLengthArray(prefix)) {
        if (value.length === 0) issues.push({ kind: 'empty', key: prefix, detail: 'empty list' });
        value.forEach((item, i) => {
          if (typeof item !== 'string' || !item.trim()) issues.push({ kind: 'empty', key: `${prefix}[${i}]`, detail: 'empty entry' });
        });
        return;
      }
      if (value.length !== en.length) {
        issues.push({ kind: 'array-length', key: prefix, detail: `expected ${en.length} entries, found ${value.length}` });
      }
      en.forEach((item, i) => {
        const other = value[i];
        if (typeof other === 'string') compareString(`${prefix}[${i}]`, item, other);
      });
      return;
    }
    if (isPluralObject(en)) {
      if (!isPluralObject(value) || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ kind: 'type', key: prefix, detail: 'expected a plural object' });
        return;
      }
      for (const category of required) {
        if (typeof value[category] !== 'string') {
          issues.push({ kind: 'plural', key: `${prefix}.${category}`, detail: `plural category "${category}" is required for ${tag}` });
        }
      }
      const want = placeholders((en as MessageTree).other as string).join(',');
      for (const [category, text] of Object.entries(value)) {
        if (!required.includes(category)) {
          issues.push({ kind: 'plural', key: `${prefix}.${category}`, detail: `"${category}" is not a plural category of ${tag}` });
          continue;
        }
        const got = placeholders(text as string).join(',');
        if (got !== want) issues.push({ kind: 'placeholder', key: `${prefix}.${category}`, detail: `expected {${want}} but found {${got}}` });
        if (!(text as string).trim()) issues.push({ kind: 'empty', key: `${prefix}.${category}`, detail: 'empty string' });
      }
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ kind: 'type', key: prefix, detail: 'expected an object' });
      return;
    }
    for (const [key, child] of Object.entries(en)) walk(prefix ? `${prefix}.${key}` : key, child, value[key]);
    for (const key of Object.keys(value)) {
      if (!(key in en)) issues.push({ kind: 'extra', key: prefix ? `${prefix}.${key}` : key, detail: 'not in the English file' });
    }
  };

  walk('', english, locale);
  return issues;
}
