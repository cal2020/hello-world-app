import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { rngFor } from '../core/random';
import { ellipsoidRadius, insideEllipsoid, smoothCurve } from '../core/geometry';

/**
 * The deliberate, reproducible arrangement of the model cell. All lengths are
 * micrometres (1 scene unit = 1 µm). Every placement uses a named seeded
 * stream, so the cell is identical on every visit.
 *
 * Arrangement (illustrative, based on a generic interphase cell):
 *  - rounded cell ≈14 µm wide; nucleus ≈6 µm, slightly off-centre;
 *  - the centrosome sits beside the nucleus; the Golgi ribbon wraps around it
 *    with cis faces toward the nucleus and trans faces outward;
 *  - rough-ER sheets are stacked around the nucleus (continuous with the
 *    outer nuclear membrane) and give way to a smooth-ER tubular network;
 *  - microtubules radiate from the centrosome; actin lines the cortex;
 *    intermediate filaments form a perinuclear cage reaching the cortex.
 */

export interface Sphere {
  center: THREE.Vector3;
  radius: number;
}

export interface MitoPlacement {
  curve: THREE.CatmullRomCurve3;
  radius: number;
  length: number;
}

export interface EndosomePlacement {
  center: THREE.Vector3;
  radius: number;
  late: boolean;
  arms: Array<{ dir: THREE.Vector3; length: number }>;
}

export interface Territory {
  /** Chromosome number 1–23 (23 = X). */
  chromosome: number;
  homolog: 0 | 1;
  center: THREE.Vector3;
  radius: number;
  inactiveX: boolean;
  path: THREE.Vector3[];
}

export interface ErLayer {
  offset: number;
  radii: THREE.Vector3;
  /** Alpha mask (equirectangular, matches SphereGeometry UVs): 1 = membrane, 0 = hole/gap. */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

export interface SmoothErGraph {
  nodes: THREE.Vector3[];
  edges: Array<[number, number]>;
  /** Connectors from rough-ER sheet edges to network nodes. */
  connectors: Array<[THREE.Vector3, number]>;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Gene-dense chromosomes tend to lie toward the nuclear interior and gene-poor
// ones toward the periphery; this approximate order (most central first) is
// used only to arrange territories plausibly in the illustration.
const RADIAL_ORDER = [19, 17, 22, 16, 20, 1, 11, 15, 12, 14, 3, 6, 9, 7, 10, 2, 8, 21, 5, 13, 23, 4, 18];

export class CellLayout {
  readonly cellCenter = V(0, 0, 0);
  readonly cellRadii = V(7.0, 6.2, 6.6);
  readonly cellNoise = new Simplex3('membrane');
  readonly cellNoiseAmplitude = 0.035;
  readonly cellNoiseFrequency = 1.25;

  readonly nucleusCenter = V(-0.55, 0.25, -0.35);
  readonly nucleusRadii = V(3.05, 2.7, 2.9);
  readonly envelopeGap = 0.045;

  readonly hub = V(1.0, 0.32, 0.55).normalize();
  readonly centrosome: THREE.Vector3;
  readonly centrioleAxes: [THREE.Vector3, THREE.Vector3];

  readonly nucleoli: Sphere[];
  readonly golgiStacks: Array<{ center: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3; size: number }>;
  readonly erLayers: ErLayer[];
  readonly obstacles: Sphere[] = [];
  readonly mitochondria: MitoPlacement[];
  readonly lysosomes: Sphere[];
  readonly peroxisomes: Sphere[];
  readonly endosomes: EndosomePlacement[];
  readonly microtubules: THREE.CatmullRomCurve3[];
  readonly smoothEr: SmoothErGraph;
  readonly territories: Territory[];
  /** Derived data shared between structure modules (e.g. nuclear pore positions). */
  readonly cache = new Map<string, unknown>();

