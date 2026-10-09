import { STRUCTURE_META } from '../content/structures';
import type { StructureId } from '../content/types';
import { englishMessages, loadMessages } from '../i18n/load';
import { LANG_INFO, type Lang } from '../i18n/languages';
import { createTranslator } from '../i18n/translator';
import { routeHref, routesEqual, type InspectView, type Route } from './routing';
import { saveLanguagePreference, saveSettings, type Settings } from './settings';
import {
  appStore,
  type AppState,
  type FailureKind,
  type ModalId,
  type SelectionSource,
  type SheetState,
  type Toast,
} from './store';
import { tourReducer, type TourEvent } from './tour';

export type HistoryMode = 'push' | 'replace' | 'none';

/** Navigation order shared by the list, previous/next, arrow keys and the tour. */
export const STRUCTURE_ORDER: StructureId[] = STRUCTURE_META.map((s) => s.id);
export const TOUR_STEPS: StructureId[] = STRUCTURE_ORDER;

// ── History port (injectable for tests) ─────────────────────────────────────

export interface HistoryPort {
  push(url: string, state: unknown): void;
  replace(url: string, state: unknown): void;
}

const browserHistory: HistoryPort = {
  push: (url, state) => window.history.pushState(state, '', url),
  replace: (url, state) => window.history.replaceState(state, '', url),
};

let historyPort: HistoryPort = browserHistory;
let basePath = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/';

export function configureHistory(port: HistoryPort, base?: string): void {
  historyPort = port;
  if (base) basePath = base;
}

export function currentBase(): string {
  return basePath;
}

function commitHistory(route: Route, mode: HistoryMode): void {
  if (mode === 'none') return;
  const url = routeHref(route, basePath);
  const state = { hca: true, route };
  if (mode === 'push') historyPort.push(url, state);
  else historyPort.replace(url, state);
}

const get = () => appStore.getState();
const set = (partial: Partial<AppState>) => appStore.setState(partial);

// ── Toasts ──────────────────────────────────────────────────────────────────

let toastId = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function pushToast(toast: Omit<Toast, 'id'>, durationMs = toast.kind === 'error' ? 12_000 : 5_000): number {
  const id = ++toastId;
  set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] });
  if (durationMs > 0 && typeof setTimeout !== 'undefined') {
    toastTimers.set(
      id,
      setTimeout(() => dismissToast(id), durationMs),
    );
  }
  return id;
}

export function dismissToast(id: number): void {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
  set({ toasts: get().toasts.filter((t) => t.id !== id) });
}

// ── Selection (the single action used by every selection method) ───────────

export interface SelectOptions {
  source: SelectionSource;
  history?: HistoryMode;
  view?: InspectView;
}

/**
 * Select a structure (or `null` for the whole cell). Geometry clicks, labels,
 * list entries, search results, previous/next, related links, the tour and
 * route changes all call this function, so camera, panel, selection state and
 * URL always change together.
 */
export function selectStructure(id: StructureId | null, options: SelectOptions): void {
  const state = get();
  if (state.tour.status !== 'idle' && options.source !== 'tour' && options.source !== 'route') {
    // Manual selection ends automatic advancement.
    dispatchTour({ type: 'exit' });
    pushToast({ kind: 'info', message: state.translator.t('tour.endedByManual') });
  }
  const route: Route = {
    lang: state.route.lang,
    page: 'cell',
    structure: id,
    view: id ? (options.view ?? 'cell') : 'cell',
  };
  const compact = state.layout === 'compact' || state.layout === 'compact-landscape';
  let sheet: SheetState = state.sheet;
  if (!id) sheet = 'collapsed';
  else if (compact && options.source !== 'tour' && options.source !== 'route' && sheet === 'collapsed') sheet = 'half';
  const changed = !routesEqual(route, state.route);
  set({
    route,
    focusNonce: state.focusNonce + 1,
    closeupViewIndex: 0,
    listOpen: compact || state.layout === 'medium' ? false : state.listOpen,
    sheet,
  });
  if (changed) commitHistory(route, options.history ?? 'push');
}

