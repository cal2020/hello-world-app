import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp, useT } from './app/store';
import { useEnvironment, useHeadSync, usePopstate, useShortcuts, useTourTicker } from './app/hooks';
import { overlays, publishInsets } from './app/engineBridge';
import { selectStructure } from './app/actions';
import { TopBar } from './ui/TopBar';
import { StructureNav } from './ui/StructureNav';
import { ReadingPanel } from './ui/ReadingPanel';
import { sheetHeight } from './app/sheet';
import { Hud } from './ui/Hud';
import { TourBar } from './ui/TourBar';
import { EntryOverlay } from './ui/EntryOverlay';
import { Dialogs } from './ui/Dialogs';
import { Toasts } from './ui/Toasts';
import { AtlasBanner, LocaleBanner } from './ui/Banners';
import { TextAtlas } from './ui/TextAtlas';
import { ViewerHost } from './ui/ViewerHost';
import { LocationInset } from './ui/LocationInset';
import { debugParams } from './app/debug';
import { illustrationUrl } from './content/text';

/** DOM layers the renderer updates directly every frame (labels, leader lines, hover tip). */
function OverlayLayers() {
  const labelLayer = useRef<HTMLDivElement>(null);
  const leaderLayer = useRef<SVGSVGElement>(null);
  const hoverTip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    overlays.labelLayer = labelLayer.current;
    overlays.leaderLayer = leaderLayer.current;
    overlays.hoverTip = hoverTip.current;
    return () => {
      overlays.labelLayer = null;
      overlays.leaderLayer = null;
      overlays.hoverTip = null;
    };
  }, []);
  return (
    <>
      <div ref={labelLayer} className="label-layer" aria-hidden="true" data-testid="label-layer">
        <svg ref={leaderLayer} className="leader-layer" />
      </div>
      <div ref={hoverTip} className="hover-tip" aria-hidden="true" />
    </>
  );
}

/**
 * Measures the panels and publishes the unobstructed part of the viewport,
 * so the camera frames the selected structure where it can be seen.
 */
function useViewInsets(deps: unknown[]) {
  useLayoutEffect(() => {
    if (debugParams.capture) {
      publishInsets({ left: 0, right: 0, top: 0, bottom: 0 });
      return;
    }
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const nav = document.getElementById('structure-nav');
      const panel = document.getElementById('reading-panel');
      const topbar = document.querySelector('.topbar');
      const hud = document.querySelector('.hud-bottom');
      const app = document.querySelector<HTMLElement>('.app');
      const layout = app?.dataset.layout;
      const insets = { left: 0, right: 0, top: 0, bottom: 0 };
      const topRect = topbar?.getBoundingClientRect();
      insets.top = topRect ? topRect.bottom : 0;
      if (layout === 'wide' && nav) insets.left = nav.getBoundingClientRect().right;
      if (panel && (layout === 'wide' || layout === 'medium' || layout === 'compact-landscape')) {
        insets.right = Math.max(0, w - panel.getBoundingClientRect().left);
      }
      if (layout === 'compact' && panel) {
        insets.bottom = Math.max(0, h - panel.getBoundingClientRect().top);
        const hudRect = hud?.getBoundingClientRect();
        if (hudRect) insets.bottom = Math.max(insets.bottom, h - hudRect.top);
      } else if (hud) {
        insets.bottom = Math.max(0, h - hud.getBoundingClientRect().top) * 0.6;
      }
      publishInsets(insets);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const sel of ['#structure-nav', '#reading-panel', '.topbar', '.hud-bottom']) {
      const el = document.querySelector(sel);
      if (el) observer.observe(el);
    }
    window.addEventListener('resize', measure);
    // Sheet height animates via CSS; re-measure when the transition settles.
    const timer = window.setTimeout(measure, 320);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function App() {
  useEnvironment();
  useHeadSync();
  usePopstate();
  useShortcuts();
  useTourTicker();
  const t = useT();
  const layout = useApp((s) => s.layout);
  const listOpen = useApp((s) => s.listOpen);
  const sheet = useApp((s) => s.sheet);
  const textAtlas = useApp((s) => s.textAtlas);
  const phase = useApp((s) => s.phase);
  const closeupStatus = useApp((s) => s.closeupStatus);
  const viewState = useApp((s) => s.viewState);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);

  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('atlas-page', textAtlas);
  }, [textAtlas]);

  useViewInsets([layout, sheet, textAtlas, listOpen, viewportHeight]);

  if (debugParams.capture) {
    // Illustration capture (scripts/illustrations.ts): only the 3D view, no panels.
    return (
      <div className="app app-capture" data-layout={layout} data-phase={phase} data-closeup={closeupStatus} data-view-state={viewState}>
        <div className="viewer" id="viewer">
          <ViewerHost />
          <OverlayLayers />
        </div>
        <EntryOverlay />
      </div>
    );
  }

  const sheetH = layout === 'compact' ? sheetHeight(sheet, viewportHeight) : 0;
  const style = layout === 'compact' ? ({ '--sheet-h': `${sheetH}px` } as React.CSSProperties) : undefined;

  return (
    <div
      className="app"
      data-layout={layout}
      data-list-open={listOpen}
      data-text-atlas={textAtlas}
      data-phase={phase}
      data-closeup={closeupStatus}
      data-view-state={viewState}
      style={style}
      lang={t.tag}
    >
      <a className="skip-link" href={textAtlas ? '#atlas-top' : '#reading-panel'}>
        {t.t('nav.skipToExplanation')}
      </a>
      <a className="skip-link" href="#structure-nav">
        {t.t('nav.skipToStructures')}
      </a>
      <div className="viewer" id="viewer" data-hidden={textAtlas}>
        <ViewerHost />
        <OverlayLayers />
      </div>
      <TopBar />
      <StructureNav />
      <ReadingPanel />
      {textAtlas && (
        <main className="text-atlas" data-testid="text-atlas">
          <TextAtlas
            t={t}
            banner={<AtlasBanner />}
            onSelect={(id) => selectStructure(id, { source: 'atlas' })}
            illustrationFor={(id) => illustrationUrl(id)}
          />
        </main>
      )}
      {!textAtlas && <Hud />}
      {!textAtlas && <LocationInset />}
      <TourBar />
      <EntryOverlay />
      <LocaleBanner />
      <Dialogs />
      <Toasts />
    </div>
  );
}
