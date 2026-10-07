import { GROUPS, structure } from '../content/registry';
import { modelVars, structureName } from '../content/text';
import type { StructureId } from '../content/types';
import type { Translator } from '../i18n/translator';

export interface OverviewArticleProps {
  t: Translator;
  mode: 'interactive' | 'static';
  headingLevel?: 'h1' | 'h2';
  onSelect?: (id: StructureId) => void;
  onStartTour?: () => void;
  hrefFor?: (id: StructureId) => string;
  /** Static pages list each structure's short description too. */
  withDescriptions?: boolean;
}

export function OverviewArticle({ t, mode, headingLevel, onSelect, onStartTour, hrefFor, withDescriptions }: OverviewArticleProps) {
  const Heading = headingLevel ?? 'h2';
  const vars = modelVars(t);
  return (
    <article className="article" aria-labelledby="overview-title" lang={t.tag}>
      <Heading className="article-title" id="overview-title">
        {t.t('overview.title')}
      </Heading>
      <p className="lead">{t.t('overview.lead', vars)}</p>
      <p>{t.t('overview.model')}</p>
      <p>{t.t('overview.how')}</p>
      {mode === 'interactive' && onStartTour && (
        <p>
          <button type="button" className="btn" onClick={onStartTour}>
            {t.t('overview.startTour')}
          </button>
        </p>
      )}
      <p>{t.t('overview.colors')}</p>
      <p>{t.t('overview.units')}</p>
      <h3>{t.t('overview.groupsTitle')}</h3>
      <ul className="overview-groups">
        {GROUPS.map((group) => (
          <li key={group.id}>
            <h4>{t.t(`groups.${group.id}`)}</h4>
            {withDescriptions ? (
              <ul className="simplifications">
                {group.structures.map((id) => (
                  <li key={id}>
                    <a href={hrefFor?.(id) ?? '#'}>{structureName(t, id)}</a> — {t.t(`structures.${id}.short`)}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="chip-list">
                {group.structures.map((id) => {
                  const color = structure(id).color;
                  const content = (
                    <>
                      <span className="dot" style={{ background: color }} aria-hidden="true" />
                      {structureName(t, id)}
                    </>
                  );
                  return (
                    <li key={id}>
                      {mode === 'interactive' ? (
                        <button type="button" className="btn" onClick={() => onSelect?.(id)}>
                          {content}
                        </button>
                      ) : (
                        <a className="btn" href={hrefFor?.(id) ?? '#'}>
                          {content}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}
