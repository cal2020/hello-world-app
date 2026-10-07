import type { ReactNode } from 'react';
import { GROUPS } from '../content/registry';
import { structureName } from '../content/text';
import type { StructureId } from '../content/types';
import type { Translator } from '../i18n/translator';
import { CellIllustration } from './CellIllustration';
import { OverviewArticle } from './OverviewArticle';
import { StructureArticle } from './StructureArticle';

export interface TextAtlasProps {
  t: Translator;
  /** Shown above the contents (failure explanation, actions). */
  banner?: ReactNode;
  /** Link for "open in 3D" per structure (fallback mode may omit it). */
  onSelect?: (id: StructureId) => void;
  illustrationFor?: (id: StructureId) => string | undefined;
}

/**
 * The complete atlas as text: overview, grouped contents and every structure
 * with its explanation, numbers, parts, connections and sources. Used when
 * 3D is unavailable or when the reader chooses the text view.
 */
export function TextAtlas({ t, banner, illustrationFor }: TextAtlasProps) {
  const anchor = (id: StructureId) => `#atlas-${id}`;
  return (
    <div className="atlas-inner" lang={t.tag}>
      {banner}
      <header className="atlas-header" id="atlas-top">
        <CellIllustration className="entry-preview" title={t.t('loading.previewAlt')} />
        <h1>{t.t('atlas.title')}</h1>
        <p>{t.t('atlas.intro')}</p>
      </header>
      <nav className="atlas-toc glass" aria-label={t.t('atlas.contents')}>
        <h2 style={{ fontSize: 'var(--fs-xl)', marginBottom: 8 }}>{t.t('atlas.contents')}</h2>
        <ol>
          {GROUPS.map((group) => (
            <li key={group.id}>
              <div className="toc-group">{t.t(`groups.${group.id}`)}</div>
              <ol>
                {group.structures.map((id) => (
                  <li key={id}>
                    <a href={anchor(id)}>{structureName(t, id)}</a>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </nav>
      <section className="atlas-entry glass" aria-labelledby="overview-title">
        <OverviewArticle t={t} mode="static" hrefFor={anchor} />
      </section>
      {GROUPS.flatMap((group) => group.structures).map((id) => {
        const illustration = illustrationFor?.(id);
        return (
          <section key={id} id={`atlas-${id}`} className="atlas-entry glass" style={{ scrollMarginTop: 80 }}>
            <StructureArticle
              id={id}
              t={t}
              mode="static"
              idPrefix={`atlas-${id}-`}
              hrefFor={anchor}
              illustration={
                illustration ? { src: illustration, alt: t.t('atlas.illustration', { name: structureName(t, id) }) } : undefined
              }
            />
            <p style={{ padding: '0 26px 20px' }}>
              <a href="#atlas-top">{t.t('atlas.backToTop')}</a>
            </p>
          </section>
        );
      })}
    </div>
  );
}
