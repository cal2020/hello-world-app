import * as THREE from 'three';
import { mergeGeometries } from '../core/geometry';
import type { Rng } from '../core/random';

/**
 * Small helpers shared by the membrane-system close-ups (plasma membrane,
 * nucleus, rough ER, smooth ER, Golgi).
 */

/** Low-poly ball with smooth (radial) normals: 'octa' = 8 triangles, 0 = 20, 1 = 80, 2 = 320. */
export function ballGeometry(detail: 'octa' | 0 | 1 | 2): THREE.BufferGeometry {
  const g = detail === 'octa' ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    normals.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Merge geometries of mixed kinds (indexed or not): keeps position + normal (+ color if all have it). */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const withColor = parts.every((p) => p.getAttribute('color'));
  const prepared = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && !(withColor && name === 'color')) g.deleteAttribute(name);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(prepared)!;
  prepared.forEach((g) => g.dispose());
  parts.forEach((g) => g.dispose());
  return merged;
}

/** Paint a whole geometry one vertex colour (so it can be merged with banded parts). */
export function paint(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export interface GlowPoints {
  points: THREE.Points;
  /** xyz per particle; edit, then call `commit()`. */
  positions: Float32Array;
  /** 0–1 visibility per particle. */
  alphas: Float32Array;
  commit(): void;
  dispose(): void;
}

/**
 * Additive glowing dots sized in scene units (like kit.sparks). Extra options:
 * an overall `opacity`, `depthTest: false` for an "x-ray" copy that shows
 * particles through the protein they pass through, and `share` to reuse the
 * position buffer of another set (the copy keeps its own alphas).
 */
export function glowPoints(options: {
  count: number;
  color: THREE.ColorRepresentation;
  size: number;
  pointScale: { value: number };
  opacity?: number;
  depthTest?: boolean;
  share?: GlowPoints;
}): GlowPoints {
  const positions = options.share ? options.share.positions : new Float32Array(options.count * 3);
  const alphas = new Float32Array(options.count).fill(1);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const alphaAttribute = new THREE.BufferAttribute(alphas, 1);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  alphaAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aAlpha', alphaAttribute);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(options.color) },
      uSize: { value: options.size },
      uScale: options.pointScale,
      uOpacity: { value: options.opacity ?? 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform float uSize;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.5, uSize * uScale / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        if (d > 1.0 || vAlpha <= 0.0) discard;
        float core = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(uColor * (0.6 + core * 1.2), core * vAlpha * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    positions,
    alphas,
    commit() {
      positionAttribute.needsUpdate = true;
      alphaAttribute.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Quadratic Bézier point (no allocation). */
export function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, target: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  return target.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
}

/** 0 → 1 → 0 bump over [a, b] with smooth edges of width `ramp` (absolute units). */
export function pulse(x: number, a: number, b: number, ramp: number): number {
  if (x <= a || x >= b) return 0;
  return Math.min(1, (x - a) / ramp, (b - x) / ramp);
}

/** Clamp to 0–1 and apply smoothstep. */
export function sstep(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── Cut-open membranes and proteins ───────────────────────────────────────

/** Same band colours as the kit's cut-bilayer geometries (head groups / hydrophobic core). */
export const BAND_HEAD = new THREE.Color('#f1e3c8');
export const BAND_CORE = new THREE.Color('#b08a3e');
const BAND_STOPS = [0, 0.28, 0.36, 0.64, 0.72, 1];

/**
 * Part of a flat banded ring (a cut bilayer seen face-on), facing +z: radii
 * inner → outer, angles a0 → a1 (radians, counter-clockwise from +x).
 */
export function bandArcGeometry(
  innerRadius: number,
  outerRadius: number,
  a0: number,
  a1: number,
  segments = 32,
  head: THREE.Color = BAND_HEAD,
  core: THREE.Color = BAND_CORE,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const n = BAND_STOPS.length;
  for (let s = 0; s <= segments; s++) {
    const a = a0 + ((a1 - a0) * s) / segments;
    for (let k = 0; k < n; k++) {
      const r = innerRadius + (outerRadius - innerRadius) * BAND_STOPS[k];
      const c = k === 0 || k === 1 || k === 4 || k === 5 ? head : core;
      positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let s = 0; s < segments; s++) {
    for (let k = 0; k < n - 1; k++) {
      const a = s * n + k;
      const b = (s + 1) * n + k;
      if (a1 > a0) indices.push(a, a + 1, b, b, a + 1, b + 1);
      else indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/**
 * A surface sampled on a (u, v) grid in [0, 1]²; `fn` writes the position and
 * the intended outward normal. Triangles are wound to face along that normal.
 */
export function paramSurface(nu: number, nv: number, fn: (u: number, v: number, position: THREE.Vector3, normal: THREE.Vector3) => void): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      fn(i / nu, j / nv, p, n);
      positions.push(p.x, p.y, p.z);
      n.normalize();
      normals.push(n.x, n.y, n.z);
    }
  }
  const row = nu + 1;
  const indices: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * row + i;
      indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  // Orient by comparing the first non-degenerate triangle with the intended normal.
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    va.fromArray(positions, indices[t] * 3);
    vb.fromArray(positions, indices[t + 1] * 3);
    vc.fromArray(positions, indices[t + 2] * 3);
    const face = vb.sub(va).cross(vc.sub(va));
    if (face.lengthSq() < 1e-10) continue;
    n.fromArray(normals, indices[t] * 3);
    if (face.dot(n) < 0) {
      for (let k = 0; k < indices.length; k += 3) {
        const tmp = indices[k + 1];
        indices[k + 1] = indices[k + 2];
        indices[k + 2] = tmp;
      }
    }
    break;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/**
 * Material for objects cut open by a clipping plane: the part on the plane's
 * negative side is not drawn, and the inside seen through the cut is painted
 * a flat `capColor`, so the object reads as a solid cut through.
 */
export function cutawayMaterial(
  color: THREE.ColorRepresentation,
  capColor: THREE.ColorRepresentation,
  plane: THREE.Plane,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  const material = new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 0.16,
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    clippingPlanes: [plane],
    ...options,
  });
  const cap = new THREE.Color(capColor);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCapColor = { value: cap };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCapColor;')
      .replace('#include <opaque_fragment>', 'if (!gl_FrontFacing) outgoingLight = uCapColor;\n#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'membranesCutaway';
  return material;
}

// ── Sugar chains ──────────────────────────────────────────────────────────

/**
 * A branched sugar chain grown upward (+y) from the origin: a stem with
 * side branches, beads ~`spacing` apart. Returns bead centres.
 */
export function glycanTree(rng: Rng, count: number, spacing: number): THREE.Vector3[] {
  const beads: THREE.Vector3[] = [];
  const stemCount = Math.min(count, Math.max(3, Math.round(count * 0.6)));
  const dir = new THREE.Vector3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).normalize();
  const p = new THREE.Vector3();
  const stem: THREE.Vector3[] = [];
  for (let i = 0; i < stemCount; i++) {
    if (i > 0) {
      dir.x += rng.range(-0.4, 0.4);
      dir.z += rng.range(-0.4, 0.4);
      dir.normalize();
      if (dir.y < 0.5) {
        dir.y = 0.5;
        dir.normalize();
      }
      p.addScaledVector(dir, spacing);
    }
    stem.push(p.clone());
  }
  beads.push(...stem);
  let remaining = count - stemCount;
  let side = rng.range(0, Math.PI * 2);
  while (remaining > 0) {
    const from = stem[Math.min(stem.length - 1, rng.int(1, Math.max(1, stem.length - 2)))];
    const length = Math.min(remaining, rng.int(1, 3));
    side += 2.1 + rng.range(-0.4, 0.4);
    const bdir = new THREE.Vector3(Math.cos(side), rng.range(0.35, 0.8), Math.sin(side)).normalize();
    const q = from.clone();
    for (let k = 0; k < length; k++) {
      q.addScaledVector(bdir, spacing);
      beads.push(q.clone());
      bdir.y += 0.25;
      bdir.normalize();
    }
    remaining -= length;
  }
  return beads;
}
