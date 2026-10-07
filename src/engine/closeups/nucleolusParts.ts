import * as THREE from 'three';
import type { Simplex3 } from '../core/noise';

/**
 * Geometry for the nucleolus slice: flat, textured cut faces (an ellipse for
 * the fibrillar centre and an elliptical ring for the dense fibrillar
 * component) lying in the cut plane z = 0 and facing +z, and shallow bowls
 * that give them depth behind the cut.
 */

export interface EllipseRing {
  center: THREE.Vector3;
  /** Inner semi-axes (x, y); zero for a full disc. */
  inner: THREE.Vector2;
  outer: THREE.Vector2;
}

/** Polar-grid face between two concentric ellipses, with relief and vertex colours. */
export function ellipseFaceGeometry(
  ring: EllipseRing,
  rings: number,
  segments: number,
  relief: (x: number, y: number, t: number) => number,
  color: (x: number, y: number, t: number, target: THREE.Color) => THREE.Color,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  const full = ring.inner.x <= 0;
  const r0 = full ? 1 : 0;
  if (full) {
    positions.push(ring.center.x, ring.center.y, ring.center.z + relief(ring.center.x, ring.center.y, 0));
    color(ring.center.x, ring.center.y, 0, c);
    colors.push(c.r, c.g, c.b);
  }
  for (let i = r0; i <= rings; i++) {
    const t = i / rings;
    const ax = THREE.MathUtils.lerp(ring.inner.x, ring.outer.x, t);
    const ay = THREE.MathUtils.lerp(ring.inner.y, ring.outer.y, t);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const x = ring.center.x + Math.cos(a) * ax;
      const y = ring.center.y + Math.sin(a) * ay;
      positions.push(x, y, ring.center.z + relief(x, y, t));
      color(x, y, t, c);
      colors.push(c.r, c.g, c.b);
    }
  }
  const ringStart = (i: number) => (full ? 1 : 0) + (i - r0) * segments;
  if (full) {
    for (let j = 0; j < segments; j++) indices.push(0, ringStart(1) + j, ringStart(1) + ((j + 1) % segments));
  }
  for (let i = Math.max(r0, full ? 1 : 0); i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = ringStart(i) + j;
      const a2 = ringStart(i) + ((j + 1) % segments);
      const b = ringStart(i + 1) + j;
      const b2 = ringStart(i + 1) + ((j + 1) % segments);
      indices.push(a, b, a2, a2, b, b2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** The back half (z ≤ 0) of an ellipsoid, outer surface, slightly lumpy. */
export function bowlGeometry(center: THREE.Vector3, radii: THREE.Vector3, noise: Simplex3, amplitude: number, segments = 48): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segments, Math.round(segments / 3), 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  g.rotateX(Math.PI / 2);
  g.deleteAttribute('uv');
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.fbm(v.x * 2.2, v.y * 2.2, v.z * 2.2, 2) * amplitude;
    const s = 1 + n * Math.min(1, -v.z * 3);
    pos.setXYZ(i, center.x + v.x * radii.x * s, center.y + v.y * radii.y * s, center.z + v.z * radii.z * s);
  }
  g.computeVertexNormals();
  return g;
}

/** A disc with a noisy outline (the back of the slice and its irregular rim). */
export function noisyDiscGeometry(radius: number, z: number, noise: Simplex3, amplitude: number, segments = 128): THREE.BufferGeometry {
  const positions: number[] = [0, 0, z];
  const indices: number[] = [];
  for (let j = 0; j < segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    const r = radius * (1 + noise.fbm(Math.cos(a) * 1.4, Math.sin(a) * 1.4, 3.7, 3) * amplitude);
    positions.push(Math.cos(a) * r, Math.sin(a) * r, z);
    indices.push(0, 1 + j, 1 + ((j + 1) % segments));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Radius of the slice outline at angle a (matches noisyDiscGeometry). */
export function edgeRadius(radius: number, a: number, noise: Simplex3, amplitude: number): number {
  return radius * (1 + noise.fbm(Math.cos(a) * 1.4, Math.sin(a) * 1.4, 3.7, 3) * amplitude);
}

/** Deterministic 0–1 hash of an integer (per-lineage variation without state). */
export function hash01(n: number, salt = 0): number {
  const s = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
