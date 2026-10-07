import { modelVars } from '../content/text';
import type { Translator } from '../i18n/translator';
import { SourceList } from './SourceList';

/** About the model: assumptions, simplifications, improvements, sources, credits, licences. */
export function AboutContent({ t, filterableSources }: { t: Translator; filterableSources: boolean }) {
  const vars = modelVars(t);
  return (
    <div lang={t.tag}>
      <h3>{t.t('about.modelTitle')}</h3>
      <p>{t.t('about.model', vars)}</p>
      <h3>{t.t('about.assumptionsTitle')}</h3>
      <ul>
        {t.list('about.assumptions').map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>{t.t('about.simplificationsTitle')}</h3>
      <ul>
        {t.list('about.simplifications').map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>{t.t('about.improvementsTitle')}</h3>
      <p>{t.t('about.improvements')}</p>
      <h3>{t.t('about.translationTitle')}</h3>
      <p>{t.t('about.translation', { status: t.t('meta.translationStatus') })}</p>
      <h3>{t.t('about.creditsTitle')}</h3>
      <p>{t.t('about.credits')}</p>
      <h3>{t.t('about.licensesTitle')}</h3>
      <p>{t.t('about.licenses')}</p>
      <h3>{t.t('about.sourcesTitle')}</h3>
      <p>{t.t('about.sources')}</p>
      <SourceList t={t} filterable={filterableSources} />
    </div>
  );
}
