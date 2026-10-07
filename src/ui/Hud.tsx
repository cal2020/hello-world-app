import { useEffect, useRef } from 'react';
import { useApp, useT } from '../app/store';
import { dispatchTour, openAbout, openModal, showTextAtlas, toggleBioFrozen, toggleLabels, updateSettings } from '../app/actions';
import { getEngineController, overlays } from '../app/engineBridge';
import type { QualitySetting } from '../app/quality';
import type { MotionSetting } from '../app/settings';
import { Icon } from './icons';

export function TourButton() {
  const t = useT();
  const status = useApp((s) => s.tour.status);
  const label = status === 'running' ? t.t('tour.pause') : status === 'paused' ? t.t('tour.resume') : t.t('controls.startTour');
  return (
    <button
      type="button"
      className="btn"
      aria-label={label}
      aria-pressed={status === 'running'}
      onClick={() => dispatchTour({ type: 'toggle' })}
      data-testid="tour-toggle"
    >
      <Icon name={status === 'running' ? 'pause' : status === 'paused' ? 'play' : 'tour'} />
      <span className="btn-label-wide">{t.t('controls.tour')}</span>
    </button>
  );
}

export function LabelsButton() {
  const t = useT();
  const labels = useApp((s) => s.settings.labels);
  return (
    <button
      type="button"
      className="btn"
      aria-pressed={labels}
      aria-label={t.t('controls.labels')}
      title={t.t('controls.labelsHint')}
      onClick={toggleLabels}
      data-testid="labels-toggle"
    >
      <Icon name="labels" />
      <span className="btn-label-wide">{t.t('controls.labels')}</span>
    </button>
  );
}

export function FreezeButton() {
  const t = useT();
  const frozen = useApp((s) => s.bioFrozen);
  return (
    <button
      type="button"
      className="btn"
      aria-pressed={frozen}
      aria-label={t.t('controls.freezeLabel')}
      title={frozen ? t.t('controls.playHint') : t.t('controls.freezeHint')}
      onClick={toggleBioFrozen}
      data-testid="freeze-toggle"
    >
      <Icon name="snow" />
      <span className="btn-label-wide">
        {t.t('controls.freeze')}
        <span className="visually-hidden"> — {t.t('controls.bio')}</span>
      </span>
    </button>
  );
}

export function QualitySelect({ id, labelled }: { id?: string; labelled?: boolean }) {
  const t = useT();
  const quality = useApp((s) => s.settings.quality);
  const effective = useApp((s) => s.effectiveQuality);
  const levelName = (level: string) => t.t(`controls.quality${level[0].toUpperCase()}${level.slice(1)}`);
  return (
    <label title={t.t('controls.qualityHint')} className={labelled ? 'labeled-select' : undefined}>
      <span className={labelled ? 'select-label' : 'visually-hidden'}>{t.t('controls.quality')}</span>
      <select
        id={id}
        className="select"
        value={quality}
        onChange={(event) => updateSettings({ quality: event.target.value as QualitySetting })}
        data-testid="quality-select"
      >
        <option value="auto">{t.t('controls.qualityAutoCurrent', { level: levelName(effective) })}</option>
        <option value="low">{levelName('low')}</option>
        <option value="medium">{levelName('medium')}</option>
        <option value="high">{levelName('high')}</option>
      </select>
    </label>
  );
}

export function MotionSelect({ id, labelled }: { id?: string; labelled?: boolean }) {
  const t = useT();
  const motion = useApp((s) => s.settings.motion);
  return (
    <label title={t.t('controls.motionHint')} className={labelled ? 'labeled-select' : undefined}>
      <span className={labelled ? 'select-label' : 'visually-hidden'}>{t.t('controls.motion')}</span>
      <select
        id={id}
        className="select"
        value={motion}
        onChange={(event) => updateSettings({ motion: event.target.value as MotionSetting })}
        data-testid="motion-select"
      >
        <option value="system">{t.t('controls.motionSystem')}</option>
        <option value="reduce">{t.t('controls.motionReduce')}</option>
        <option value="allow">{t.t('controls.motionAllow')}</option>
      </select>
    </label>
  );
}

