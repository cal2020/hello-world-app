import { useEffect } from 'react';
import { appStore, reducedMotion, useApp, type Layout } from './store';
import {
  applyRoute,
  currentBase,
  dispatchTour,
  handleEscape,
  openModal,
  setInspectView,
  setListOpen,
  stepStructure,
  goOverview,
  toggleBioFrozen,
  toggleLabels,
} from './actions';
import { applyHead, headInfo } from './head';
import { isRouteHash, parseAddress, HASH_ROUTING } from './routing';
import { getEngineController } from './engineBridge';

export function computeLayout(width: number, height: number): Layout {
  if (width >= 1280) return 'wide';
  if (width >= 900 && height >= 520) return 'medium';
  if (height < 520 && width > height) return 'compact-landscape';
  return 'compact';
}

/** Tracks viewport size/orientation and the OS reduced-motion preference. */
export function useEnvironment(): void {
  useEffect(() => {
    const update = () => {
      const layout = computeLayout(window.innerWidth, window.innerHeight);
      if (appStore.getState().layout !== layout) appStore.setState({ layout, listOpen: false });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => appStore.setState({ systemReducedMotion: media.matches });
    onMotion();
    media.addEventListener('change', onMotion);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      media.removeEventListener('change', onMotion);
    };
  }, []);

  const motion = useApp((s) => s.settings.motion);
  const reduce = useApp((s) => reducedMotion(s));
  useEffect(() => {
    // CSS reads data-motion; "system" defers to the media query.
    document.documentElement.dataset.motion = motion === 'system' ? (reduce ? 'reduce' : 'system') : motion;
  }, [motion, reduce]);
}

/** Keeps <title>, description, canonical/alternate links and <html lang> in sync with the route. */
export function useHeadSync(): void {
  const route = useApp((s) => s.route);
  const translator = useApp((s) => s.translator);
  useEffect(() => {
    applyHead(headInfo(route, translator, currentBase()), window.location.origin);
  }, [route, translator]);
}

/** Browser Back/Forward restore the selection and language without reloading. */
export function usePopstate(): void {
  useEffect(() => {
    const onPop = () => {
      // An in-page anchor in hash mode is not a route change.
      if (HASH_ROUTING && !isRouteHash(window.location.hash)) return;
      const parsed = parseAddress(window.location, currentBase());
      if (parsed.kind === 'route') void applyRoute(parsed.route);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}

/**
 * Tour reading timer. Ticks a few times per second (React only re-renders
 * the tour bar at that rate) and stops while the tab is hidden, so hidden
 * time does not count as reading time.
 */
export function useTourTicker(): void {
  const running = useApp((s) => s.tour.status === 'running' && s.tour.phase === 'reading');
  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (document.hidden) return;
      dispatchTour({ type: 'tick', dtMs: dt });
    }, 200);
    const onVisibility = () => {
      last = performance.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [running]);
}

/** True when keyboard focus is in a text field or form control. */
export function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'submit', 'reset', 'image'].includes(type);
  }
  const role = target.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'slider' || role === 'spinbutton';
}

export function focusSearch(): void {
  const state = appStore.getState();
  if (state.layout !== 'wide') setListOpen(true);
  window.setTimeout(() => document.getElementById('structure-search')?.focus(), 30);
}

/** Global keyboard shortcuts (documented in Help). */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        // A focused text field clears itself first.
        if (isFormTarget(event.target) && (event.target as HTMLInputElement).value) return;
        if (handleEscape()) event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isFormTarget(event.target)) return;
      const state = appStore.getState();
      if (state.modal) return; // dialogs keep their own keyboard behaviour
      const exploring = state.phase === 'exploring' && !state.textAtlas;
      const key = event.key;
      let handled = true;
      switch (key) {
        case '/':
          focusSearch();
          break;
        case '?':
          openModal('help');
          break;
        case 'h':
        case 'H':
          openModal('help');
          break;
        case 't':
        case 'T':
          if (exploring) dispatchTour({ type: 'toggle' });
          else handled = false;
          break;
        case 'l':
        case 'L':
          toggleLabels();
          break;
        case 'f':
        case 'F':
          toggleBioFrozen();
          break;
        case 'o':
        case 'O':
        case 'Home':
          goOverview({ source: 'keyboard' });
          break;
        case 'c':
        case 'C':
          if (state.route.structure) setInspectView(state.route.view === 'closeup' ? 'cell' : 'closeup');
          else handled = false;
          break;
        case 'ArrowRight':
          stepStructure(1, 'keyboard');
          break;
        case 'ArrowLeft':
          stepStructure(-1, 'keyboard');
          break;
        case '+':
        case '=':
          getEngineController()?.zoom(1);
          break;
        case '-':
        case '_':
          getEngineController()?.zoom(-1);
          break;
        case '0':
          getEngineController()?.resetView();
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
