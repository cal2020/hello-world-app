import { useEffect, useState } from 'react';
import { useApp, useT } from '../app/store';
import { showTextAtlas } from '../app/actions';
import { getEngineController } from '../app/engineBridge';
import { structureName } from '../content/text';
import { CellIllustration } from './CellIllustration';

/**
 * Loading progress, a scene preview and the "Enter the cell" action. Deep
 * links (a structure or the About page in the URL) enter automatically once
 * the scene is ready so the requested content appears without an extra click.
 */
export function EntryOverlay() {
  const t = useT();
  const phase = useApp((s) => s.phase);
  const progress = useApp((s) => s.progress);
  const route = useApp((s) => s.route);
  const textAtlas = useApp((s) => s.textAtlas);
  const [deepLink] = useState(() => !!route.structure || route.page === 'about');
  const leaving = phase === 'entering';

  useEffect(() => {
    if (phase === 'ready' && deepLink) getEngineController()?.enter();
  }, [phase, deepLink]);

  if (textAtlas || phase === 'failed' || phase === 'exploring') return null;

  const percent = Math.round((progress.done / Math.max(1, progress.total)) * 100);
  const stepLabel = t.t(`loading.steps.${progress.step}`, {
    name: progress.structure ? structureName(t, progress.structure) : '',
  });
  const ready = phase === 'ready';

  return (
    <div className={`entry-overlay${leaving ? ' is-leaving' : ''}`} data-testid="entry-overlay" data-phase={phase}>
      <div className="entry-card">
        <CellIllustration className={`entry-preview${ready ? ' is-live' : ''}`} title={t.t('loading.previewAlt')} />
        <h1>{t.t('app.title')}</h1>
        <p className="tagline">{t.t('app.tagline')}</p>
        {!ready && (
          <div className="progress" aria-live="polite">
            <div
              className="progress-track"
              role="progressbar"
              aria-label={t.t('loading.title')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="progress-label">
              <span>{stepLabel}</span>
              <span>{t.t('loading.progress', { percent })}</span>
            </div>
          </div>
        )}
        {ready && !deepLink && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              autoFocus
              onClick={() => getEngineController()?.enter()}
              data-testid="enter-cell"
            >
              {t.t('loading.enter')}
            </button>
            <p className="entry-hint">{t.t('loading.enterHint')}</p>
          </>
        )}
        {deepLink && route.structure && <p className="entry-hint">{t.t('loading.opening', { name: structureName(t, route.structure) })}</p>}
        <button type="button" className="entry-link" onClick={() => showTextAtlas(true)}>
          {t.t('loading.readText')}
        </button>
      </div>
    </div>
  );
}
