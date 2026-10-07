/** Supported interface/content languages. The URL uses the short code. */
export const LANGS = ['en', 'sr', 'fr', 'it', 'es', 'ru', 'zh'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

export interface LangInfo {
  /** BCP 47 tag for <html lang>, hreflang and Intl formatting. */
  tag: string;
  /** Name of the language in that language. */
  nativeName: string;
}

export const LANG_INFO: Record<Lang, LangInfo> = {
  en: { tag: 'en', nativeName: 'English' },
  sr: { tag: 'sr-Latn', nativeName: 'Srpski (latinica)' },
  fr: { tag: 'fr', nativeName: 'Français' },
  it: { tag: 'it', nativeName: 'Italiano' },
  es: { tag: 'es', nativeName: 'Español' },
  ru: { tag: 'ru', nativeName: 'Русский' },
  zh: { tag: 'zh-Hans', nativeName: '简体中文' },
};

export function isLang(value: string | null | undefined): value is Lang {
  return !!value && (LANGS as readonly string[]).includes(value);
}

/** Best supported language for a list of BCP 47 preferences (e.g. navigator.languages). */
export function matchLanguage(preferences: readonly string[]): Lang {
  for (const pref of preferences) {
    const lower = pref.toLowerCase();
    if (lower.startsWith('sr')) {
      // Serbian Cyrillic is not offered; Serbian Latin is the closest match.
      return 'sr';
    }
    if (lower.startsWith('zh')) {
      // Simplified Chinese is offered; Traditional-script preferences still read it more easily than English.
      return 'zh';
    }
    const base = lower.split('-')[0];
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}
