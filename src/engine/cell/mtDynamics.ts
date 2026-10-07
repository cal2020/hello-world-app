import { rngFor } from '../core/random';

/**
 * Deterministic "dynamic instability" for the whole-cell microtubules: each
 * microtubule grows slowly to full length, then undergoes a catastrophe and
 * shrinks quickly to a minimum before being rescued. The same formula runs in
 * the microtubule shader and on the CPU (vesicles ride only on the visible
 * part, and picking ignores the hidden part). Illustrative timing.
 */
export interface MtParams {
  period: Float32Array;
  phase: Float32Array;
  minimum: Float32Array;
}

export const GROW_FRACTION = 0.8;

export function mtParams(count: number): MtParams {
  const rng = rngFor('mt-dynamics');
  const period = new Float32Array(count);
  const phase = new Float32Array(count);
  const minimum = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    period[i] = rng.range(16, 30);
    phase[i] = rng.next();
    minimum[i] = rng.range(0.25, 0.5);
  }
  return { period, phase, minimum };
}

/** Visible fraction (0–1) of microtubule i at biological time t. */
export function mtLength(params: MtParams, i: number, t: number): number {
  const cycle = (t / params.period[i] + params.phase[i]) % 1;
  const min = params.minimum[i];
  if (cycle < GROW_FRACTION) return min + (1 - min) * (cycle / GROW_FRACTION);
  return 1 - (1 - min) * ((cycle - GROW_FRACTION) / (1 - GROW_FRACTION));
}

export function mtGrowing(params: MtParams, i: number, t: number): boolean {
  return (t / params.period[i] + params.phase[i]) % 1 < GROW_FRACTION;
}

export const MT_GLSL = /* glsl */ `
float mtLength(float period, float phase, float minimum, float t) {
  float cycle = fract(t / period + phase);
  if (cycle < ${GROW_FRACTION.toFixed(2)}) return minimum + (1.0 - minimum) * (cycle / ${GROW_FRACTION.toFixed(2)});
  return 1.0 - (1.0 - minimum) * ((cycle - ${GROW_FRACTION.toFixed(2)}) / ${(1 - GROW_FRACTION).toFixed(2)});
}
`;
