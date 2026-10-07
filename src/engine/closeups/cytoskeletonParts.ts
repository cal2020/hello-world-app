import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { Simplex3 } from '../core/noise';
import { noisyEllipsoid } from '../core/geometry';
import { MICROTUBULE, microtubuleLattice, type MicrotubuleLattice } from './kit';

/**
 * Helpers shared by the cytoskeleton close-ups (kinesin, microtubule dynamics,
 * actin, intermediate filaments, centrosome). Everything here is allocation
 * free after construction so it can run every frame.
 */

/** One tubulin dimer repeat along a protofilament (2 × 4.05 nm). */
export const DIMER_REPEAT = MICROTUBULE.monomer * 2;
/** Angle between neighbouring protofilaments. */
export const PF_ANGLE = (Math.PI * 2) / MICROTUBULE.protofilaments;

/**
 * A tubulin monomer: a smooth, slightly lumpy body ≈ 4.8 nm radially and
 * 4.6 nm along the protofilament (so monomers merge into a continuous strand)
 * and around the tube (leaving a shallow groove between protofilaments). Local x = radial (outward), y =
 * along the microtubule axis, z = around the tube.
 */
export function tubulinGeometry(quality: QualityLevel, seed: string): THREE.BufferGeometry {
  const detail = quality === 'high' ? 2 : 1;
  return noisyEllipsoid(new THREE.Vector3(2.4, 2.3, 2.3), detail, new Simplex3(seed), 0.08, 1.4, 2);
}

/**
 * Monomer placement on a 13-protofilament microtubule (axis +y, minus end at
 * y = 0): straight positions come from the kit's `microtubuleLattice`; this
 * adds each monomer's orientation (local x facing outward) and the outward
 * curl of a peeling protofilament, without allocating per call.
 */
export class TubulinPlacer {
  private readonly lattice: MicrotubuleLattice = microtubuleLattice();
  private readonly m4 = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly radial = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly qBase = new THREE.Quaternion();
  private readonly qCurl = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);

  /**
   * Local transform of monomer `m` (0 = α of dimer 0) of protofilament `pf`.
   * Monomers beyond `curlFrom` bend outward by `curl` radians each (a
   * "ram's horn"); `scale` shrinks the monomer (appearing / disappearing).
   */
  matrix(pf: number, m: number, curl: number, curlFrom: number, scale: number, target: THREE.Matrix4): THREE.Matrix4 {
    const angle = pf * PF_ANGLE;
    this.radial.set(Math.cos(angle), 0, Math.sin(angle));
    this.tangent.set(-Math.sin(angle), 0, Math.cos(angle));
    // Orientation: local x → radial, local z → tangent.
    this.qBase.setFromAxisAngle(this.yAxis, -angle);
    if (m <= curlFrom || curl === 0) {
      this.lattice.monomer(pf, m, 0, Infinity, this.m4);
      this.p.setFromMatrixPosition(this.m4);
      this.s.setScalar(scale);
      return target.compose(this.p, this.qBase, this.s);
    }
    // Same walk as the kit's curl, re-implemented without per-call allocation.
    this.lattice.monomer(pf, curlFrom, 0, Infinity, this.m4);
    this.p.setFromMatrixPosition(this.m4);
    const steps = m - curlFrom;
    const whole = Math.floor(steps);
    this.dir.set(0, 1, 0);
    for (let k = 0; k < whole; k++) {
      this.dir.applyAxisAngle(this.tangent, -curl).normalize();
      this.p.addScaledVector(this.dir, MICROTUBULE.monomer);
    }
    const frac = steps - whole;
    if (frac > 1e-6) {
      this.dir.applyAxisAngle(this.tangent, -curl * frac).normalize();
      this.p.addScaledVector(this.dir, MICROTUBULE.monomer * frac);
    }
    this.qCurl.setFromAxisAngle(this.tangent, -curl * steps);
    this.qCurl.multiply(this.qBase);
    this.s.setScalar(scale);
    return target.compose(this.p, this.qCurl, this.s);
  }

  /** Centre of a monomer (same placement as `matrix`). */
  position(pf: number, m: number, curl: number, curlFrom: number, target: THREE.Vector3): THREE.Vector3 {
    this.matrix(pf, m, curl, curlFrom, 1, this.m4);
    return target.setFromMatrixPosition(this.m4);
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();

/**
 * Instance matrix for a unit segment geometry (along +y, centred, length 1)
 * stretched between two points with a given thickness scale.
 */
export function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, thickness: number, target: THREE.Matrix4): THREE.Matrix4 {
  _d.subVectors(b, a);
  const length = _d.length();
  if (length < 1e-6) return target.makeScale(0, 0, 0);
  _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / length));
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _sc.set(thickness, length, thickness);
  return target.compose(_mid, _q, _sc);
}

/** Smooth 0→1 ramp of x over [a, b] (either order). */
export function ramp(x: number, a: number, b: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Positive modulo. */
export function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** Deterministic hash in [0, 1) for integer-ish inputs (pure function, no state). */
export function hash01(a: number, b = 0, c = 0): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}
