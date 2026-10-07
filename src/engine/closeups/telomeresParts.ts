import * as THREE from 'three';

/**
 * Nucleic-acid geometry helpers for the telomere close-up (also reused by the
 * nucleolus). Unlike the kit's doubleHelix these work on dense point lists, so
 * a strand can be cut, opened or recoloured base pair by base pair, and the
 * tube resolution is one ring per base pair (long duplexes stay cheap).
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Unit vector perpendicular to `t`. */
function anyPerpendicular(t: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(t.x);
  const ay = Math.abs(t.y);
  const az = Math.abs(t.z);
  if (ax <= ay && ax <= az) target.set(1, 0, 0);
  else if (ay <= az) target.set(0, 1, 0);
  else target.set(0, 0, 1);
  return target.addScaledVector(t, -target.dot(t)).normalize();
}

export interface Frames {
  tangents: THREE.Vector3[];
  normals: THREE.Vector3[];
  binormals: THREE.Vector3[];
}

/** Parallel-transport frames along a polyline (no flips, no Frenet twisting). */
export function polylineFrames(points: THREE.Vector3[], initialNormal?: THREE.Vector3): Frames {
  const n = points.length;
  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(next, prev);
    if (t.lengthSq() < 1e-12) t.copy(i > 0 ? tangents[i - 1] : new THREE.Vector3(1, 0, 0));
    tangents.push(t.normalize());
  }
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const normal = new THREE.Vector3();
    if (i === 0) {
      if (initialNormal) normal.copy(initialNormal).addScaledVector(t, -initialNormal.dot(t)).normalize();
      else anyPerpendicular(t, normal);
    } else {
      normal.copy(normals[i - 1]).addScaledVector(t, -normals[i - 1].dot(t));
      if (normal.lengthSq() < 1e-10) anyPerpendicular(t, normal);
      normal.normalize();
    }
    normals.push(normal);
    binormals.push(new THREE.Vector3().crossVectors(t, normal).normalize());
  }
  return { tangents, normals, binormals };
}

/**
 * A tube through dense points (one ring per point) with optional per-point
 * colours and closed (flat) ends. Seam vertices are shared, normals radial.
 */
export function polylineTube(
  points: THREE.Vector3[],
  radius: number,
  radial: number,
  options: { colors?: THREE.Color[]; caps?: boolean } = {},
): THREE.BufferGeometry {
  const n = points.length;
  const frames = polylineFrames(points);
  const caps = options.caps ?? true;
  const vertexCount = n * radial + (caps ? 2 : 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = options.colors ? new Float32Array(vertexCount * 3) : null;
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const N = frames.normals[i];
    const B = frames.binormals[i];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      _a.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      const k = (i * radial + j) * 3;
      positions[k] = p.x + _a.x * radius;
      positions[k + 1] = p.y + _a.y * radius;
      positions[k + 2] = p.z + _a.z * radius;
      normals[k] = _a.x;
      normals[k + 1] = _a.y;
      normals[k + 2] = _a.z;
      if (colors && options.colors) {
        const c = options.colors[i];
        colors[k] = c.r;
        colors[k + 1] = c.g;
        colors[k + 2] = c.b;
      }
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const a2 = i * radial + ((j + 1) % radial);
      const b = (i + 1) * radial + j;
      const b2 = (i + 1) * radial + ((j + 1) % radial);
      indices.push(a, a2, b, a2, b2, b);
    }
  }
  if (caps) {
    for (const end of [0, 1]) {
      const i = end ? n - 1 : 0;
      const center = n * radial + end;
      const t = frames.tangents[i];
      const k = center * 3;
      positions[k] = points[i].x;
      positions[k + 1] = points[i].y;
      positions[k + 2] = points[i].z;
      const s = end ? 1 : -1;
      normals[k] = t.x * s;
      normals[k + 1] = t.y * s;
      normals[k + 2] = t.z * s;
      if (colors && options.colors) {
        const c = options.colors[i];
        colors[k] = c.r;
        colors[k + 1] = c.g;
        colors[k + 2] = c.b;
      }
      for (let j = 0; j < radial; j++) {
        const a = i * radial + j;
        const a2 = i * radial + ((j + 1) % radial);
        if (end) indices.push(center, a, a2);
        else indices.push(center, a2, a);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

export interface DuplexFrames {
  count: number;
  centers: THREE.Vector3[];
  tangents: THREE.Vector3[];
  normals: THREE.Vector3[];
  binormals: THREE.Vector3[];
  /** Backbone position of strand 0/1 at base pair i. */
  strand(strand: 0 | 1, index: number, target?: THREE.Vector3): THREE.Vector3;
}

/**
 * Base-pair frames of a right-handed B-DNA duplex along a curve: centres every
 * `rise` nm, backbones at `radius` from the axis, the second strand `offset`
 * radians round (≈2.4 gives major and minor grooves).
 */
export function duplexFrames(curve: THREE.Curve<THREE.Vector3>, options: { rise?: number; radius?: number; bpPerTurn?: number; offset?: number } = {}): DuplexFrames {
  const rise = options.rise ?? 0.34;
  const radius = options.radius ?? 1;
  const bpPerTurn = options.bpPerTurn ?? 10.5;
  const offset = options.offset ?? 2.4;
  const length = curve.getLength();
  const count = Math.max(2, Math.floor(length / rise));
  const centers: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) centers.push(curve.getPointAt((i + 0.5) / count));
  const frames = polylineFrames(centers);
  return {
    count,
    centers,
    ...frames,
    strand(strand, index, target = new THREE.Vector3()) {
      const a = ((index + 0.5) / bpPerTurn) * Math.PI * 2 + strand * offset;
      _b.copy(frames.normals[index]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[index], Math.sin(a));
      return target.copy(centers[index]).addScaledVector(_b, radius);
    },
  };
}

/** Arc length of a polyline. */
export function polylineLength(points: THREE.Vector3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += points[i].distanceTo(points[i - 1]);
  return length;
}

/** Smooth curve through points with an arc-length table fine enough for molecular spacing. */
export function fineCurve(points: THREE.Vector3[], resolution = 0.05): THREE.CatmullRomCurve3 {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  curve.arcLengthDivisions = Math.max(200, Math.ceil((polylineLength(points) * 1.3) / resolution));
  return curve;
}
