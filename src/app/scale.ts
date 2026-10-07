/**
 * Scale-bar mathematics.
 *
 * For a perspective camera, the visible height at distance d from the camera
 * is 2·d·tan(fov/2) scene units. Dividing the viewport height in CSS pixels by
 * that gives pixels per scene unit at the focus distance. The current scene's
 * unit mapping (1 unit = 1 µm in the whole cell; usually 1 unit = 1 nm in a
 * close-up) converts scene units to physical length.
 */

export interface ScaleInput {
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Distance from the camera to the orbit target, in scene units. */
  distance: number;
  /** Height of the rendered viewport in CSS pixels. */
  viewportHeightPx: number;
  /** Physical length of one scene unit, in nanometres. */
  unitNm: number;
  /** Preferred maximum bar length in CSS pixels. */
  maxBarPx?: number;
}

export interface ScaleReading {
  /** Bar length in CSS pixels. */
  barPx: number;
  /** Physical length represented by the bar, in nanometres. */
  lengthNm: number;
  /** Nanometres per CSS pixel at the focus distance. */
  nmPerPx: number;
}

export type LengthUnit = 'nm' | 'um' | 'mm';

export function pixelsPerUnit(fovDeg: number, distance: number, viewportHeightPx: number): number {
  const visibleHeight = 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
  return viewportHeightPx / visibleHeight;
}

/** Largest "nice" length (1, 2 or 5 × 10^k) that does not exceed `maxValue`. */
export function niceLength(maxValue: number): number {
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return 0;
  const exponent = Math.floor(Math.log10(maxValue));
  const base = 10 ** exponent;
  const mantissa = maxValue / base;
  // Small epsilon keeps exact powers (e.g. 1000) from rounding down.
  const steps = [5, 2, 1];
  for (const step of steps) {
    if (mantissa + 1e-9 >= step) return step * base;
  }
  return base;
}

export function computeScale(input: ScaleInput): ScaleReading {
  const maxBarPx = input.maxBarPx ?? 128;
  const ppu = pixelsPerUnit(input.fovDeg, input.distance, input.viewportHeightPx);
  const nmPerPx = input.unitNm / ppu;
  const lengthNm = niceLength(nmPerPx * maxBarPx);
  return { barPx: lengthNm / nmPerPx, lengthNm, nmPerPx };
}

/** Express a length in the most readable unit: nm below 1 µm, µm below 1 mm. */
export function splitLength(nm: number): { value: number; unit: LengthUnit } {
  if (nm >= 1e6) return { value: nm / 1e6, unit: 'mm' };
  if (nm >= 1000) return { value: nm / 1000, unit: 'um' };
  return { value: nm, unit: 'nm' };
}

/**
 * Magnification of the current view relative to a reference view
 * (e.g. a close-up compared with the whole-cell overview).
 */
export function relativeMagnification(nmPerPxNow: number, nmPerPxReference: number): number {
  return nmPerPxReference / nmPerPxNow;
}

/** Round a magnification for display to two significant figures. */
export function roundMagnification(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Number((Math.round(value / magnitude) * magnitude).toPrecision(2));
}
