import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { blobGeometry } from './common';
import { mergeParts } from './membranesParts';

/**
 * Pieces of the smooth-ER close-up: sampled tube centre-lines (cheap
 * position/frame look-ups for ions and proteins), the junction material with
 * openings where the tubes join, and protein shapes.
 */

export interface TubeSampler {
  length: number;
  /** Point at fraction u (0 = junction end) plus the "up-facing" radial frame. */
  at(u: number, angle: number, radius: number, target: THREE.Vector3, normal?: THREE.Vector3): THREE.Vector3;
  tangent(u: number, target: THREE.Vector3): THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Samples a centre-line once; radial frames are oriented so angle 0 points as close to +y as possible. */
export function sampleTube(curve: THREE.Curve<THREE.Vector3>, samples = 160): TubeSampler {
  const points: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).normalize();
    const n = UP.clone().addScaledVector(t, -UP.dot(t)).normalize();
    const b = new THREE.Vector3().crossVectors(t, n).normalize();
    points.push(p);
    tangents.push(t);
    normals.push(n);
    binormals.push(b);
  }
  const _n = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const lookup = (u: number) => {
    const x = THREE.MathUtils.clamp(u, 0, 1) * samples;
    const i = Math.min(samples - 1, Math.floor(x));
    return { i, f: x - i };
  };
  return {
    length: curve.getLength(),
    at(u, angle, radius, target, normal) {
      const { i, f } = lookup(u);
      _p.copy(points[i]).lerp(points[i + 1], f);
      _n.copy(normals[i]).lerp(normals[i + 1], f).normalize();
      _b.copy(binormals[i]).lerp(binormals[i + 1], f).normalize();
      _d.copy(_n).multiplyScalar(Math.cos(angle)).addScaledVector(_b, Math.sin(angle));
      if (normal) normal.copy(_d);
      return target.copy(_p).addScaledVector(_d, radius);
    },
    tangent(u, target) {
      const { i, f } = lookup(u);
      return target.copy(tangents[i]).lerp(tangents[i + 1], f).normalize();
    },
  };
}

/**
 * Discard the parts of a junction sphere that lie inside the tubes joining it
 * (directions `dirs` from the sphere centre, tube radius `holeRadius`), so the
 * lumens connect without a wall across each opening.
 */
export function addJunctionHoles(material: THREE.Material, dirs: THREE.Vector3[], holeRadius: number): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uHoleDirs = { value: dirs };
    shader.uniforms.uHoleRadius = { value: holeRadius };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vJunctionPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvJunctionPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vJunctionPos;\nuniform vec3 uHoleDirs[3];\nuniform float uHoleRadius;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  for (int i = 0; i < 3; i++) {
    float along = dot(vJunctionPos, uHoleDirs[i]);
    if (along > 0.0 && length(vJunctionPos - along * uHoleDirs[i]) < uHoleRadius) discard;
  }`,
      );
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|junctionHoles`;
}

/**
 * SERCA calcium pump, local +y = out of the membrane into the cytosol, origin
 * on the membrane's outer surface: three-lobed cytosolic head (~6 × 8 nm) on
 * a transmembrane bundle.
 */
export function sercaGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const detail = quality === 'high' ? 2 : 1;
  const parts: THREE.BufferGeometry[] = [];
  const lobe = (r: number, seed: string, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const g = blobGeometry(r, seed, 0.18, detail);
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(g);
  };
  lobe(2.1, 'serca-tm', 0, -2.6, 0, 1, 1.5, 0.95); // transmembrane domain
  lobe(2.4, 'serca-p', 0, 2.2, 0, 1.2, 0.9, 1); // P domain (phosphorylation)
  lobe(2.1, 'serca-n', 0.6, 5.6, 0.4); // N domain (binds ATP)
  lobe(1.8, 'serca-a', -2.6, 3.4, -0.4); // A domain
  return mergeParts(parts);
}

/** One subunit of the tetrameric release channel (IP3 receptor / ryanodine receptor), local +y outward. */
export function releaseSubunitGeometry(quality: QualityLevel, seed: string): THREE.BufferGeometry {
  const detail = quality === 'high' ? 3 : 2;
  const cap = blobGeometry(1, `${seed}:cap`, 0.22, detail);
  cap.scale(5.6, 4.2, 5.2);
  cap.translate(4.4, 7.5, 0);
  const stalk = blobGeometry(1, `${seed}:stalk`, 0.2, detail - 1);
  stalk.scale(2.6, 4.2, 2.6);
  stalk.translate(2.4, 1.6, 0);
  const tm = blobGeometry(1, `${seed}:tm`, 0.18, detail - 1);
  tm.scale(2.2, 3.4, 2.4);
  tm.translate(2.1, -2.6, 0);
  return mergeParts([cap, stalk, tm]);
}
