import { LANGS, LANG_INFO } from '../i18n/languages';
import type { Translator } from '../i18n/translator';
import { buildPath, type Route } from './routing';

export interface HeadInfo {
  title: string;
  description: string;
  /** Canonical path (the close-up view shares the structure's canonical URL). */
  canonicalPath: string;
  alternates: Array<{ hreflang: string; path: string }>;
  langTag: string;
}

export function headInfo(route: Route, t: Translator, base: string): HeadInfo {
  const app = t.t('app.title');
  const sep = t.t('app.titleSeparator');
  let title: string;
  let description: string;
  if (route.page === 'about') {
    title = `${t.t('about.title')}${sep}${app}`;
    description = t.t('app.aboutMetaDescription');
  } else if (route.structure) {
    const name = t.t(`structures.${route.structure}.name`);
    title = `${name}${sep}${app}`;
    description = t.t('app.structureMetaDescription', { name, short: t.t(`structures.${route.structure}.short`) });
  } else {
    title = `${app}${sep}${t.t('app.tagline')}`;
    description = t.t('app.metaDescription');
  }
  const canonicalRoute: Route = { ...route, view: 'cell' };
  const alternates = LANGS.map((lang) => ({
    hreflang: LANG_INFO[lang].tag,
    path: buildPath({ ...canonicalRoute, lang }, base),
  }));
  alternates.push({ hreflang: 'x-default', path: buildPath({ ...canonicalRoute, lang: 'en' }, base) });
  return {
    title,
    description,
    canonicalPath: buildPath(canonicalRoute, base),
    alternates,
    langTag: t.tag,
  };
}

/** Apply head information to the live document (client side). */
export function applyHead(info: HeadInfo, origin: string): void {
  document.title = info.title;
  document.documentElement.lang = info.langTag;
  const setMeta = (selector: string, attr: 'name' | 'property', key: string, value: string) => {
    let el = document.head.querySelector<HTMLMetaElement>(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.content = value;
  };
  setMeta('meta[name="description"]', 'name', 'description', info.description);
  setMeta('meta[property="og:title"]', 'property', 'og:title', info.title);
  setMeta('meta[property="og:description"]', 'property', 'og:description', info.description);

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = origin + info.canonicalPath;

  document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  for (const alt of info.alternates) {
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.hreflang = alt.hreflang;
    link.href = origin + alt.path;
    document.head.appendChild(link);
  }
}
