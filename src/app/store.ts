import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { StructureId } from '../content/types';
import type { Translator } from '../i18n/translator';
import { initialTourState, type TourState } from './tour';
import type { QualityLevel } from './quality';
import type { Route } from './routing';
import { DEFAULT_SETTINGS, type Settings } from './settings';

/**
 * Explicit application phases:
 *  booting   – resolving the route and loading the locale
 *  loading   – loading the 3D engine and building the scene (progress shown)
 *  ready     – scene built, "Enter the cell" offered
 *  entering  – cutaway transition into the cell
 *  exploring – interactive (camera states tracked in `viewState`)
 *  failed    – renderer unavailable or lost; the text atlas is shown
 */
export type Phase = 'booting' | 'loading' | 'ready' | 'entering' | 'exploring' | 'failed';

/** Camera/inspection state reported by the renderer. */
export type ViewState = 'overview' | 'transition' | 'focused' | 'closeup';

export type FailureKind = 'webgl-unavailable' | 'engine-load' | 'context-lost' | 'runtime' | 'simulated';
export type ModalId = 'help' | 'export' | 'settings';
export type Layout = 'wide' | 'medium' | 'compact' | 'compact-landscape';
export type SheetState = 'collapsed' | 'half' | 'full';

export type SelectionSource =
  | 'scene'
  | 'label'
  | 'list'
  | 'search'
  | 'nav'
  | 'keyboard'
  | 'related'
  | 'tour'
  | 'route'
  | 'atlas';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  actionLabel?: string;
  action?: () => void;
}

export interface Progress {
  done: number;
  total: number;
  /** Locale key under loading.steps.* describing the current step. */
  step: string;
  /** Optional structure id when the step builds a structure. */
  structure?: StructureId;
}

export interface AppState {
  phase: Phase;
  failure: { kind: FailureKind; detail?: string } | null;
  progress: Progress;
  route: Route;
  /** Incremented by every selection request so re-selecting re-frames the camera. */
  focusNonce: number;
  translator: Translator;
  locale: { status: 'ready' | 'loading' | 'failed'; failedLang: string | null };
  viewState: ViewState;
  closeupStatus: 'idle' | 'loading' | 'ready' | 'error';
  closeupViewIndex: number;
  hovered: StructureId | null;
  modal: ModalId | null;
  layout: Layout;
  listOpen: boolean;
  sheet: SheetState;
  settings: Settings;
  systemReducedMotion: boolean;
  effectiveQuality: QualityLevel;
  /** Biological-animation playback (independent of the tour). */
  bioFrozen: boolean;
  tour: TourState;
  toasts: Toast[];
  /** Objects drawn per structure at the current quality (reported by the renderer). */
  drawn: Partial<Record<StructureId, number>>;
  /** Whether the text atlas is shown instead of the 3D view. */
  textAtlas: boolean;
  /** Incremented to remount the renderer after a failure ("Restart 3D view"). */
  rendererGeneration: number;
}

export const appStore = createStore<AppState>()(() => ({
  phase: 'booting',
  failure: null,
  progress: { done: 0, total: 1, step: 'locale' },
  route: { lang: 'en', page: 'cell', structure: null, view: 'cell' },
  focusNonce: 0,
  // Replaced during boot before anything renders.
  translator: undefined as unknown as Translator,
  locale: { status: 'loading', failedLang: null },
  viewState: 'overview',
  closeupStatus: 'idle',
  closeupViewIndex: 0,
  hovered: null,
  modal: null,
  layout: 'wide',
  listOpen: false,
  sheet: 'collapsed',
  settings: { ...DEFAULT_SETTINGS },
  systemReducedMotion: false,
  effectiveQuality: 'medium',
  bioFrozen: false,
  tour: initialTourState(),
  toasts: [],
  drawn: {},
  textAtlas: false,
  rendererGeneration: 0,
}));

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}

export const useT = () => useApp((s) => s.translator);

export function reducedMotion(state: Pick<AppState, 'settings' | 'systemReducedMotion'>): boolean {
  if (state.settings.motion === 'reduce') return true;
  if (state.settings.motion === 'allow') return false;
  return state.systemReducedMotion;
}
