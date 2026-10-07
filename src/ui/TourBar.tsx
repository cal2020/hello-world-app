import { useApp, useT } from '../app/store';
import { TOUR_STEPS, dispatchTour } from '../app/actions';
import { readingProgress } from '../app/tour';
import { structureName } from '../content/text';
import { Icon } from './icons';

export function TourBar() {
  const t = useT();
  const tour = useApp((s) => s.tour);
  if (tour.status === 'idle') return null;
  const id = TOUR_STEPS[tour.index];
  const seconds = Math.ceil(tour.remainingMs / 1000);
  const status =
    tour.status === 'paused'
      ? t.t('tour.paused')
      : tour.phase === 'traveling'
        ? t.t('tour.traveling')
        : t.t('tour.reading', { seconds: t.formatNumber(seconds) });
  const progress = tour.phase === 'reading' ? readingProgress(tour) : 0;
  return (
    <section className="tour-bar glass" aria-label={t.t('tour.title')} data-testid="tour-bar">
      <div className="tour-info">
        <span className="tour-step" data-testid="tour-step">
          {t.t('tour.progress', { current: t.formatNumber(tour.index + 1), total: t.formatNumber(TOUR_STEPS.length) })} ·{' '}
          {structureName(t, id)}
        </span>
        <span className="tour-status" data-testid="tour-status">
          {status}
        </span>
        <div
          className="tour-progress"
          role="progressbar"
          aria-label={t.t('tour.title')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div style={{ width: `${progress * 100}%`, transition: 'width 200ms linear' }} />
        </div>
      </div>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={t.t('tour.previous')}
        title={t.t('tour.noWrap')}
        disabled={tour.index === 0}
        onClick={() => dispatchTour({ type: 'prev' })}
        data-testid="tour-prev"
      >
        <Icon name="prev" />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={tour.status === 'running' ? t.t('tour.pause') : t.t('tour.resume')}
        onClick={() => dispatchTour({ type: tour.status === 'running' ? 'pause' : 'resume' })}
        data-testid="tour-pause"
      >
        <Icon name={tour.status === 'running' ? 'pause' : 'play'} />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={t.t('tour.next')}
        title={t.t('tour.noWrap')}
        onClick={() => dispatchTour({ type: 'next' })}
        data-testid="tour-next"
      >
        <Icon name="next" />
      </button>
      <button type="button" className="btn btn-icon" aria-label={t.t('tour.exit')} onClick={() => dispatchTour({ type: 'exit' })} data-testid="tour-exit">
        <Icon name="stop" />
      </button>
    </section>
  );
}