  constructor() {
    const nucleusAlongHub = ellipsoidRadius(this.nucleusRadii, this.hub);
    this.centrosome = this.nucleusCenter.clone().addScaledVector(this.hub, nucleusAlongHub + 0.85);
    const motherAxis = V(0.2, 1, -0.35).normalize();
    const daughterAxis = new THREE.Vector3().crossVectors(motherAxis, this.hub).normalize();
    this.centrioleAxes = [motherAxis, daughterAxis];

    this.nucleoli = [
      { center: this.nucleusCenter.clone().add(V(0.55, 0.6, 0.55)), radius: 0.85 },
      { center: this.nucleusCenter.clone().add(V(-1.25, -0.55, 0.7)), radius: 0.45 },
    ];

    this.obstacles.push({ center: this.centrosome.clone(), radius: 0.55 });
    this.golgiStacks = this.placeGolgi();
    for (const stack of this.golgiStacks) {
      this.obstacles.push({ center: stack.center.clone().addScaledVector(stack.normal, 0.15), radius: 0.8 });
    }
    this.erLayers = this.buildErLayers();
    this.mitochondria = this.placeMitochondria(60);
    this.endosomes = this.placeEndosomes();
    this.lysosomes = this.placeSpheres('lysosomes', 30, 0.14, 0.3, 0.3, 0.84);
    this.peroxisomes = this.placeSpheres('peroxisomes', 28, 0.1, 0.19, 0.3, 0.88);
    this.microtubules = this.buildMicrotubules(160);
    this.smoothEr = this.buildSmoothEr();
    this.territories = this.buildTerritories();
  }

  // ── Geometry queries ─────────────────────────────────────────────────────

  /** Membrane radius (from the cell centre) along a unit direction, including surface noise. */
  membraneRadius(dir: THREE.Vector3): number {
    const n = this.cellNoise.fbm(dir.x * this.cellNoiseFrequency, dir.y * this.cellNoiseFrequency, dir.z * this.cellNoiseFrequency, 3);
    return ellipsoidRadius(this.cellRadii, dir) * (1 + n * this.cellNoiseAmplitude);
  }

  nucleusRadius(dir: THREE.Vector3): number {
    return ellipsoidRadius(this.nucleusRadii, dir);
  }

  /** Relative depth inside the cell: 0 at the centre, 1 at the membrane. */
  relativeRadius(point: THREE.Vector3): number {
    const d = point.clone().sub(this.cellCenter);
    const len = d.length();
    if (len < 1e-6) return 0;
    return len / this.membraneRadius(d.divideScalar(len));
  }

  /** Distance from the nuclear surface (negative inside). */
  nucleusClearance(point: THREE.Vector3): number {
    const d = point.clone().sub(this.nucleusCenter);
    const len = d.length();
    if (len < 1e-6) return -this.nucleusRadii.y;
    return len - this.nucleusRadius(d.divideScalar(len));
  }

  inCytoplasm(point: THREE.Vector3, nucleusMargin: number, membraneScale: number): boolean {
    return this.nucleusClearance(point) > nucleusMargin && this.relativeRadius(point) < membraneScale;
  }

  isFree(center: THREE.Vector3, radius: number, pad = 0.06): boolean {
    for (const o of this.obstacles) {
      if (o.center.distanceTo(center) < o.radius + radius + pad) return false;
    }
    return true;
  }

  private occupy(center: THREE.Vector3, radius: number): void {
    this.obstacles.push({ center: center.clone(), radius });
  }

  // ── Placement ────────────────────────────────────────────────────────────

