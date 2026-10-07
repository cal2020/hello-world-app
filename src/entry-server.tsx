import { renderToString } from 'react-dom/server';
import { headInfo, type HeadInfo } from './app/head';
import { STRUCTURE_META } from './content/structures';
import { LANGS, type Lang } from './i18n/languages';
import { createTranslator, type MessageTree } from './i18n/translator';
import type { Route } from './app/routing';
import { StaticPage } from './ui/StaticPage';

/**
 * Server-side entry used only by the prerender step (scripts/prerender.ts):
 * renders the JavaScript-free page for every route and language.
 */

const files = import.meta.glob<{ default: MessageTree }>('./i18n/locales/*.json', { eager: true });
const messages = new Map<Lang, MessageTree>();
for (const [path, module] of Object.entries(files)) {
  const lang = path.match(/\/(\w+)\.json$/)?.[1] as Lang | undefined;
  if (lang && (LANGS as readonly string[]).includes(lang)) messages.set(lang, module.default);
}
const english = messages.get('en')!;

/** Languages that have a locale file (all seven in a complete build). */
export const languages: Lang[] = LANGS.filter((lang) => messages.has(lang));

export function routesFor(lang: Lang): Route[] {
  return [
    { lang, page: 'cell', structure: null, view: 'cell' },
    ...STRUCTURE_META.map((s): Route => ({ lang, page: 'cell', structure: s.id, view: 'cell' })),
    { lang, page: 'about', structure: null, view: 'cell' },
  ];
}

export interface RenderedPage {
  html: string;
  head: HeadInfo;
}

export function renderPage(route: Route, base: string, options: { notFound?: boolean } = {}): RenderedPage {
  const own = messages.get(route.lang);
  if (!own) throw new Error(`No locale file for ${route.lang}`);
  const t = createTranslator(route.lang, own, english);
  const head = headInfo(route, t, base);
  const html = renderToString(<StaticPage route={route} t={t} base={base} languages={languages} notFound={options.notFound} />);
  return { html, head };
}
