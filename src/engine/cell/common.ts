import * as THREE from 'three';
import { structure } from '../../content/registry';
import type { StructureId } from '../../content/types';
import type { QualityLevel } from '../../app/quality';
import { disposeObject } from '../core/geometry';
import type { StructureInstance } from './types';

export function colorOf(id: StructureId): THREE.Color {
  return new THREE.Color(structure(id).color);
}

export function drawnFor(id: StructureId, level: QualityLevel): number | null {
  const drawn = structure(id).model.drawn;
  return drawn ? drawn[level] : null;
}

/** Defaults for the StructureInstance interface; modules override what they need. */
export function makeInstance(
  id: StructureId,
  root: THREE.Object3D,
  parts: Partial<StructureInstance> & Pick<StructureInstance, 'raycast' | 'framing' | 'labelAnchors'>,
): StructureInstance {
  root.name = id;
  return {
    id,
    root,
    focus: [],
    overviewOpacity: 1,
    partAnchors: () => [],
    update: () => {},
    setQuality: () => null,
    setFocused: () => {},
    dispose: () => disposeObject(root),
    ...parts,
  };
}

const sphereTmp = new THREE.Vector3();

/** Nearest ray–sphere hit distance (front surface), or null. */
export function raySphere(ray: THREE.Ray, center: THREE.Vector3, radius: number): number | null {
  sphereTmp.subVectors(center, ray.origin);
  const tca = sphereTmp.dot(ray.direction);
  const d2 = sphereTmp.lengthSq() - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  const t1 = tca + thc;
  if (t1 < 0) return null;
  return t0 >= 0 ? t0 : t1;
}

/** Nearest hit among many spheres (packed positions), honouring `count`. */
export function rayPoints(ray: THREE.Ray, positions: ArrayLike<number>, count: number, radius: number | ((i: number) => number)): number | null {
  let best: number | null = null;
  const c = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    c.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const r = typeof radius === 'number' ? radius : radius(i);
    const t = raySphere(ray, c, r);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export function raySpheres(ray: THREE.Ray, spheres: Array<{ center: THREE.Vector3; radius: number }>, count = spheres.length, scale = 1): number | null {
  let best: number | null = null;
  for (let i = 0; i < count; i++) {
    const t = raySphere(ray, spheres[i].center, spheres[i].radius * scale);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

const raycaster = new THREE.Raycaster();
export function rayObjects(ray: THREE.Ray, objects: THREE.Object3D[]): number | null {
  raycaster.ray.copy(ray);
  raycaster.near = 0;
  raycaster.far = Infinity;
  const hits = raycaster.intersectObjects(objects, false);
  return hits.length ? hits[0].distance : null;
}

/** Sample points along curves for picking thin filaments. */
export function sampleCurves(curves: THREE.Curve<THREE.Vector3>[], spacing: number): { points: Float32Array; owner: Uint16Array; t: Float32Array } {
  const pts: number[] = [];
  const owner: number[] = [];
  const ts: number[] = [];
  curves.forEach((curve, index) => {
    const n = Math.max(2, Math.ceil(curve.getLength() / spacing));
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      pts.push(p.x, p.y, p.z);
      owner.push(index);
      ts.push(i / n);
    }
  });
  return { points: new Float32Array(pts), owner: new Uint16Array(owner), t: new Float32Array(ts) };
}

/** A soft round sprite texture (glows, particles). */
let glowTexture: THREE.Texture | null = null;
export function softDotTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a * a);
    }
  }
  glowTexture = new THREE.DataTexture(data, size, size);
  glowTexture.needsUpdate = true;
  return glowTexture;
}

/** Smooth 0→1→0 pulse used by event animations. */
export function pulse(x: number): number {
  return Math.sin(Math.PI * THREE.MathUtils.clamp(x, 0, 1));
}

export function easeInOut(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
