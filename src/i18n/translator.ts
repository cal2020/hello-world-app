import type { Quantity } from '../content/types';
import { LANG_INFO, type Lang } from './languages';

/** A locale file: nested objects whose leaves are strings or string arrays. */
export type MessageTree = { [key: string]: string | string[] | MessageTree };

export type Vars = Record<string, string | number>;

/** Look up a dot-separated key ("ui.controls.labels") in a message tree. */
export function lookup(tree: MessageTree | undefined, key: string): string | string[] | MessageTree | undefined {
  let node: string | string[] | MessageTree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string' || Array.isArray(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Replace {name} placeholders. Unknown placeholders are left untouched (tests catch them). */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export interface Translator {
  lang: Lang;
  /** BCP 47 tag used for <html lang> and Intl. */
  tag: string;
  /** Translate a key; falls back to English (and records the fallback) when missing. */
  t(key: string, vars?: Vars): string;
  /** String-array entries such as search synonyms. */
  list(key: string): string[];
  /** Plural-aware lookup: picks key.<category> by Intl.PluralRules, falling back to key.other. */
  plural(key: string, count: number, vars?: Vars): string;
  /** True if the key resolved from the English fallback rather than this locale. */
  isFallback(key: string): boolean;
  has(key: string): boolean;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatQuantity(q: Quantity): string;
  /** Whether this translator is the English fallback standing in for a failed locale. */
  standIn: boolean;
}

function fractionDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 100 || Number.isInteger(value)) return 0;
  if (abs >= 10) return 1;
  if (abs >= 1) return 2;
  return 3;
}

export function createTranslator(
  lang: Lang,
  messages: MessageTree,
  fallback: MessageTree,
  options: { standIn?: boolean } = {},
): Translator {
  const tag = options.standIn ? LANG_INFO.en.tag : LANG_INFO[lang].tag;
  const pluralRules = new Intl.PluralRules(tag);
  const numberFormats = new Map<string, Intl.NumberFormat>();

  const getFormat = (opts: Intl.NumberFormatOptions) => {
    const cacheKey = JSON.stringify(opts);
    let nf = numberFormats.get(cacheKey);
    if (!nf) {
      nf = new Intl.NumberFormat(tag, opts);
      numberFormats.set(cacheKey, nf);
    }
    return nf;
  };

  const resolve = (key: string): { value: string | string[] | MessageTree | undefined; fromFallback: boolean } => {
    const own = lookup(messages, key);
    if (own !== undefined) return { value: own, fromFallback: false };
    return { value: lookup(fallback, key), fromFallback: true };
  };

  const t = (key: string, vars?: Vars): string => {
    const { value } = resolve(key);
    if (typeof value === 'string') return interpolate(value, vars);
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key "${key}" for ${lang}`);
    return key;
  };

  const numberOptions = (value: number): Intl.NumberFormatOptions => {
    if (Math.abs(value) >= 1_000_000) {
      return { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 };
    }
    const digits = fractionDigits(value);
    return { maximumFractionDigits: digits, minimumFractionDigits: 0 };
  };

  const formatNumber = (value: number, opts?: Intl.NumberFormatOptions) => getFormat(opts ?? numberOptions(value)).format(value);

  const formatRange = (min: number, max: number) => {
    const opts = numberOptions(Math.max(Math.abs(min), Math.abs(max)));
    const digits = Math.max(fractionDigits(min), fractionDigits(max));
    const merged: Intl.NumberFormatOptions = opts.notation ? opts : { maximumFractionDigits: digits, minimumFractionDigits: 0 };
    const nf = getFormat(merged);
    if (typeof nf.formatRange === 'function') return nf.formatRange(min, max);
    return `${nf.format(min)}–${nf.format(max)}`;
  };

  return {
    lang,
    tag,
    standIn: !!options.standIn,
    t,
    list(key) {
      const { value } = resolve(key);
      return Array.isArray(value) ? value : [];
    },
    plural(key, count, vars) {
      const category = pluralRules.select(count);
      const specific = resolve(`${key}.${category}`).value;
      const template = typeof specific === 'string' ? specific : t(`${key}.other`);
      return interpolate(template, { count: formatNumber(count), ...vars });
    },
    isFallback(key) {
      return resolve(key).fromFallback;
    },
    has(key) {
      return typeof resolve(key).value === 'string';
    },
    formatNumber,
    formatQuantity(q) {
      let number: string;
      if (q.value !== undefined) number = formatNumber(q.value);
      else if (q.min !== undefined && q.max !== undefined) number = q.min === q.max ? formatNumber(q.min) : formatRange(q.min, q.max);
      else number = '';
      let text: string;
      const unit = q.unit === 'none' ? undefined : resolve(`units.${q.unit}`).value;
      if (unit === undefined) text = number;
      else if (typeof unit === 'object' && !Array.isArray(unit)) {
        // Plural-aware unit (e.g. French "1 milliard de molécules" but "10 000 molécules").
        const ranged = q.min !== undefined && q.max !== undefined && q.min !== q.max;
        const rules = pluralRules as Intl.PluralRules & { selectRange?: (a: number, b: number) => Intl.LDMLPluralRule };
        const category = ranged && rules.selectRange ? rules.selectRange(q.min!, q.max!) : pluralRules.select(q.value ?? q.max ?? q.min ?? 0);
        const template = typeof unit[category] === 'string' ? unit[category] : unit.other;
        text = typeof template === 'string' ? interpolate(template, { n: number }) : number;
      } else text = t(`units.${q.unit}`, { n: number });
      if (q.approx) text = t('quantity.approx', { q: text });
      if (q.qualifier) text = t(`quantity.${q.qualifier}`, { q: text });
      return text;
    },
  };
}
