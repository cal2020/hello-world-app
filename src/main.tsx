import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.generated.css';
import './styles/app.css';
import { App } from './App';
import { appStore, reducedMotion } from './app/store';
import { configureHistory, ensureScriptFonts, pushToast } from './app/actions';
import { buildPath, parseLocation, type Route } from './app/routing';
import { loadLanguagePreference, loadSettings } from './app/settings';
import { computeLayout } from './app/hooks';
import { matchLanguage } from './i18n/languages';
import { englishMessages, loadMessages } from './i18n/load';
import { createTranslator } from './i18n/translator';

declare global {
  interface Window {
    __HCA_MOUNTED__?: boolean;
  }
}

async function boot() {
  const base = import.meta.env.BASE_URL;
  configureHistory(
    {
      push: (url, state) => window.history.pushState(state, '', url),
      replace: (url, state) => window.history.replaceState(state, '', url),
    },
    base,
  );

  const preferred = () => loadLanguagePreference() ?? matchLanguage(navigator.languages ?? [navigator.language]);
  const parsed = parseLocation(window.location.pathname, window.location.search, base);
  let route: Route;
  let notFound = false;
  const keepSearch = (path: string) => {
    // Preserve debug/test switches (not the view parameter, which buildPath owns).
    const params = new URLSearchParams(window.location.search);
    params.delete('view');
    params.delete('detail');
    const rest = params.toString();
    if (!rest) return path;
    return path.includes('?') ? `${path}&${rest}` : `${path}?${rest}`;
  };
  if (parsed.kind === 'route') {
    route = parsed.route;
    if (!parsed.canonical) window.history.replaceState(null, '', keepSearch(buildPath(route, base)));
  } else {
    const lang = parsed.kind === 'not-found' && parsed.lang ? parsed.lang : preferred();
    route = { lang, page: 'cell', structure: null, view: 'cell' };
    notFound = parsed.kind === 'not-found';
    window.history.replaceState(null, '', keepSearch(buildPath(route, base)));
  }

  let translator;
  let localeFailed = false;
  try {
    translator = createTranslator(route.lang, await loadMessages(route.lang), englishMessages);
  } catch {
    // Never present English as the requested language: the stand-in is labelled en and a banner explains it.
    translator = createTranslator(route.lang, englishMessages, englishMessages, { standIn: true });
    localeFailed = true;
  }
  ensureScriptFonts(route.lang);

  const settings = loadSettings();
  const systemReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const layout = computeLayout(window.innerWidth, window.innerHeight);
  appStore.setState({
    route,
    translator,
    locale: { status: localeFailed ? 'failed' : 'ready', failedLang: localeFailed ? route.lang : null },
    settings,
    systemReducedMotion,
    // With reduced motion, biological animation starts frozen (one click plays it).
    bioFrozen: reducedMotion({ settings, systemReducedMotion }),
    layout,
    sheet: route.structure && layout === 'compact' ? 'half' : 'collapsed',
    closeupViewIndex: route.view === 'closeup' ? (route.detail ?? 0) : 0,
  });

  const root = document.getElementById('root')!;
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  window.__HCA_MOUNTED__ = true;
  document.documentElement.classList.remove('js-pending');
  if (notFound) pushToast({ kind: 'info', message: translator.t('errors.notFound') });
}

void boot();
