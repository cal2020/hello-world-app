/**
 * Rendering-quality presets and the automatic quality controller.
 *
 * Quality changes pixel ratio, object density, effects and geometric detail.
 * It never removes a structure: every level draws all 19 structures, only
 * repeated objects are thinned (counts come from the content registry).
 */

export type QualityLevel = 'low' | 'medium' | 'high';
export type QualitySetting = 'auto' | QualityLevel;

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

export interface QualityPreset {
  /** Upper bound for the renderer pixel ratio (also bounded by devicePixelRatio). */
  maxPixelRatio: number;
  /** Bloom post-processing ("restrained glow"). */
  bloom: boolean;
  /** Multisample anti-aliasing samples for the post-processing target. */
  msaa: number;
  /** Radial/tubular segment multiplier for procedural geometry. */
  detail: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { maxPixelRatio: 1, bloom: false, msaa: 0, detail: 0.6 },
  medium: { maxPixelRatio: 1.5, bloom: true, msaa: 4, detail: 0.85 },
  high: { maxPixelRatio: 2, bloom: true, msaa: 4, detail: 1 },
};

export interface AutoQualityConfig {
  /** Frame rate the device should sustain (60 desktop, 30 phones). */
  targetFps: number;
  /** Length of one measurement window. */
  windowMs: number;
  /** Consecutive slow windows before stepping down. */
  downAfter: number;
  /** Consecutive fast windows before stepping up. */
  upAfter: number;
  /** After any change, ignore measurements for this long (lets the GPU settle). */
  settleMs: number;
  /** After a step down, do not step back up for this long (prevents oscillation). */
  upgradeCooldownMs: number;
}

export function defaultAutoConfig(targetFps: number): AutoQualityConfig {
  return { targetFps, windowMs: 2000, downAfter: 2, upAfter: 5, settleMs: 3000, upgradeCooldownMs: 45_000 };
}

/**
 * Hysteresis controller: step down when a level clearly misses the target,
 * step up only after sustained headroom, and never retry a level that has
 * already failed more than once (so it cannot flip back and forth).
 */
export class AutoQualityController {
  level: QualityLevel;
  private config: AutoQualityConfig;
  private windowFrames = 0;
  private windowTime = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private settleRemaining: number;
  private sinceDowngrade = Number.POSITIVE_INFINITY;
  private failures: Record<QualityLevel, number> = { low: 0, medium: 0, high: 0 };

  constructor(initial: QualityLevel, config: AutoQualityConfig) {
    this.level = initial;
    this.config = config;
    this.settleRemaining = config.settleMs;
  }

  /** Record one rendered frame; returns the new level when it changes. */
  sample(frameMs: number): QualityLevel | null {
    const c = this.config;
    this.sinceDowngrade += frameMs;
    if (this.settleRemaining > 0) {
      this.settleRemaining -= frameMs;
      return null;
    }
    // Ignore pathological gaps (tab switches, breakpoints).
    if (frameMs > 500) return null;
    this.windowFrames += 1;
    this.windowTime += frameMs;
    if (this.windowTime < c.windowMs) return null;

    const fps = (this.windowFrames * 1000) / this.windowTime;
    this.windowFrames = 0;
    this.windowTime = 0;

    const slow = fps < c.targetFps * 0.8;
    const fast = fps > c.targetFps * 0.97;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    this.fastWindows = fast ? this.fastWindows + 1 : 0;

    if (this.slowWindows >= c.downAfter && this.level !== 'low') {
      this.failures[this.level] += 1;
      return this.change(this.level === 'high' ? 'medium' : 'low', true);
    }
    if (this.fastWindows >= c.upAfter && this.level !== 'high' && this.sinceDowngrade > c.upgradeCooldownMs) {
      const next: QualityLevel = this.level === 'low' ? 'medium' : 'high';
      if (this.failures[next] >= 2) return null;
      return this.change(next, false);
    }
    return null;
  }

  private change(level: QualityLevel, downgrade: boolean): QualityLevel {
    this.level = level;
    this.slowWindows = 0;
    this.fastWindows = 0;
    this.windowFrames = 0;
    this.windowTime = 0;
    this.settleRemaining = this.config.settleMs;
    if (downgrade) this.sinceDowngrade = 0;
    return level;
  }
}

/** A conservative first guess before any measurement. */
export function initialAutoLevel(env: { coarsePointer: boolean; deviceMemoryGb?: number; hardwareConcurrency?: number }): QualityLevel {
  if (env.coarsePointer) return 'low';
  if ((env.deviceMemoryGb ?? 8) <= 4 || (env.hardwareConcurrency ?? 8) <= 4) return 'medium';
  return 'high';
}

/** Objects drawn for a structure at a quality level, from the registry's counts. */
export function drawnCount(drawn: { low: number; medium: number; high: number } | null, level: QualityLevel): number | null {
  return drawn ? drawn[level] : null;
}
