import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { appStore, useApp, useT, type SheetState } from '../app/store';
import {
  dispatchTour,
  neighbor,
  selectStructure,
  setCloseupViewIndex,
  setInspectView,
  setSheet,
  underlyingRoute,
} from '../app/actions';
import { structureName } from '../content/text';
import { OverviewArticle } from './OverviewArticle';
import { StructureArticle } from './StructureArticle';
import { Icon } from './icons';
import { sheetHeight } from '../app/sheet';

const ORDER: SheetState[] = ['collapsed', 'half', 'full'];

function SheetHandle() {
  const t = useT();
  const sheet = useApp((s) => s.sheet);
  const drag = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const panel = event.currentTarget.parentElement as HTMLElement;
    drag.current = { startY: event.clientY, startH: panel.getBoundingClientRect().height, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = event.clientY - d.startY;
    if (Math.abs(dy) > 6) d.moved = true;
    if (!d.moved) return;
    const root = document.querySelector<HTMLElement>('.app');
    const h = Math.max(110, Math.min(window.innerHeight - 60, d.startH - dy));
    root?.style.setProperty('--sheet-h', `${h}px`);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    const h = d.startH - (event.clientY - d.startY);
    const vh = window.innerHeight;
    const candidates = ORDER.map((state) => ({ state, h: sheetHeight(state, vh) }));
    candidates.sort((a, b) => Math.abs(a.h - h) - Math.abs(b.h - h));
    const next = candidates[0].state;
    document.querySelector<HTMLElement>('.app')?.style.removeProperty('--sheet-h');
    setSheet(next);
    // The App re-applies --sheet-h from state on the next render.
    appStore.setState({ sheet: next });
  };
  const onClick = () => {
    if (drag.current?.moved) return;
    const index = ORDER.indexOf(sheet);
    setSheet(ORDER[(index + 1) % ORDER.length]);
  };

  return (
    <button
      type="button"
      className="panel-handle"
      aria-label={sheet === 'full' ? t.t('panel.collapse') : t.t('panel.expand')}
      aria-expanded={sheet !== 'collapsed'}
      aria-controls="reading-scroll"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onClick={onClick}
      data-testid="sheet-handle"
    />
  );
}

export function ReadingPanel() {
  const t = useT();
  const layout = useApp((s) => s.layout);
  const route = useApp((s) => underlyingRoute(s));
  const drawn = useApp((s) => (route.structure ? s.drawn[route.structure] : undefined));
  const quality = useApp((s) => s.effectiveQuality);
  const bioFrozen = useApp((s) => s.bioFrozen);
  const closeupStatus = useApp((s) => s.closeupStatus);
  const closeupViewIndex = useApp((s) => s.closeupViewIndex);
  const tourActive = useApp((s) => s.tour.status !== 'idle');
  const textAtlas = useApp((s) => s.textAtlas);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selected = route.structure;
  const compact = layout === 'compact';

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selected]);

  if (textAtlas) return null;

  const qualityLabel = t.t(`controls.quality${quality[0].toUpperCase()}${quality.slice(1)}`);
  const prev = neighbor(selected, -1);
  const next = neighbor(selected, 1);

  return (
    <aside id="reading-panel" className="reading-panel glass" aria-label={t.t('panel.region')} data-testid="reading-panel">
      {compact && <SheetHandle />}
      <div className="panel-scroll" id="reading-scroll" ref={scrollRef}>
        {selected ? (
          <StructureArticle
            key={selected}
            id={selected}
            t={t}
            mode="interactive"
            view={route.view}
            closeupViewIndex={closeupViewIndex}
            drawn={drawn ?? null}
            qualityLabel={qualityLabel}
            bioFrozen={bioFrozen}
            closeupStatus={closeupStatus}
            onSelect={(id) => selectStructure(id, { source: 'related' })}
            onView={(view) => setInspectView(view)}
            onSubview={setCloseupViewIndex}
          />
        ) : (
          <OverviewArticle
            t={t}
            mode="interactive"
            onSelect={(id) => selectStructure(id, { source: 'list' })}
            onStartTour={() => dispatchTour({ type: 'start' })}
          />
        )}
      </div>
      {selected && (
        <div className="panel-footer">
          <button
            type="button"
            className="btn"
            onClick={() => (tourActive ? dispatchTour({ type: 'prev' }) : selectStructure(prev, { source: 'nav' }))}
            aria-label={t.t('nav.previousNamed', { name: structureName(t, prev) })}
            title={t.t('nav.wrapNote')}
            data-testid="prev-structure"
          >
            <Icon name="prev" />
            <span>{structureName(t, prev)}</span>
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => (tourActive ? dispatchTour({ type: 'next' }) : selectStructure(next, { source: 'nav' }))}
            aria-label={t.t('nav.nextNamed', { name: structureName(t, next) })}
            title={t.t('nav.wrapNote')}
            data-testid="next-structure"
          >
            <span>{structureName(t, next)}</span>
            <Icon name="next" />
          </button>
        </div>
      )}
    </aside>
  );
}
