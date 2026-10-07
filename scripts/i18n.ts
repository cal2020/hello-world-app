/**
 * Translation helper.
 *
 *   npx tsx scripts/i18n.ts sections                     list translatable sections and their size
 *   npx tsx scripts/i18n.ts show <section>               print the English text of a section
 *   npx tsx scripts/i18n.ts put <lang> <section> <file>  merge a translated section (JSON file) into <lang>.json
 *   npx tsx scripts/i18n.ts check <lang> [prefix]        list completeness problems (all, or under a key prefix)
 *
 * A section is a top-level key ("help") or one structure ("structures.nucleus").
 * The locale file is always rewritten in the English key order, so diffs stay readable.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANG_INFO, isLang } from '../src/i18n/languages';
import { isPluralObject, validateLocale } from '../src/i18n/validate';
import type { MessageTree } from '../src/i18n/translator';

type Node = string | string[] | MessageTree;

const localeDir = fileURLToPath(new URL('../src/i18n/locales/', import.meta.url));
const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as MessageTree;
const english = readJson(`${localeDir}en.json`);

function getPath(tree: MessageTree, path: string): Node | undefined {
  let node: Node | undefined = tree;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(tree: MessageTree, path: string, value: Node): void {
  const parts = path.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[part] = {};
    node = node[part] as MessageTree;
  }
  node[parts[parts.length - 1]] = value;
}

/** Rebuild `value` in the key order of `template`; keys unknown to English are kept at the end. */
function ordered(template: Node | undefined, value: Node): Node {
  if (typeof value === 'string' || Array.isArray(value)) return value;
  if (isPluralObject(value)) {
    const out: MessageTree = {};
    for (const category of PLURAL_ORDER) if (category in value) out[category] = value[category];
    return out;
  }
  const out: MessageTree = {};
  const tpl = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  for (const key of Object.keys(tpl)) if (key in value) out[key] = ordered(tpl[key], value[key]);
  for (const key of Object.keys(value)) if (!(key in out)) out[key] = value[key];
  return out;
}

function sections(): string[] {
  const list: string[] = [];
  for (const [key, value] of Object.entries(english)) {
    if (key === 'structures' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const id of Object.keys(value)) list.push(`structures.${id}`);
    } else list.push(key);
  }
  return list;
}

function localeFile(lang: string): string {
  if (!isLang(lang) || lang === 'en') throw new Error(`Unknown or English language "${lang}"`);
  return `${localeDir}${lang}.json`;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'sections': {
    for (const section of sections()) {
      const size = JSON.stringify(getPath(english, section)).length;
      console.log(`${section.padEnd(40)} ${String(size).padStart(6)} chars`);
    }
    break;
  }
  case 'show': {
    const [section] = args;
    const node = getPath(english, section);
    if (node === undefined) throw new Error(`No section "${section}"`);
    console.log(JSON.stringify(node, null, 2));
    break;
  }
  case 'put': {
    const [lang, section, file] = args;
    const path = localeFile(lang);
    if (getPath(english, section) === undefined) throw new Error(`No section "${section}" in the English file`);
    const translated = readJson(file) as Node;
    const current = existsSync(path) ? readJson(path) : {};
    setPath(current, section, translated);
    const result = ordered(english, current) as MessageTree;
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    const issues = validateLocale(english, result, LANG_INFO[lang as keyof typeof LANG_INFO].tag, allowed(lang)).filter(
      (issue) => issue.key === section || issue.key.startsWith(`${section}.`) || issue.key.startsWith(`${section}[`),
    );
    console.log(issues.length ? issues.map((i) => `${i.kind} ${i.key}: ${i.detail}`).join('\n') : `${section}: OK`);
    break;
  }
  case 'check': {
    const [lang, prefix] = args;
    const path = localeFile(lang);
    if (!existsSync(path)) throw new Error(`${lang}.json does not exist yet`);
    const issues = validateLocale(english, readJson(path), LANG_INFO[lang as keyof typeof LANG_INFO].tag, allowed(lang)).filter(
      (issue) => !prefix || issue.key.startsWith(prefix),
    );
    const missingSections = new Set(issues.filter((i) => i.kind === 'missing').map((i) => i.key.split('.').slice(0, i.key.startsWith('structures.') ? 2 : 1).join('.')));
    for (const issue of issues.slice(0, 200)) console.log(`${issue.kind} ${issue.key}: ${issue.detail}`);
    if (issues.length > 200) console.log(`… and ${issues.length - 200} more`);
    console.log(`${issues.length} issue(s)${missingSections.size ? `; sections with missing keys: ${[...missingSections].join(', ')}` : ''}`);
    process.exitCode = issues.length ? 1 : 0;
    break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
}

/** Keys allowed to stay identical to English: tests/unit/identical-allowlist/<lang>.json (a JSON array of keys). */
function allowed(lang: string): Set<string> {
  const path = fileURLToPath(new URL(`../tests/unit/identical-allowlist/${lang}.json`, import.meta.url));
  return new Set(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : []);
}