function ScaleIndicator() {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const length = useRef<HTMLSpanElement>(null);
  const context = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    overlays.scaleRoot = root.current;
    overlays.scaleBar = bar.current;
    overlays.scaleLength = length.current;
    overlays.scaleContext = context.current;
    overlays.scaleNote = note.current;
    return () => {
      overlays.scaleRoot = null;
      overlays.scaleBar = null;
      overlays.scaleLength = null;
      overlays.scaleContext = null;
      overlays.scaleNote = null;
    };
  }, []);
  return (
    <div ref={root} className="scale-indicator glass" role="img" aria-label={t.t('scale.label')} data-testid="scale-indicator">
      <div className="scale-bar-row" aria-hidden="true">
        <div ref={bar} className="scale-bar" />
        <span ref={length} className="scale-length" data-testid="scale-length" />
      </div>
      <div ref={context} className="scale-context" aria-hidden="true" />
      <div ref={note} className="scale-note" aria-hidden="true" />
    </div>
  );
}

/** Text-atlas toggle (shared by the top bar and the settings dialog). */
export function TextAtlasButton({ iconOnly }: { iconOnly?: boolean }) {
  const t = useT();
  const textAtlas = useApp((s) => s.textAtlas);
  return (
    <button
      type="button"
      className={`btn${iconOnly ? ' btn-icon' : ''}`}
      aria-pressed={textAtlas}
      aria-label={iconOnly ? t.t('controls.textAtlas') : undefined}
      title={t.t('controls.textAtlas')}
      onClick={() => showTextAtlas(!textAtlas)}
      data-testid="text-atlas-toggle"
    >
      <Icon name="text" />
      {!iconOnly && <span className="btn-label-wide">{t.t('controls.textAtlas')}</span>}
    </button>
  );
}

export function ExportButton({ iconOnly }: { iconOnly?: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`btn${iconOnly ? ' btn-icon' : ''}`}
      aria-label={iconOnly ? t.t('controls.export') : undefined}
      title={t.t('controls.export')}
      onClick={() => openModal('export')}
      data-testid="export-open"
    >
      <Icon name="camera" />
      {!iconOnly && <span className="btn-label-wide">{t.t('controls.export')}</span>}
    </button>
  );
}

export function AboutButton() {
  const t = useT();
  return (
    <button type="button" className="btn btn-icon" aria-label={t.t('controls.about')} title={t.t('controls.about')} onClick={openAbout} data-testid="about-open">
      <Icon name="info" />
    </button>
  );
}

/** Bottom controls: scale bar, the main toggles and zoom. */
export function Hud() {
  const t = useT();
  const layout = useApp((s) => s.layout);
  const compact = layout === 'compact' || layout === 'compact-landscape';
  return (
    <div className="hud-bottom">
      <ScaleIndicator />
      <div className="toolbar glass" role="group" aria-label={t.t('controls.toolbar')}>
        <TourButton />
        <LabelsButton />
        <FreezeButton />
        {layout === 'medium' && <ExportButton iconOnly />}
        {compact && (
          <button type="button" className="btn" onClick={() => openModal('settings')} aria-label={t.t('controls.more')} data-testid="more">
            <Icon name="more" />
          </button>
        )}
      </div>
      {!compact && (
        <div className="zoom-controls glass" role="group" aria-label={t.t('controls.zoomGroup')}>
          <button type="button" className="btn btn-icon" aria-label={t.t('controls.zoomIn')} onClick={() => getEngineController()?.zoom(1)} data-testid="zoom-in">
            <Icon name="plus" />
          </button>
          <button type="button" className="btn btn-icon" aria-label={t.t('controls.zoomOut')} onClick={() => getEngineController()?.zoom(-1)} data-testid="zoom-out">
            <Icon name="minus" />
          </button>
          <button type="button" className="btn btn-icon" aria-label={t.t('controls.resetView')} onClick={() => getEngineController()?.resetView()} data-testid="reset-view">
            <Icon name="reset" />
          </button>
        </div>
      )}
    </div>
  );
}