  private placeGolgi() {
    const rng = rngFor('golgi');
    const u = this.hub.clone();
    const v = new THREE.Vector3().crossVectors(u, V(0, 1, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(v, u).normalize();
    const stacks = [];
    for (const angle of [-0.95, 0, 0.95]) {
      const dir = u
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(v, Math.sin(angle))
        .addScaledVector(w, rng.range(-0.12, 0.12))
        .normalize();
      const center = this.centrosome.clone().addScaledVector(dir, 1.05);
      const tangent = new THREE.Vector3().crossVectors(dir, w).normalize();
      stacks.push({ center, normal: dir, tangent, size: rng.range(1.05, 1.25) });
    }
    return stacks;
  }

  private buildErLayers(): ErLayer[] {
    const offsets = [0.32, 0.6, 0.88, 1.16];
    const noise = new Simplex3('er-mask');
    const width = 256;
    const height = 128;
    const hubCos = Math.cos((50 * Math.PI) / 180);
    const dir = new THREE.Vector3();
    return offsets.map((offset, layerIndex) => {
      const mask = new Uint8Array(width * height);
      // Outer layers are sparser; small round holes are fenestrations.
      const coverage = [0.62, 0.42, 0.25, 0.12][layerIndex];
      for (let y = 0; y < height; y++) {
        const theta = ((y + 0.5) / height) * Math.PI;
        for (let x = 0; x < width; x++) {
          const phi = ((x + 0.5) / width) * Math.PI * 2;
          // Matches THREE.SphereGeometry vertex placement.
          dir.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
          const large = noise.fbm(dir.x * 1.4 + layerIndex * 7.1, dir.y * 1.4, dir.z * 1.4, 3);
          const holes = noise.noise(dir.x * 9 + layerIndex * 3.3, dir.y * 9, dir.z * 9);
          const nearHub = dir.dot(this.hub) > hubCos;
          const membrane = large > 0.5 - coverage && holes < 0.45 && !nearHub;
          mask[y * width + x] = membrane ? 255 : 0;
        }
      }
      const radii = this.nucleusRadii.clone().addScalar(offset);
      return { offset, radii, mask, maskWidth: width, maskHeight: height };
    });
  }

  /** Sample an ER layer mask at a direction from the nucleus centre. */
  erMaskAt(layer: ErLayer, dir: THREE.Vector3): boolean {
    const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
    let phi = Math.atan2(dir.z, -dir.x);
    if (phi < 0) phi += Math.PI * 2;
    const x = Math.min(layer.maskWidth - 1, Math.floor((phi / (Math.PI * 2)) * layer.maskWidth));
    const y = Math.min(layer.maskHeight - 1, Math.floor((theta / Math.PI) * layer.maskHeight));
    return layer.mask[y * layer.maskWidth + x] > 127;
  }

  private placeMitochondria(count: number): MitoPlacement[] {
    const rng = rngFor('mitochondria');
    const result: MitoPlacement[] = [];
    let attempts = 0;
    while (result.length < count && attempts < 6000) {
      attempts++;
      const start = rng.inBall().multiply(this.cellRadii);
      if (!this.inCytoplasm(start, 1.35, 0.84)) continue;
      const length = rng.range(1.2, 3.1);
      const radius = rng.range(0.23, 0.29);
      // Roughly tangential direction so mitochondria follow the cell's curvature.
      const radial = start.clone().sub(this.cellCenter).normalize();
      const dir = rng.direction();
      dir.addScaledVector(radial, -dir.dot(radial) * 0.8).normalize();
      const points: THREE.Vector3[] = [];
      const segments = 4;
      const bend = rng.direction().multiplyScalar(0.35);
      let ok = true;
      for (let i = 0; i <= segments; i++) {
        const s = (i / segments) * length;
        const p = start.clone().addScaledVector(dir, s).addScaledVector(bend, Math.sin((i / segments) * Math.PI) * (length / 3));
        if (!this.inCytoplasm(p, 1.2, 0.86) || !this.isFree(p, radius)) {
          ok = false;
          break;
        }
        points.push(p);
      }
      if (!ok) continue;
      const curve = smoothCurve(points);
      result.push({ curve, radius, length: curve.getLength() });
      for (let i = 0; i <= 6; i++) this.occupy(curve.getPointAt(i / 6), radius + 0.05);
    }
    return result;
  }

  private placeSpheres(label: string, count: number, rMin: number, rMax: number, relMin: number, relMax: number): Sphere[] {
    const rng = rngFor(label);
    const out: Sphere[] = [];
    let attempts = 0;
    while (out.length < count && attempts < 8000) {
      attempts++;
      const p = rng.inBall().multiply(this.cellRadii);
      const rel = this.relativeRadius(p);
      if (rel < relMin || rel > relMax) continue;
      const radius = rng.range(rMin, rMax);
      if (this.nucleusClearance(p) < 1.3 + radius) continue;
      if (!this.isFree(p, radius)) continue;
      out.push({ center: p, radius });
      this.occupy(p, radius);
    }
    return out;
  }

  private placeEndosomes(): EndosomePlacement[] {
    const rng = rngFor('endosomes');
    const out: EndosomePlacement[] = [];
    let attempts = 0;
    while (out.length < 26 && attempts < 8000) {
      attempts++;
      const late = out.length >= 16;
      const p = rng.inBall().multiply(this.cellRadii);
      const rel = this.relativeRadius(p);
      if (late ? rel < 0.42 || rel > 0.7 : rel < 0.74 || rel > 0.9) continue;
      const radius = late ? rng.range(0.26, 0.34) : rng.range(0.16, 0.24);
      if (this.nucleusClearance(p) < 1.3 + radius || !this.isFree(p, radius + 0.1)) continue;
      const arms: EndosomePlacement['arms'] = [];
      if (!late) {
        const armCount = rng.int(1, 2);
        for (let i = 0; i < armCount; i++) arms.push({ dir: rng.direction(), length: rng.range(0.35, 0.65) });
      }
      out.push({ center: p, radius, late, arms });
      this.occupy(p, radius + 0.1);
    }
    return out;
  }

  private buildMicrotubules(count: number): THREE.CatmullRomCurve3[] {
    const rng = rngFor('microtubules');
    const curves: THREE.CatmullRomCurve3[] = [];
    const dir = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // Fibonacci-like spread with jitter so microtubules fill all directions.
      const k = i + 0.5;
      const y = 1 - (2 * k) / count;
      const r = Math.sqrt(1 - y * y);
      const a = k * 2.399963229728653 + rng.range(-0.15, 0.15);
      dir.set(Math.cos(a) * r, y, Math.sin(a) * r).normalize();
      const points: THREE.Vector3[] = [this.centrosome.clone().addScaledVector(dir, 0.3)];
      const p = points[0].clone();
      const heading = dir.clone();
      const wander = rng.direction().multiplyScalar(0.06);
      for (let step = 0; step < 40; step++) {
        heading.add(wander).normalize();
        p.addScaledVector(heading, 0.45);
        // Bend around the nucleus.
        const clearance = this.nucleusClearance(p);
        if (clearance < 0.3) {
          const out = p.clone().sub(this.nucleusCenter).normalize();
          p.addScaledVector(out, 0.3 - clearance);
          heading.addScaledVector(out, 0.5).normalize();
        }
        if (this.relativeRadius(p) > 0.94) break;
        points.push(p.clone());
      }
      if (points.length >= 3) curves.push(smoothCurve(points));
    }
    return curves;
  }

  private buildSmoothEr(): SmoothErGraph {
    const rng = rngFor('smooth-er');
    const nodes: THREE.Vector3[] = [];
    let attempts = 0;
    while (nodes.length < 120 && attempts < 9000) {
      attempts++;
      const p = rng.inBall().multiply(this.cellRadii);
      if (!this.inCytoplasm(p, 1.55, 0.9)) continue;
      if (!this.isFree(p, 0.08, 0.02)) continue;
      if (nodes.some((n) => n.distanceTo(p) < 0.7)) continue;
      nodes.push(p);
    }
    const edges: Array<[number, number]> = [];
    const degree = new Array(nodes.length).fill(0);
    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const neighbours = nodes
        .map((n, j) => ({ j, d: n.distanceTo(nodes[i]) }))
        .filter((x) => x.j !== i && x.d < 1.45)
        .sort((a, b) => a.d - b.d);
      for (const { j } of neighbours) {
        if (degree[i] >= 3) break;
        if (degree[j] >= 3) continue;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([i, j]);
        degree[i]++;
        degree[j]++;
      }
    }
    // Connect the outer rough-ER sheets to the network (one continuous ER).
    const connectors: Array<[THREE.Vector3, number]> = [];
    const layer = this.erLayers[this.erLayers.length - 1];
    const inner = this.erLayers[this.erLayers.length - 2];
    const dir = new THREE.Vector3();
    let tries = 0;
    while (connectors.length < 18 && tries < 4000) {
      tries++;
      rng.direction(dir);
      const useLayer = rng.chance(0.5) ? layer : inner;
      if (!this.erMaskAt(useLayer, dir)) continue;
      // Same parameterisation as the sheet geometry: unit direction scaled by the layer radii.
      const point = this.nucleusCenter.clone().add(dir.clone().multiply(useLayer.radii));
      let best = -1;
      let bestD = Infinity;
      nodes.forEach((n, j) => {
        const d = n.distanceTo(point);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (best >= 0 && bestD < 1.7) connectors.push([point, best]);
    }
    return { nodes, edges, connectors };
  }

  private buildTerritories(): Territory[] {
    const rng = rngFor('chromosomes');
    const territories: Territory[] = [];
    // Relative DNA content (approximate chromosome sizes, chromosome 1 = 1).
    const size = (c: number) => {
      const mb = [248, 242, 198, 190, 181, 171, 159, 145, 138, 134, 135, 133, 114, 107, 102, 90, 83, 80, 59, 64, 47, 51, 156][c - 1];
      return mb / 248;
    };
    const slots: Array<{ chromosome: number; homolog: 0 | 1; inactiveX: boolean }> = [];
    for (const c of RADIAL_ORDER) {
      slots.push({ chromosome: c, homolog: 0, inactiveX: false });
      slots.push({ chromosome: c, homolog: 1, inactiveX: c === 23 });
    }
    // Initial centres: inner order for gene-dense chromosomes; then relax.
    const centers = slots.map((slot, i) => {
      const order = i / slots.length;
      const radial = slot.inactiveX ? 0.86 : 0.25 + order * 0.55;
      const d = rng.direction();
      return this.nucleusCenter.clone().add(d.multiply(this.nucleusRadii).multiplyScalar(radial));
    });
    const radii = slots.map((slot) => (slot.inactiveX ? 0.36 : 0.5 + 0.38 * Math.cbrt(size(slot.chromosome))));
    for (let iter = 0; iter < 60; iter++) {
      for (let i = 0; i < centers.length; i++) {
        for (let j = i + 1; j < centers.length; j++) {
          const delta = centers[j].clone().sub(centers[i]);
          const dist = delta.length();
          const min = (radii[i] + radii[j]) * 0.82;
          if (dist < min && dist > 1e-5) {
            const push = delta.multiplyScalar(((min - dist) / dist) * 0.5);
            centers[i].sub(push);
            centers[j].add(push);
          }
        }
        // Keep inside the nucleus and out of the nucleoli.
        const fromN = centers[i].clone().sub(this.nucleusCenter);
        const dir = fromN.clone().normalize();
        const maxR = this.nucleusRadius(dir) - radii[i] * 0.75 - 0.08;
        if (fromN.length() > maxR) centers[i].copy(this.nucleusCenter).addScaledVector(dir, maxR);
        for (const nucleolus of this.nucleoli) {
          const off = centers[i].clone().sub(nucleolus.center);
          const min = nucleolus.radius + radii[i] * 0.55;
          if (off.length() < min) centers[i].copy(nucleolus.center).addScaledVector(off.normalize(), min);
        }
      }
    }
    slots.forEach((slot, i) => {
      const center = centers[i];
      const radius = radii[i];
      const steps = slot.inactiveX ? 150 : Math.round(70 + 120 * size(slot.chromosome));
      const stepLength = slot.inactiveX ? 0.05 : 0.11;
      const walk: THREE.Vector3[] = [];
      const p = center.clone().add(rng.direction().multiplyScalar(radius * 0.4));
      const heading = rng.direction();
      for (let s = 0; s < steps; s++) {
        heading.add(rng.direction().multiplyScalar(0.9)).normalize();
        p.addScaledVector(heading, stepLength);
        const off = p.clone().sub(center);
        if (off.length() > radius) {
          p.copy(center).addScaledVector(off.normalize(), radius);
          heading.addScaledVector(off, -1.2).normalize();
        }
        // Stay inside the nuclear envelope.
        const clearance = this.nucleusClearance(p);
        if (clearance > -0.1) p.addScaledVector(p.clone().sub(this.nucleusCenter).normalize(), -0.1 - clearance);
        if (s % 2 === 0) walk.push(p.clone());
      }
      territories.push({ chromosome: slot.chromosome, homolog: slot.homolog, center, radius, inactiveX: slot.inactiveX, path: walk });
    });
    return territories;
  }

  /** A point on the membrane for a direction from the cell centre (scaled inward by `inset`). */
  membranePoint(dir: THREE.Vector3, inset = 1): THREE.Vector3 {
    const d = dir.clone().normalize();
    return this.cellCenter.clone().addScaledVector(d, this.membraneRadius(d) * inset);
  }

  insideNucleus(point: THREE.Vector3, scale = 1): boolean {
    return insideEllipsoid(point, this.nucleusCenter, this.nucleusRadii, scale);
  }
}
