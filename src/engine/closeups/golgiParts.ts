import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { mergeParts, paint, paramSurface, sstep } from './membranesParts';

/**
 * Golgi cisterna for the stack close-up (1 unit = 10 nm): a flattened,
 * slightly cup-shaped sac lying in the y–z plane (thin along x) with a
 * ~25 nm lumen, a 5 nm membrane and dilated ~60 nm rims. Only the back half
 * (z ≤ 0 plus a sliver for the clipping plane) is built; a cutaway material
 * shows the cut wall as a lighter rim line.
 */
export const CISTERNA = {
  /** Reference radius the geometry is built at (objects are scaled radially). */
  radius: 42,
  lumenHalf: 1.25,
  membrane: 0.5,
  rimRadius: 3,
  /** Rims sit this far toward +x (trans) relative to the centre: the sac is a shallow cup. */
  cup: 4.5,
};

/** Outer half-thickness at distance r from the sac's axis (flat sheet swelling into the rim). */
function halfThickness(r: number): number {
  const { radius, lumenHalf, membrane, rimRadius } = CISTERNA;
  return lumenHalf + membrane + (rimRadius - lumenHalf - membrane) * sstep(radius - 11, radius - rimRadius, r);
}

/**
 * Curvature of the stack: a sac's offset along x at height y (reference
 * frame). It depends on y only, so every slice parallel to the cut has the
 * same C-shaped profile and the lumens read as clean slits from the front.
 */
export function cupOffset(y: number): number {
  const { radius, cup } = CISTERNA;
  const f = Math.min(1, Math.abs(y) / radius);
  return -cup * (1 - f * f);
}

function cupSlope(y: number): number {
  const { radius, cup } = CISTERNA;
  return Math.abs(y) >= radius ? 0 : (2 * cup * y) / (radius * radius);
}

export function cisternaGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const { radius, membrane, rimRadius } = CISTERNA;
  const faceSamples = quality === 'low' ? 18 : quality === 'medium' ? 24 : 30;
  const rimSamples = quality === 'low' ? 10 : 14;
  const around = quality === 'low' ? 26 : quality === 'medium' ? 34 : 44;
  const surface = (inset: number, facing: 1 | -1) => {
    // Closed profile (r, x): top face → rim → bottom face.
    const pr: number[] = [];
    const px: number[] = [];
    const rimCentre = radius - rimRadius;
    for (let i = 0; i <= faceSamples; i++) {
      const r = rimCentre * Math.sqrt(i / faceSamples);
      pr.push(r);
      px.push(halfThickness(r) - inset);
    }
    for (let i = 1; i < rimSamples; i++) {
      const a = Math.PI / 2 - (Math.PI * i) / rimSamples;
      pr.push(rimCentre + (rimRadius - inset) * Math.cos(a));
      px.push((rimRadius - inset) * Math.sin(a));
    }
    for (let i = faceSamples; i >= 0; i--) {
      const r = rimCentre * Math.sqrt(i / faceSamples);
      pr.push(r);
      px.push(-(halfThickness(r) - inset));
    }
    const n = pr.length;
    return paramSurface(around, n - 1, (u, v, p, normal) => {
      const k = Math.round(v * (n - 1));
      const phi = Math.PI - 0.06 + u * (Math.PI + 0.12); // back half (z ≤ 0) and a sliver beyond the cut
      const a = Math.max(0, k - 1);
      const b = Math.min(n - 1, k + 1);
      const dr = pr[b] - pr[a];
      const dx = px[b] - px[a];
      // Clockwise profile: outward normal = tangent turned +90° in the (r, x) plane.
      const nr = -dx;
      const nx = dr;
      const y = pr[k] * Math.cos(phi);
      p.set(px[k] + cupOffset(y), y, pr[k] * Math.sin(phi));
      // Shear x += cupOffset(y): normals transform with the inverse transpose.
      normal.set(nx, nr * Math.cos(phi) - cupSlope(y) * nx, nr * Math.sin(phi)).multiplyScalar(facing);
      if (normal.lengthSq() < 1e-9) normal.set(facing, 0, 0);
    });
  };
  // Vertex colours: the lumen-facing surface is darker, so a cut sac reads as a light rim around its lumen.
  return mergeParts([paint(surface(0, 1), '#ffffff'), paint(surface(membrane, -1), '#6f6a66')]);
}

/** cis (teal-green) → medial → trans (orange) colour for a cisterna at stack position p (0 = cis … 4 = TGN). */
const STOPS = [new THREE.Color('#5fd3c7'), new THREE.Color('#a9d77f'), new THREE.Color('#f2c05a'), new THREE.Color('#ff9e3d'), new THREE.Color('#ff8a3d')];
export function cisternaColor(p: number, target: THREE.Color): THREE.Color {
  const x = THREE.MathUtils.clamp(p, 0, 4);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  return target.copy(STOPS[i]).lerp(STOPS[i + 1], x - i);
}

/** Unit directions of the coat subunits on a vesicle (icosahedron vertices, subdivided once). */
export function coatDirections(): THREE.Vector3[] {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const pos = ico.attributes.position as THREE.BufferAttribute;
  const dirs: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    if (!dirs.some((d) => d.distanceToSquared(v) < 1e-6)) dirs.push(v.clone());
  }
  ico.dispose();
  return dirs;
}