export function goOverview(options: Omit<SelectOptions, 'view'> = { source: 'nav' }): void {
  selectStructure(null, options);
}

export function setInspectView(view: InspectView, history: HistoryMode = 'push'): void {
  const state = get();
  if (!state.route.structure || state.route.view === view) return;
  if (state.tour.status !== 'idle' && view === 'closeup') dispatchTour({ type: 'exit' });
  const route: Route = { ...state.route, view, detail: undefined };
  set({ route, closeupViewIndex: 0 });
  commitHistory(route, history);
}

/** Switch between a structure's close-up views (each has its own address). */
export function setCloseupViewIndex(index: number, history: HistoryMode = 'push'): void {
  const state = get();
  if (state.closeupViewIndex === index && (state.route.detail ?? 0) === index) return;
  if (!state.route.structure || state.route.view !== 'closeup') {
    set({ closeupViewIndex: index });
    return;
  }
  const route: Route = { ...state.route, detail: index > 0 ? index : undefined };
  set({ route, closeupViewIndex: index });
  commitHistory(route, history);
}

export function neighbor(id: StructureId | null, direction: 1 | -1): StructureId {
  // Navigation wraps: after the last structure comes the first, and vice versa.
  if (!id) return direction === 1 ? STRUCTURE_ORDER[0] : STRUCTURE_ORDER[STRUCTURE_ORDER.length - 1];
  const index = STRUCTURE_ORDER.indexOf(id);
  const next = (index + direction + STRUCTURE_ORDER.length) % STRUCTURE_ORDER.length;
  return STRUCTURE_ORDER[next];
}

export function stepStructure(direction: 1 | -1, source: SelectionSource = 'nav'): void {
  const state = get();
  if (state.tour.status !== 'idle') {
    dispatchTour({ type: direction === 1 ? 'next' : 'prev' });
    return;
  }
  selectStructure(neighbor(state.route.structure, direction), { source });
}

/** Apply a route that came from the address bar or Back/Forward (no new history entry). */
export async function applyRoute(route: Route): Promise<void> {
  const state = get();
  if (route.lang !== state.route.lang || state.translator.standIn) {
    await changeLanguage(route.lang, 'none');
  }
  const current = get();
  if (current.tour.status !== 'idle' && route.structure !== current.route.structure) {
    dispatchTour({ type: 'exit' });
  }
  // If the locale failed to load, the previous language stays active (a toast offers a retry).
  set({
    route: { ...route, lang: get().route.lang },
    focusNonce: current.focusNonce + 1,
    closeupViewIndex: route.view === 'closeup' ? (route.detail ?? 0) : 0,
  });
}

// ── About page / modals ─────────────────────────────────────────────────────

let routeBeforeAbout: Route | null = null;

export function openAbout(): void {
  const state = get();
  if (state.route.page === 'about') return;
  routeBeforeAbout = state.route;
  const route: Route = { lang: state.route.lang, page: 'about', structure: null, view: 'cell' };
  set({ route, modal: null });
  commitHistory(route, 'push');
}

export function closeAbout(): void {
  const state = get();
  if (state.route.page !== 'about') return;
  const back: Route = routeBeforeAbout
    ? { ...routeBeforeAbout, lang: state.route.lang }
    : { lang: state.route.lang, page: 'cell', structure: null, view: 'cell' };
  routeBeforeAbout = null;
  set({ route: back, focusNonce: state.focusNonce + 1 });
  commitHistory(back, 'push');
}

/** The selection hidden underneath the About panel (so the scene keeps its state). */
export function underlyingRoute(state: AppState): Route {
  if (state.route.page === 'about' && routeBeforeAbout) return routeBeforeAbout;
  return state.route;
}

export function openModal(modal: ModalId): void {
  set({ modal });
}

export function closeModal(): void {
  set({ modal: null });
}

/**
 * Escape: close a modal first; otherwise go up one level
 * (close-up → in-cell view → whole cell).
 */
