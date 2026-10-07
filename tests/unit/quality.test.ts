import { describe, expect, it } from 'vitest';
import { AutoQualityController, QUALITY_PRESETS, defaultAutoConfig, initialAutoLevel } from '../../src/app/quality';

const feed = (controller: AutoQualityController, frameMs: number, totalMs: number) => {
  const changes: string[] = [];
  for (let t = 0; t < totalMs; t += frameMs) {
    const next = controller.sample(frameMs);
    if (next) changes.push(next);
  }
  return changes;
};

describe('automatic quality', () => {
  it('steps down after sustained slow frames, never below low', () => {
    const controller = new AutoQualityController('high', defaultAutoConfig(60));
    const changes = feed(controller, 1000 / 20, 30_000);
    expect(changes).toEqual(['medium', 'low']);
  });

  it('still steps down when every frame is very slow (software rendering)', () => {
    const controller = new AutoQualityController('high', defaultAutoConfig(60));
    expect(feed(controller, 1500, 30_000)).toEqual(['medium', 'low']);
  });

  it('ignores a pathological pause such as a debugger', () => {
    const controller = new AutoQualityController('high', defaultAutoConfig(60));
    feed(controller, 16, 4000);
    expect(controller.sample(20_000)).toBeNull();
  });

  it('steps up only after sustained headroom and a cooldown, and does not oscillate', () => {
    const controller = new AutoQualityController('high', defaultAutoConfig(60));
    feed(controller, 1000 / 20, 9000); // → medium
    expect(controller.level).toBe('medium');
    // Fast again, but within the cooldown: stays.
    expect(feed(controller, 1000 / 60, 20_000)).toEqual([]);
    // After the cooldown, it tries high again…
    expect(feed(controller, 1000 / 60, 40_000)).toEqual(['high']);
    // …fails a second time…
    expect(feed(controller, 1000 / 20, 9000)).toEqual(['medium']);
    // …and is not retried after two failures.
    expect(feed(controller, 1000 / 60, 120_000)).toEqual([]);
  });

  it('chooses a conservative first level', () => {
    expect(initialAutoLevel({ coarsePointer: true })).toBe('low');
    expect(initialAutoLevel({ coarsePointer: false, softwareRenderer: true })).toBe('low');
    expect(initialAutoLevel({ coarsePointer: false, deviceMemoryGb: 4 })).toBe('medium');
    expect(initialAutoLevel({ coarsePointer: false, hardwareConcurrency: 4 })).toBe('medium');
    expect(initialAutoLevel({ coarsePointer: false, deviceMemoryGb: 8, hardwareConcurrency: 8 })).toBe('high');
  });

  it('lower presets never cost more than higher ones', () => {
    expect(QUALITY_PRESETS.low.maxPixelRatio).toBeLessThanOrEqual(QUALITY_PRESETS.medium.maxPixelRatio);
    expect(QUALITY_PRESETS.medium.maxPixelRatio).toBeLessThanOrEqual(QUALITY_PRESETS.high.maxPixelRatio);
    expect(QUALITY_PRESETS.low.bloom).toBe(false);
  });
});
