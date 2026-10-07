import { describe, expect, it } from 'vitest';
import { DEFAULT_READING_MS, initialTourState, readingProgress, tourReducer, type TourState, type TourEvent } from '../../src/app/tour';
import { TOUR_STEPS } from '../../src/app/actions';

const run = (state: TourState, ...events: TourEvent[]) => {
  let current = state;
  const effects = [];
  for (const event of events) {
    const result = tourReducer(current, event, TOUR_STEPS);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
};

describe('guided tour', () => {
  it('visits all 19 structures and gives 12–15 s of reading time per stop', () => {
    expect(TOUR_STEPS).toHaveLength(19);
    expect(new Set(TOUR_STEPS).size).toBe(19);
    expect(DEFAULT_READING_MS).toBeGreaterThanOrEqual(12_000);
    expect(DEFAULT_READING_MS).toBeLessThanOrEqual(15_000);
  });

  it('starts reading only after the camera arrives', () => {
    const started = run(initialTourState(), { type: 'start' });
    expect(started.effects).toEqual([{ kind: 'select', id: TOUR_STEPS[0] }]);
    expect(started.state.phase).toBe('traveling');
    // Time passing while the camera travels does not count.
    const traveling = run(started.state, { type: 'tick', dtMs: 900 }, { type: 'tick', dtMs: 900 });
    expect(traveling.state.remainingMs).toBe(DEFAULT_READING_MS);
    // Arrival of a different structure is ignored.
    expect(run(traveling.state, { type: 'arrived', id: TOUR_STEPS[3] }).state.phase).toBe('traveling');
    const arrived = run(traveling.state, { type: 'arrived', id: TOUR_STEPS[0] });
    expect(arrived.state.phase).toBe('reading');
    expect(readingProgress(arrived.state)).toBe(0);
  });

  it('advances after the reading time and finishes after the last stop', () => {
    let state = run(initialTourState(), { type: 'start' }, { type: 'arrived', id: TOUR_STEPS[0] }).state;
    const ticks = Array.from({ length: Math.ceil(DEFAULT_READING_MS / 500) }, () => ({ type: 'tick', dtMs: 500 }) as TourEvent);
    const advanced = run(state, ...ticks);
    expect(advanced.effects).toEqual([{ kind: 'select', id: TOUR_STEPS[1] }]);
    expect(advanced.state.index).toBe(1);
    expect(advanced.state.phase).toBe('traveling');
    state = run(initialTourState(), { type: 'start', index: 18 }, { type: 'arrived', id: TOUR_STEPS[18] }).state;
    const finished = run(state, ...ticks);
    expect(finished.effects).toEqual([{ kind: 'finished' }]);
    expect(finished.state.status).toBe('idle');
  });

  it('pausing preserves the stop and the remaining reading time', () => {
    const second: TourEvent = { type: 'tick', dtMs: 1000 };
    const reading = run(initialTourState(), { type: 'start' }, { type: 'arrived', id: TOUR_STEPS[0] }, second, second, second, second).state;
    const paused = run(reading, { type: 'pause' }, { type: 'tick', dtMs: 1000 }, { type: 'tick', dtMs: 1000 }).state;
    expect(paused.status).toBe('paused');
    expect(paused.index).toBe(0);
    expect(paused.remainingMs).toBe(DEFAULT_READING_MS - 4000);
    const resumed = run(paused, { type: 'resume' }, { type: 'tick', dtMs: 1000 }).state;
    expect(resumed.status).toBe('running');
    expect(resumed.remainingMs).toBe(DEFAULT_READING_MS - 5000);
    expect(readingProgress(resumed)).toBeCloseTo(5000 / DEFAULT_READING_MS);
  });

  it('caps a long gap so a hidden tab cannot skip stops', () => {
    const reading = run(initialTourState(), { type: 'start' }, { type: 'arrived', id: TOUR_STEPS[0] }).state;
    const after = run(reading, { type: 'tick', dtMs: 60_000 });
    expect(after.state.index).toBe(0);
    expect(after.state.remainingMs).toBe(DEFAULT_READING_MS - 1000);
  });

  it('steps forward and back without wrapping; exit returns to idle', () => {
    const atStart = run(initialTourState(), { type: 'start' }).state;
    expect(run(atStart, { type: 'prev' }).state.index).toBe(0);
    const second = run(atStart, { type: 'next' });
    expect(second.state.index).toBe(1);
    expect(second.effects).toEqual([{ kind: 'select', id: TOUR_STEPS[1] }]);
    const exited = run(second.state, { type: 'exit' });
    expect(exited.state.status).toBe('idle');
    expect(exited.effects).toEqual([{ kind: 'exited' }]);
    // Events other than start/toggle do nothing while idle.
    expect(run(initialTourState(), { type: 'next' }, { type: 'pause' }).effects).toEqual([]);
  });

  it('toggle starts, pauses and resumes', () => {
    const started = run(initialTourState(), { type: 'toggle' }).state;
    expect(started.status).toBe('running');
    expect(run(started, { type: 'toggle' }).state.status).toBe('paused');
    expect(run(started, { type: 'toggle' }, { type: 'toggle' }).state.status).toBe('running');
  });
});