export function handleEscape(): boolean {
  const state = get();
  if (state.modal) {
    closeModal();
    return true;
  }
  if (state.route.page === 'about') {
    closeAbout();
    return true;
  }
  if (state.listOpen && state.layout !== 'wide') {
    set({ listOpen: false });
    return true;
  }
  if (state.route.structure && state.route.view === 'closeup') {
    setInspectView('cell');
    return true;
  }
  if (state.route.structure) {
    goOverview({ source: 'keyboard' });
    return true;
  }
  return false;
}

// ── Tour ────────────────────────────────────────────────────────────────────

export function dispatchTour(event: TourEvent): void {
  const state = get();
  if (event.type === 'start' || (event.type === 'toggle' && state.tour.status === 'idle')) {
    if (state.route.view === 'closeup' && state.route.structure) {
      set({ route: { ...state.route, view: 'cell' } });
    }
    if (state.modal) set({ modal: null });
  }
  const { state: tour, effects } = tourReducer(get().tour, event, TOUR_STEPS);
  set({ tour });
  for (const effect of effects) {
    if (effect.kind === 'select') selectStructure(effect.id, { source: 'tour', history: 'replace' });
    else if (effect.kind === 'finished') pushToast({ kind: 'success', message: get().translator.t('tour.finished') });
  }
}

/** Called by the renderer whenever a camera transition reaches its target. */
export function notifyCameraArrived(id: StructureId | null): void {
  if (id) dispatchTour({ type: 'arrived', id });
}

// ── Playback, settings, language ────────────────────────────────────────────

export function setBioFrozen(frozen: boolean): void {
  set({ bioFrozen: frozen });
}

export function toggleBioFrozen(): void {
  setBioFrozen(!get().bioFrozen);
}

export function updateSettings(partial: Partial<Settings>): void {
  const settings = { ...get().settings, ...partial };
  set({ settings });
  saveSettings(settings);
}

export function toggleLabels(): void {
  updateSettings({ labels: !get().settings.labels });
}

export function setHovered(id: StructureId | null): void {
  if (get().hovered !== id) set({ hovered: id });
}

export function setListOpen(open: boolean): void {
  set({ listOpen: open });
}

export function setSheet(sheet: SheetState): void {
  set({ sheet });
}

let chineseFontsRequested = false;
export function ensureScriptFonts(lang: Lang): void {
  if (lang === 'zh' && !chineseFontsRequested && typeof document !== 'undefined') {
    chineseFontsRequested = true;
    import('../styles/fonts-zh.generated.css').catch(() => {
      chineseFontsRequested = false;
    });
  }
}

export async function changeLanguage(lang: Lang, history: HistoryMode = 'push'): Promise<boolean> {
  const state = get();
  if (lang === state.route.lang && !state.translator.standIn && state.locale.status === 'ready') return true;
  set({ locale: { status: 'loading', failedLang: null } });
  try {
    const messages = await loadMessages(lang);
    const translator = createTranslator(lang, messages, englishMessages);
    const route: Route = { ...get().route, lang };
    set({ translator, route, locale: { status: 'ready', failedLang: null } });
    saveLanguagePreference(lang);
    ensureScriptFonts(lang);
    commitHistory(route, history);
    return true;
  } catch {
    const current = get();
    set({ locale: { status: 'failed', failedLang: lang } });
    pushToast({
      kind: 'error',
      message: current.translator.t('errors.localeFailed', { language: LANG_INFO[lang].nativeName }),
      actionLabel: current.translator.t('errors.retry'),
      action: () => void changeLanguage(lang, history),
    });
    return false;
  }
}

// ── Renderer lifecycle ──────────────────────────────────────────────────────

export function reportFailure(kind: FailureKind, detail?: string): void {
  set({ phase: 'failed', failure: { kind, detail }, textAtlas: true });
}

export function showTextAtlas(show: boolean): void {
  set({ textAtlas: show });
}

/** Remount the renderer after a failure ("Restart 3D view" / "Try again"). */
export function restart3d(): void {
  const state = get();
  set({
    phase: 'loading',
    failure: null,
    textAtlas: false,
    rendererGeneration: state.rendererGeneration + 1,
    progress: { done: 0, total: 1, step: 'engine' },
  });
}
