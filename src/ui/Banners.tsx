import { useApp, useT } from '../app/store';
import { changeLanguage, restart3d, showTextAtlas } from '../app/actions';
import { LANG_INFO } from '../i18n/languages';
import { Icon } from './icons';

/** Explanation and actions shown above the text atlas. */
export function AtlasBanner() {
  const t = useT();
  const failure = useApp((s) => s.failure);
  if (!failure) {
    return (
      <div className="failure-banner" style={{ borderColor: 'var(--accent-border)', background: 'rgba(20, 30, 60, 0.5)' }}>
        <p style={{ margin: 0 }}>{t.t('atlas.intro')}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => showTextAtlas(false)} data-testid="back-to-3d">
            <Icon name="cube" />
            {t.t('controls.view3d')}
          </button>
        </div>
      </div>
    );
  }
  const keys: Record<string, [string, string]> = {
    'webgl-unavailable': ['errors.webgl', 'errors.webglHelp'],
    'engine-load': ['errors.engineLoad', 'errors.engineLoadHelp'],
    'context-lost': ['errors.contextLost', 'errors.contextLostHelp'],
    runtime: ['errors.runtime', 'errors.runtimeHelp'],
    simulated: ['errors.simulated', 'errors.simulatedHelp'],
  };
  const [title, help] = keys[failure.kind] ?? keys.runtime;
  const canRetry = failure.kind !== 'simulated';
  return (
    <div className="failure-banner" role="alert" data-testid="failure-banner" data-kind={failure.kind}>
      <h2>{t.t('errors.title')}</h2>
      <p>
        <strong>{t.t(title)}</strong> {t.t(help)}
      </p>
      {failure.detail && (
        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }} lang="en">
          {failure.detail}
        </p>
      )}
      {canRetry && (
        <div className="actions">
          <button type="button" className="btn" onClick={restart3d} data-testid="restart-3d">
            <Icon name="reset" />
            {failure.kind === 'webgl-unavailable' || failure.kind === 'engine-load' ? t.t('errors.retry') : t.t('errors.restart3d')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Shown when the requested language could not be loaded and English stands in. */
export function LocaleBanner() {
  const t = useT();
  const standIn = useApp((s) => s.translator.standIn);
  const lang = useApp((s) => s.route.lang);
  const loading = useApp((s) => s.locale.status === 'loading');
  if (!standIn) return null;
  return (
    <div className="locale-banner glass" role="alert" lang="en" data-testid="locale-banner">
      <span>{t.t('errors.localeStandIn', { language: LANG_INFO[lang].nativeName })}</span>
      <button type="button" className="btn" disabled={loading} onClick={() => void changeLanguage(lang, 'none')}>
        {t.t('errors.retry')}
      </button>
    </div>
  );
}
