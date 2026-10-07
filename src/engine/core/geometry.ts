import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Simplex3 } from './noise';

export { mergeGeometries };

/** An icosphere scaled to an ellipsoid and displaced along its normals by fractal noise. */
export function noisyEllipsoid(
  radii: THREE.Vector3,
  detail: number,
  noise: Simplex3 | null,
  amplitude = 0,
  frequency = 1,
  octaves = 3,
): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry = mergeVertices(geometry);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = noise ? noise.fbm(v.x * frequency, v.y * frequency, v.z * frequency, octaves) : 0;
    const scale = 1 + n * amplitude;
    pos.setXYZ(i, v.x * radii.x * scale, v.y * radii.y * scale, v.z * radii.z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Radius of an axis-aligned ellipsoid along a unit direction. */
export function ellipsoidRadius(radii: THREE.Vector3, dir: THREE.Vector3): number {
  const x = dir.x / radii.x;
  const y = dir.y / radii.y;
  const z = dir.z / radii.z;
  return 1 / Math.sqrt(x * x + y * y + z * z);
}

/** Is a point inside an axis-aligned ellipsoid (optionally scaled)? */
export function insideEllipsoid(point: THREE.Vector3, center: THREE.Vector3, radii: THREE.Vector3, scale = 1): boolean {
  const x = (point.x - center.x) / (radii.x * scale);
  const y = (point.y - center.y) / (radii.y * scale);
  const z = (point.z - center.z) / (radii.z * scale);
  return x * x + y * y + z * z < 1;
}

/**
 * Ray–ellipsoid intersection. Returns the entry/exit distances (t ≥ 0
 * possible for either) or null when the ray misses.
 */
export function rayEllipsoid(ray: THREE.Ray, center: THREE.Vector3, radii: THREE.Vector3): [number, number] | null {
  const ox = (ray.origin.x - center.x) / radii.x;
  const oy = (ray.origin.y - center.y) / radii.y;
  const oz = (ray.origin.z - center.z) / radii.z;
  const dx = ray.direction.x / radii.x;
  const dy = ray.direction.y / radii.y;
  const dz = ray.direction.z / radii.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

/**
 * Tube along a curve with a radius profile; radius 0 at either end closes it.
 * `radiusAt(u)` receives the curve parameter 0–1. Adds an `aT` attribute
 * (curve parameter per vertex) used by animated shaders.
 */
export function profiledTube(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radialSegments: number,
  radiusAt: (u: number) => number,
  extra?: { attribute: string; value: number },
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const ts: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i++) {
    const u = i / tubularSegments;
    curve.getPointAt(u, p);
    const r = radiusAt(u);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      n.set(cos * N.x + sin * B.x, cos * N.y + sin * B.y, cos * N.z + sin * B.z).normalize();
      positions.push(p.x + r * n.x, p.y + r * n.y, p.z + r * n.z);
      normals.push(n.x, n.y, n.z);
      ts.push(u);
    }
  }
  for (let i = 1; i <= tubularSegments; i++) {
    for (let j = 1; j <= radialSegments; j++) {
      const a = (radialSegments + 1) * (i - 1) + (j - 1);
      const b = (radialSegments + 1) * i + (j - 1);
      const c = (radialSegments + 1) * i + j;
      const d = (radialSegments + 1) * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));
  if (extra) {
    geometry.setAttribute(extra.attribute, new THREE.Float32BufferAttribute(new Array(ts.length).fill(extra.value), 1));
  }
  geometry.setIndex(indices);
  return geometry;
}

/** Radius profile with hemispherical ends for a tube of total arc length `length`. */
export function capsuleProfile(radius: number, length: number): (u: number) => number {
  const capU = Math.min(0.5, radius / Math.max(length, 1e-6));
  return (u: number) => {
    if (u < capU) {
      const s = (capU - u) / capU;
      return radius * Math.sqrt(Math.max(0, 1 - s * s));
    }
    if (u > 1 - capU) {
      const s = (u - (1 - capU)) / capU;
      return radius * Math.sqrt(Math.max(0, 1 - s * s));
    }
    return radius;
  };
}

/** Smooth curve through points (centripetal Catmull–Rom avoids loops). */
export function smoothCurve(points: THREE.Vector3[]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
}

/**
 * A patch of a (displaced) sphere around `center`: used for curved ER sheets
 * and Golgi cisternae. theta = polar angle range, phi = azimuth range,
 * expressed in a local frame whose +Z axis is `axis`.
 */
export function spherePatch(options: {
  center: THREE.Vector3;
  axis: THREE.Vector3;
  radius: number;
  thetaMax: number;
  segments: number;
  noise?: Simplex3;
  amplitude?: number;
  frequency?: number;
  stretch?: THREE.Vector3;
}): THREE.BufferGeometry {
  const { center, axis, radius, thetaMax, segments } = options;
  const geometry = new THREE.SphereGeometry(radius, segments, Math.max(4, Math.round(segments / 2)), 0, Math.PI * 2, 0, thetaMax);
  // SphereGeometry's pole is +Y; rotate it so the patch faces `axis`.
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (options.stretch) v.multiply(options.stretch);
    if (options.noise && options.amplitude) {
      const f = options.frequency ?? 1;
      const d = options.noise.fbm(v.x * f, v.y * f, v.z * f, 2) * options.amplitude;
      v.addScaledVector(v.clone().normalize(), d);
    }
    v.applyQuaternion(quat).add(center);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Build an instance matrix from position, direction (local +Y) and scale. */
const UP = new THREE.Vector3(0, 1, 0);
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
export function orientedMatrix(
  target: THREE.Matrix4,
  position: THREE.Vector3,
  direction: THREE.Vector3,
  scale: number | THREE.Vector3,
  spin = 0,
): THREE.Matrix4 {
  tmpQuat.setFromUnitVectors(UP, direction.clone().normalize());
  if (spin) tmpQuat.multiply(new THREE.Quaternion().setFromAxisAngle(UP, spin));
  if (typeof scale === 'number') tmpScale.setScalar(scale);
  else tmpScale.copy(scale);
  return target.compose(position, tmpQuat, tmpScale);
}

/** Dispose every geometry and material under an object. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => disposeMaterial(m));
    else if (material) disposeMaterial(material);
  });
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}
