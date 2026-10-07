import type { StructureId } from '../content/types';

/**
 * Guided-tour state machine (pure; time is injected through `tick` events).
 *
 * Rules:
 *  - Each stop first waits for the camera to arrive (`traveling`); the
 *    reading timer starts only when the renderer reports arrival.
 *  - Pausing freezes the current step and the remaining reading time.
 *  - next/prev move between stops without wrapping; `next` on the last stop
 *    finishes the tour.
 *  - Manual selection outside the tour is handled by the store: it sends
 *    `exit`, which ends automatic advancement.
 *  - Tour pause is independent of the biological-animation freeze.
 */

export const DEFAULT_READING_MS = 14_000;

export type TourStatus = 'idle' | 'running' | 'paused';
export type TourPhase = 'traveling' | 'reading';

export interface TourState {
  status: TourStatus;
  index: number;
  phase: TourPhase;
  remainingMs: number;
  readingMs: number;
}

export type TourEvent =
  | { type: 'start'; index?: number }
  | { type: 'arrived'; id: StructureId }
  | { type: 'tick'; dtMs: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; index: number }
  | { type: 'exit' };

export type TourEffect = { kind: 'select'; id: StructureId } | { kind: 'finished' } | { kind: 'exited' };

export interface TourResult {
  state: TourState;
  effects: TourEffect[];
}

export function initialTourState(readingMs = DEFAULT_READING_MS): TourState {
  return { status: 'idle', index: 0, phase: 'traveling', remainingMs: readingMs, readingMs };
}

function goTo(state: TourState, steps: readonly StructureId[], index: number): TourResult {
  const clamped = Math.max(0, Math.min(steps.length - 1, index));
  return {
    state: { ...state, index: clamped, phase: 'traveling', remainingMs: state.readingMs },
    effects: [{ kind: 'select', id: steps[clamped] }],
  };
}

export function tourReducer(state: TourState, event: TourEvent, steps: readonly StructureId[]): TourResult {
  const none: TourResult = { state, effects: [] };
  switch (event.type) {
    case 'start': {
      const started: TourState = { ...state, status: 'running' };
      return goTo(started, steps, event.index ?? 0);
    }
    case 'arrived': {
      if (state.status === 'idle' || state.phase !== 'traveling') return none;
      if (steps[state.index] !== event.id) return none;
      return { state: { ...state, phase: 'reading', remainingMs: state.readingMs }, effects: [] };
    }
    case 'tick': {
      if (state.status !== 'running' || state.phase !== 'reading') return none;
      const dt = Math.max(0, Math.min(event.dtMs, 1000)); // clamp large gaps (e.g. a hidden tab)
      const remainingMs = state.remainingMs - dt;
      if (remainingMs > 0) return { state: { ...state, remainingMs }, effects: [] };
      if (state.index >= steps.length - 1) {
        return { state: initialTourState(state.readingMs), effects: [{ kind: 'finished' }] };
      }
      return goTo(state, steps, state.index + 1);
    }
    case 'pause':
      return state.status === 'running' ? { state: { ...state, status: 'paused' }, effects: [] } : none;
    case 'resume':
      return state.status === 'paused' ? { state: { ...state, status: 'running' }, effects: [] } : none;
    case 'toggle':
      if (state.status === 'running') return { state: { ...state, status: 'paused' }, effects: [] };
      if (state.status === 'paused') return { state: { ...state, status: 'running' }, effects: [] };
      return tourReducer(state, { type: 'start' }, steps);
    case 'next':
      if (state.status === 'idle') return none;
      if (state.index >= steps.length - 1) {
        return { state: initialTourState(state.readingMs), effects: [{ kind: 'finished' }] };
      }
      return goTo(state, steps, state.index + 1);
    case 'prev':
      if (state.status === 'idle') return none;
      return goTo(state, steps, state.index - 1);
    case 'goto':
      if (state.status === 'idle') return none;
      return goTo(state, steps, event.index);
    case 'exit':
      if (state.status === 'idle') return none;
      return { state: initialTourState(state.readingMs), effects: [{ kind: 'exited' }] };
  }
}

/** Fraction of the current stop's reading time that has elapsed (0–1). */
export function readingProgress(state: TourState): number {
  if (state.phase !== 'reading') return 0;
  return Math.min(1, Math.max(0, 1 - state.remainingMs / state.readingMs));
}
