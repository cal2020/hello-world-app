import { useApp, useT } from '../app/store';
import { closeAbout, closeModal, openAbout, showTextAtlas } from '../app/actions';
import { EXPORT_AVAILABLE, exportImage } from '../app/exportAction';
import { DEFAULT_READING_MS } from '../app/tour';
import { AboutContent } from './AboutContent';
import { Dialog } from './Dialog';
import { SourceList } from './SourceList';
import { LanguageSelect } from './TopBar';
import { MotionSelect, QualitySelect } from './Hud';
import { Icon } from './icons';

const SHORTCUTS: Array<[string, string]> = [
  ['slash', 'search'],
  ['t', 'tour'],
  ['l', 'labels'],
  ['f', 'freeze'],
  ['o', 'overview'],
  ['c', 'closeup'],
  ['arrows', 'prevNext'],
  ['plusMinus', 'zoom'],
  ['zero', 'reset'],
  ['question', 'help'],
  ['escape', 'escape'],
];

function HelpDialog() {
  const t = useT();
  return (
    <Dialog title={t.t('help.title')} onClose={closeModal} closeLabel={t.t('controls.close')} testId="help-dialog">
      <p>{t.t('help.intro')}</p>
      <h3>{t.t('help.exploreTitle')}</h3>
      <p>{t.t('help.explore')}</p>
      <h3>{t.t('help.selectTitle')}</h3>
      <p>{t.t('help.select')}</p>
      <h3>{t.t('help.viewsTitle')}</h3>
      <p>{t.t('help.views')}</p>
      <h3>{t.t('help.tourTitle')}</h3>
      <p>{t.t('help.tour', { seconds: t.formatNumber(DEFAULT_READING_MS / 1000) })}</p>
      <h3>{t.t('help.freezeTitle')}</h3>
      <p>{t.t('help.freeze')}</p>
      <h3>{t.t('help.qualityTitle')}</h3>
      <p>{t.t('help.quality')}</p>
      {EXPORT_AVAILABLE && (
        <>
          <h3>{t.t('help.exportTitle')}</h3>
          <p>{t.t('help.export')}</p>
        </>
      )}
      <h3>{t.t('help.shortcutsTitle')}</h3>
      <p>{t.t('help.shortcutsNote')}</p>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([key, action]) => (
            <tr key={key}>
              <th scope="row">
                <kbd>{t.t(`help.keys.${key}`)}</kbd>
              </th>
              <td>{t.t(`help.shortcuts.${action}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 10 }}>{t.t('nav.wrapNote')}</p>
      <h3>{t.t('help.sourcesTitle')}</h3>
      <SourceList t={t} filterable />
      <p style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            closeModal();
            openAbout();
          }}
        >
          <Icon name="info" />
          {t.t('help.aboutLink')}
        </button>
      </p>
    </Dialog>
  );
}

function ExportDialog() {
  const t = useT();
  return (
    <Dialog title={t.t('export.title')} onClose={closeModal} closeLabel={t.t('controls.close')} small testId="export-dialog">
      <p>{t.t('export.intro')}</p>
      <div className="export-options">
        <button type="button" className="export-option" onClick={() => void exportImage('clean')} data-testid="export-clean">
          <strong>{t.t('export.clean')}</strong>
          <span>{t.t('export.cleanDescription')}</span>
        </button>
        <button type="button" className="export-option" onClick={() => void exportImage('annotated')} data-testid="export-annotated">
          <strong>{t.t('export.annotated')}</strong>
          <span>{t.t('export.annotatedDescription')}</span>
        </button>
      </div>
    </Dialog>
  );
}

function SettingsDialog() {
  const t = useT();
  const textAtlas = useApp((s) => s.textAtlas);
  return (
    <Dialog title={t.t('controls.settings')} onClose={closeModal} closeLabel={t.t('controls.close')} small testId="settings-dialog">
      <div className="settings-grid">
        <label htmlFor="settings-language">
          {t.t('controls.language')}
          <LanguageSelect id="settings-language" />
        </label>
        <label htmlFor="settings-quality">
          {t.t('controls.quality')}
          <QualitySelect id="settings-quality" />
          <span>{t.t('controls.qualityHint')}</span>
        </label>
        <label htmlFor="settings-motion">
          {t.t('controls.motion')}
          <MotionSelect id="settings-motion" />
          <span>{t.t('controls.motionHint')}</span>
        </label>
        {EXPORT_AVAILABLE && (
          <>
            <button type="button" className="btn" onClick={() => void exportImage('clean')} data-testid="export-clean">
              <Icon name="camera" />
              {t.t('export.clean')}
            </button>
            <button type="button" className="btn" onClick={() => void exportImage('annotated')} data-testid="export-annotated">
              <Icon name="camera" />
              {t.t('export.annotated')}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn"
          aria-pressed={textAtlas}
          onClick={() => {
            closeModal();
            showTextAtlas(!textAtlas);
          }}
        >
          <Icon name="text" />
          {t.t('controls.textAtlas')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            closeModal();
            openAbout();
          }}
        >
          <Icon name="info" />
          {t.t('controls.about')}
        </button>
      </div>
    </Dialog>
  );
}

function AboutDialog() {
  const t = useT();
  return (
    <Dialog title={t.t('about.title')} onClose={closeAbout} closeLabel={t.t('about.close')} testId="about-dialog">
      <AboutContent t={t} filterableSources />
    </Dialog>
  );
}

export function Dialogs() {
  const modal = useApp((s) => s.modal);
  const about = useApp((s) => s.route.page === 'about');
  return (
    <>
      {about && !modal && <AboutDialog />}
      {modal === 'help' && <HelpDialog />}
      {modal === 'export' && <ExportDialog />}
      {modal === 'settings' && <SettingsDialog />}
    </>
  );
}
