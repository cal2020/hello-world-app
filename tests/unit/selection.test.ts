import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRoute,
  configureHistory,
  dispatchTour,
  goOverview,
  handleEscape,
  neighbor,
  notifyCameraArrived,
  selectStructure,
  setCloseupViewIndex,
  setInspectView,
  stepStructure,
  toggleBioFrozen,
  STRUCTURE_ORDER,
} from '../../src/app/actions';
import { appStore } from '../../src/app/store';
import { initialTourState } from '../../src/app/tour';
import { createTranslator } from '../../src/i18n/translator';
import { englishMessages } from '../../src/i18n/load';

const history: { mode: 'push' | 'replace'; url: string }[] = [];
const english = createTranslator('en', englishMessages, englishMessages);
const initial = appStore.getState();

beforeEach(() => {
  history.length = 0;
  configureHistory(
    { push: (url) => history.push({ mode: 'push', url }), replace: (url) => history.push({ mode: 'replace', url }) },
    '/',
  );
  appStore.setState({
    ...initial,
    translator: english,
    route: { lang: 'en', page: 'cell', structure: null, view: 'cell' },
    tour: initialTourState(),
    layout: 'wide',
    toasts: [],
    bioFrozen: false,
    closeupViewIndex: 0,
  });
});

describe('selection', () => {
  it('every selection source updates route, panel state and URL in one step', () => {
    for (const source of ['scene', 'label', 'list', 'search'] as const) {
      goOverview();
      history.length = 0;
      selectStructure('mitochondria', { source });
      const state = appStore.getState();
      expect(state.route).toMatchObject({ structure: 'mitochondria', view: 'cell' });
      expect(history).toEqual([{ mode: 'push', url: '/en/mitochondria/' }]);
    }
  });

  it('does not add a history entry when nothing changes', () => {
    selectStructure('nucleus', { source: 'list' });
    selectStructure('nucleus', { source: 'scene' });
    expect(history).toHaveLength(1);
  });

  it('opens and leaves the close-up and its sub-views with their own addresses', () => {
    selectStructure('mitochondria', { source: 'list' });
    setInspectView('closeup');
    setCloseupViewIndex(1);
    expect(history.map((h) => h.url)).toEqual([
      '/en/mitochondria/',
      '/en/mitochondria/?view=closeup',
      '/en/mitochondria/?view=closeup&detail=atp-synthase',
    ]);
    expect(appStore.getState().closeupViewIndex).toBe(1);
    // Escape goes up one level at a time: close-up → in the cell → whole cell.
    expect(handleEscape()).toBe(true);
    expect(appStore.getState().route).toMatchObject({ structure: 'mitochondria', view: 'cell' });
    expect(appStore.getState().closeupViewIndex).toBe(0);
    expect(handleEscape()).toBe(true);
    expect(appStore.getState().route.structure).toBeNull();
    expect(handleEscape()).toBe(false);
  });

  it('restores state from Back/Forward without writing history', async () => {
    await applyRoute({ lang: 'en', page: 'cell', structure: 'chromosomes', view: 'closeup', detail: 1 });
    expect(appStore.getState().route).toMatchObject({ structure: 'chromosomes', view: 'closeup' });
    expect(appStore.getState().closeupViewIndex).toBe(1);
    expect(history).toEqual([]);
  });

  it('previous/next wrap around the 19 structures', () => {
    const first = STRUCTURE_ORDER[0];
    const last = STRUCTURE_ORDER[STRUCTURE_ORDER.length - 1];
    expect(neighbor(last, 1)).toBe(first);
    expect(neighbor(first, -1)).toBe(last);
    expect(neighbor(null, 1)).toBe(first);
    selectStructure(last, { source: 'list' });
    stepStructure(1);
    expect(appStore.getState().route.structure).toBe(first);
  });
});

describe('tour integration', () => {
  it('tour steps replace the history entry instead of piling up', () => {
    dispatchTour({ type: 'start' });
    expect(appStore.getState().route.structure).toBe(STRUCTURE_ORDER[0]);
    expect(history).toEqual([{ mode: 'replace', url: `/en/${STRUCTURE_ORDER[0]}/` }]);
  });

  it('manual selection ends the tour and explains why', () => {
    dispatchTour({ type: 'start' });
    notifyCameraArrived(STRUCTURE_ORDER[0]);
    expect(appStore.getState().tour.phase).toBe('reading');
    selectStructure('golgi', { source: 'list' });
    expect(appStore.getState().tour.status).toBe('idle');
    expect(appStore.getState().toasts.at(-1)?.message).toBe(english.t('tour.endedByManual'));
  });

  it('pausing the tour and freezing biological animation are independent', () => {
    dispatchTour({ type: 'start' });
    dispatchTour({ type: 'pause' });
    expect(appStore.getState().tour.status).toBe('paused');
    expect(appStore.getState().bioFrozen).toBe(false);
    toggleBioFrozen();
    expect(appStore.getState().bioFrozen).toBe(true);
    expect(appStore.getState().tour.status).toBe('paused');
    dispatchTour({ type: 'resume' });
    expect(appStore.getState().tour.status).toBe('running');
    expect(appStore.getState().bioFrozen).toBe(true);
  });

  it('starting the tour from a close-up returns to the in-cell view', () => {
    selectStructure('nucleus', { source: 'list' });
    setInspectView('closeup');
    dispatchTour({ type: 'start' });
    expect(appStore.getState().route.view).toBe('cell');
  });
});
