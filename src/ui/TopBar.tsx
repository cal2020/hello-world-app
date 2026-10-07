import { useApp, useT } from '../app/store';
import { changeLanguage, goOverview, openModal, setInspectView, setListOpen } from '../app/actions';
import { LANGS, LANG_INFO, type Lang } from '../i18n/languages';
import { structure } from '../content/registry';
import { structureName } from '../content/text';
import { Icon } from './icons';
import { AboutButton, ExportButton, MotionSelect, QualitySelect, TextAtlasButton } from './Hud';

export function LanguageSelect({ id }: { id?: string }) {
  const t = useT();
  const lang = useApp((s) => s.route.lang);
  const loading = useApp((s) => s.locale.status === 'loading');
  return (
    <label className="language-select">
      <span className="visually-hidden">{t.t('controls.language')}</span>
      <select
        id={id}
        className="select"
        value={lang}
        disabled={loading}
        aria-busy={loading}
        onChange={(event) => void changeLanguage(event.target.value as Lang)}
        data-testid="language-select"
      >
        {LANGS.map((code) => (
          <option key={code} value={code} lang={LANG_INFO[code].tag}>
            {LANG_INFO[code].nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TopBar() {
  const t = useT();
  const layout = useApp((s) => s.layout);
  const listOpen = useApp((s) => s.listOpen);
  const route = useApp((s) => s.route);
  const selected = route.page === 'cell' ? route.structure : null;
  const showMenu = layout !== 'wide';

  return (
    <header className="topbar">
      {showMenu && (
        <button
          type="button"
          className="btn btn-icon glass"
          style={{ borderRadius: 12 }}
          aria-label={listOpen ? t.t('nav.hideList') : t.t('nav.showList')}
          aria-expanded={listOpen}
          aria-controls="structure-nav"
          onClick={() => setListOpen(!listOpen)}
          data-testid="list-toggle"
        >
          <Icon name="menu" />
        </button>
      )}
      <button type="button" className="brand" onClick={() => goOverview({ source: 'nav' })} aria-label={t.t('nav.wholeCellHint')}>
        <span className="brand-title" aria-hidden="true">
          {t.t('app.title')}
        </span>
        <span className="brand-sub" aria-hidden="true">
          {t.t('app.tagline')}
        </span>
      </button>
      <nav className="breadcrumb" aria-label={t.t('nav.breadcrumb')}>
        <ol>
          <li>
            {selected ? (
              <button type="button" onClick={() => goOverview({ source: 'nav' })}>
                {t.t('nav.wholeCell')}
              </button>
            ) : (
              <span aria-current="page">{t.t('nav.wholeCell')}</span>
            )}
          </li>
          {selected && (
            <li>
              {route.view === 'closeup' ? (
                <button type="button" onClick={() => setInspectView('cell')}>
                  {structureName(t, selected)}
                </button>
              ) : (
                <span aria-current="page">
                  <span className="visually-hidden">{t.t(`groups.${structure(selected).group}`)}: </span>
                  {structureName(t, selected)}
                </span>
              )}
            </li>
          )}
          {selected && route.view === 'closeup' && (
            <li>
              <span aria-current="page">{t.t('panel.closeup')}</span>
            </li>
          )}
        </ol>
      </nav>
      <div className="topbar-spacer" />
      <div className="topbar-group">
        <button
          type="button"
          className="btn"
          onClick={() => goOverview({ source: 'nav' })}
          aria-label={t.t('nav.wholeCellHint')}
          data-testid="whole-cell"
        >
          <Icon name="cell" />
          <span className="btn-label-wide">{t.t('nav.wholeCell')}</span>
        </button>
        {(layout === 'wide' || layout === 'medium') && <LanguageSelect />}
        {layout === 'wide' && (
          <>
            <QualitySelect labelled />
            <MotionSelect labelled />
            <ExportButton iconOnly />
            <TextAtlasButton iconOnly />
            <AboutButton />
          </>
        )}
        {layout === 'medium' && (
          <button type="button" className="btn btn-icon" onClick={() => openModal('settings')} aria-label={t.t('controls.settings')} data-testid="settings-open">
            <Icon name="quality" />
          </button>
        )}
        <button type="button" className="btn btn-icon" aria-label={t.t('controls.help')} title={t.t('controls.help')} onClick={() => openModal('help')} data-testid="help">
          <Icon name="help" />
        </button>
      </div>
    </header>
  );
}
