import { GROUPS } from '../content/registry';
import { structureName } from '../content/text';
import type { StructureId } from '../content/types';
import { LANGS, LANG_INFO } from '../i18n/languages';
import type { Translator } from '../i18n/translator';
import { buildPath, type Route } from '../app/routing';
import { neighbor } from '../app/actions';
import { AboutContent } from './AboutContent';
import { CellIllustration } from './CellIllustration';
import { OverviewArticle } from './OverviewArticle';
import { StructureArticle } from './StructureArticle';

export interface StaticPageProps {
  route: Route;
  t: Translator;
  base: string;
  /** Languages with a complete locale file (links to others are omitted). */
  languages: readonly (typeof LANGS)[number][];
  notFound?: boolean;
}

/**
 * The prerendered, JavaScript-free version of a page: real text and links
 * for readers without JavaScript, search engines and link previews. When
 * the interactive atlas starts, it replaces this content.
 */
export function StaticPage({ route, t, base, languages, notFound }: StaticPageProps) {
  const href = (r: Partial<Route>) => buildPath({ lang: route.lang, page: 'cell', structure: null, view: 'cell', ...r }, base);
  const structureHref = (id: StructureId) => href({ structure: id });
  const home = href({});
  return (
    <div className="static-page atlas-inner" lang={t.tag}>
      <header className="atlas-header" id="atlas-top">
        <p className="static-brand">
          <a href={home}>{t.t('app.title')}</a> · <span>{t.t('app.tagline')}</span>
        </p>
        <p className="static-note">{t.t('atlas.noJs')}</p>
        <nav aria-label={t.t('controls.language')} className="static-languages">
          <ul>
            {languages.map((lang) => (
              <li key={lang}>
                <a
                  href={buildPath({ ...route, lang, view: 'cell' }, base)}
                  hrefLang={LANG_INFO[lang].tag}
                  lang={LANG_INFO[lang].tag}
                  aria-current={lang === route.lang ? 'page' : undefined}
                >
                  {LANG_INFO[lang].nativeName}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="atlas-entry glass">
        {notFound && <p className="static-note">{t.t('errors.notFound')}</p>}
        {route.page === 'about' ? (
          <article className="article">
            <h1 className="article-title">{t.t('about.title')}</h1>
            <AboutContent t={t} filterableSources={false} />
          </article>
        ) : route.structure ? (
          <>
            <StructureArticle id={route.structure} t={t} mode="static" headingLevel="h1" hrefFor={structureHref} />
            <nav className="static-prev-next" aria-label={t.t('nav.breadcrumb')}>
              <a href={structureHref(neighbor(route.structure, -1))} rel="prev">
                ← {t.t('nav.previousNamed', { name: structureName(t, neighbor(route.structure, -1)) })}
              </a>
              <a href={home}>{t.t('nav.wholeCell')}</a>
              <a href={structureHref(neighbor(route.structure, 1))} rel="next">
                {t.t('nav.nextNamed', { name: structureName(t, neighbor(route.structure, 1)) })} →
              </a>
            </nav>
          </>
        ) : (
          <>
            <CellIllustration className="entry-preview" title={t.t('loading.previewAlt')} />
            <OverviewArticle t={t} mode="static" headingLevel="h1" hrefFor={structureHref} withDescriptions />
          </>
        )}
      </main>
      <nav className="atlas-toc glass" aria-label={t.t('atlas.contents')}>
        <h2>{t.t('atlas.contents')}</h2>
        <ol>
          {GROUPS.map((group) => (
            <li key={group.id}>
              <div className="toc-group">{t.t(`groups.${group.id}`)}</div>
              <ol>
                {group.structures.map((id) => (
                  <li key={id}>
                    <a href={structureHref(id)} aria-current={route.structure === id ? 'page' : undefined}>
                      {structureName(t, id)}
                    </a>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
        <p>
          <a href={href({ page: 'about' })}>{t.t('help.aboutLink')}</a>
        </p>
      </nav>
    </div>
  );
}
