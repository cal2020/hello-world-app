import { describe, expect, it } from 'vitest';
import { computeScale, niceLength, pixelsPerUnit, relativeMagnification, roundMagnification, splitLength } from '../../src/app/scale';

describe('scale bar', () => {
  it('derives pixels per unit from the perspective projection', () => {
    // 90° vertical field of view: visible height at distance 1 is 2 units.
    expect(pixelsPerUnit(90, 1, 800)).toBeCloseTo(400);
    expect(pixelsPerUnit(90, 2, 800)).toBeCloseTo(200);
  });

  it('picks 1-2-5 lengths', () => {
    expect(niceLength(9.9)).toBe(5);
    expect(niceLength(10)).toBe(10);
    expect(niceLength(19)).toBe(10);
    expect(niceLength(240)).toBe(200);
    expect(niceLength(0.07)).toBeCloseTo(0.05);
    expect(niceLength(0)).toBe(0);
  });

  it('keeps the bar within the maximum and matches the physical length', () => {
    // Whole-cell view: 1 unit = 1 µm.
    const reading = computeScale({ fovDeg: 40, distance: 36, viewportHeightPx: 900, unitNm: 1000, maxBarPx: 120 });
    expect(reading.barPx).toBeLessThanOrEqual(120);
    expect(reading.barPx).toBeGreaterThan(40);
    expect(reading.lengthNm / reading.barPx).toBeCloseTo(reading.nmPerPx);
    // Zooming in by 10× makes the represented length 10× smaller.
    const zoomed = computeScale({ fovDeg: 40, distance: 3.6, viewportHeightPx: 900, unitNm: 1000, maxBarPx: 120 });
    expect(zoomed.nmPerPx).toBeCloseTo(reading.nmPerPx / 10);
  });

  it('switches between nm, µm and mm', () => {
    expect(splitLength(500)).toEqual({ value: 500, unit: 'nm' });
    expect(splitLength(1000)).toEqual({ value: 1, unit: 'um' });
    expect(splitLength(2500)).toEqual({ value: 2.5, unit: 'um' });
    expect(splitLength(2_000_000)).toEqual({ value: 2, unit: 'mm' });
  });

  it('reports close-up magnification relative to the whole-cell view', () => {
    expect(relativeMagnification(1, 100)).toBe(100);
    expect(roundMagnification(98.7)).toBe(99);
    expect(roundMagnification(1234)).toBe(1200);
    expect(roundMagnification(0)).toBe(0);
  });
});
