import * as THREE from 'three';

/**
 * Seeded pseudo-random numbers (mulberry32). Every procedural structure takes
 * its own named stream, so the cell is identical on every visit and adding a
 * structure never reshuffles the others.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Standard normal deviate (Box–Muller). */
  gaussian(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Uniform direction on the unit sphere. */
  direction(target = new THREE.Vector3()): THREE.Vector3 {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return target.set(r * Math.cos(a), r * Math.sin(a), z);
  }

  /** Uniform point inside the unit ball. */
  inBall(target = new THREE.Vector3()): THREE.Vector3 {
    this.direction(target);
    return target.multiplyScalar(Math.cbrt(this.next()));
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /** A child stream with an independent sequence. */
  fork(label: string): Rng {
    return new Rng(hashString(`${this.state}:${label}`));
  }
}

export function hashString(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The master seed for the model cell. Changing it produces a different (but still reproducible) cell. */
export const CELL_SEED = 'human-cell-atlas/v1';

export function rngFor(label: string): Rng {
  return new Rng(`${CELL_SEED}/${label}`);
}
