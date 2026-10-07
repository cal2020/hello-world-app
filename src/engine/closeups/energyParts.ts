import * as THREE from 'three';
import { mergeGeometries } from '../core/geometry';
import { blobGeometry } from './common';
import { bandMaterial, bilayerRingGeometry, membraneMaterial } from './kit';

export { membraneMaterial };

/**
 * Helpers shared by the close-ups of the "energy, digestion and chemical
 * processing" group (mitochondria, lysosomes, endosomes, peroxisomes). Every
 * cut in these scenes is the plane z = 0 with the camera on the +z side, so
 * cut faces are flat ribbons drawn in that plane.
 */

export type TimeUniform = { value: number };

function chainKey(material: THREE.Material, key: string): void {
  const previous = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previous ? previous() : ''}|${key}`;
}

// ── 2-D paths ──────────────────────────────────────────────────────────────

/** Points at (roughly) even spacing along a polyline. */
export function resamplePath(points: THREE.Vector2[], closed: boolean, spacing: number): THREE.Vector2[] {
  const pts = closed ? [...points, points[0]] : points;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = a.distanceTo(b);
    const steps = Math.max(1, Math.round(len / spacing));
    for (let s = 0; s < steps; s++) out.push(a.clone().lerp(b, s / steps));
  }
  if (!closed) out.push(pts[pts.length - 1].clone());
  return out;
}

/** Chaikin corner cutting (keeps the end points of open paths). */
export function smoothPath(points: THREE.Vector2[], closed: boolean, iterations = 2): THREE.Vector2[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const out: THREE.Vector2[] = [];
    const n = pts.length;
    if (!closed) out.push(pts[0].clone());
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      out.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
    }
    if (!closed) out.push(pts[n - 1].clone());
    pts = out;
  }
  return pts;
}

/** Points of a circular arc (angles in radians, inclusive). */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, steps: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

// ── Cut faces ──────────────────────────────────────────────────────────────

export interface Band {
  /** Offset across the ribbon, −0.5 … 0.5 of its width. */
  f: number;
  color: THREE.Color;
}

/** Head groups – hydrophobic core – head groups, like the kit's cut bilayer. */
export function membraneBands(head: THREE.ColorRepresentation, core: THREE.ColorRepresentation): Band[] {
  const h = new THREE.Color(head);
  const c = new THREE.Color(core);
  return [
    { f: -0.5, color: h },
    { f: -0.22, color: h },
    { f: -0.14, color: c },
    { f: 0.14, color: c },
    { f: 0.22, color: h },
    { f: 0.5, color: h },
  ];
}

/**
 * A flat banded ribbon following a 2-D path in the plane z (facing +z): the
 * cut edge of a curved membrane. `width` may vary along the path.
 */
export function ribbonGeometry(points: THREE.Vector2[], closed: boolean, width: number | ((i: number) => number), bands: Band[], z = 0): THREE.BufferGeometry {
  const n = points.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const t = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    t.subVectors(next, prev);
    if (t.lengthSq() < 1e-12) t.set(1, 0);
    t.normalize();
    const w = typeof width === 'number' ? width : width(i);
    for (const band of bands) {
      positions.push(points[i].x - t.y * band.f * w, points[i].y + t.x * band.f * w, z);
      colors.push(band.color.r, band.color.g, band.color.b);
      normals.push(0, 0, 1);
    }
  }
  const b = bands.length;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const i0 = i * b;
    const i1 = ((i + 1) % n) * b;
    for (let k = 0; k < b - 1; k++) indices.push(i0 + k, i1 + k, i0 + k + 1, i1 + k, i1 + k + 1, i0 + k + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  return g;
}

/** Material for cut-face ribbons: vertex colours plus a little self-glow so cut edges read as lighter lines. */
export function cutFaceMaterial(glow = 0.32): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * ${glow.toFixed(3)};`,
    );
  };
  chainKey(material, `cutface${glow}`);
  return material;
}

// ── Surfaces ───────────────────────────────────────────────────────────────

/**
 * A surface whose two sides have different colours (e.g. a membrane facing the
 * matrix on one side and the intermembrane space on the other). Front faces
 * use `front`, back faces `back`.
 */
export function twoToneMaterial(
  front: THREE.ColorRepresentation,
  back: THREE.ColorRepresentation,
  options: { emissive?: number; backEmissive?: number; roughness?: number; key?: string } = {},
): THREE.MeshStandardMaterial {
  const f = new THREE.Color(front);
  const b = new THREE.Color(back);
  const e = options.emissive ?? 0.14;
  const material = new THREE.MeshStandardMaterial({ color: f, emissive: f, emissiveIntensity: e, roughness: options.roughness ?? 0.62, side: THREE.DoubleSide });
  const backEmissive = b.clone().multiplyScalar(options.backEmissive ?? e);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBackColor = { value: b };
    shader.uniforms.uBackEmissive = { value: backEmissive };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uBackColor;\nuniform vec3 uBackEmissive;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = uBackColor;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (!gl_FrontFacing) totalEmissiveRadiance = uBackEmissive;');
  };
  chainKey(material, options.key ?? 'twoTone');
  return material;
}

/**
 * A soft band of light that travels across a surface (world-space wave):
 * used as an "energy conversion" cue. `amount` scales it (0 = off).
 */
export function addShimmer(
  material: THREE.MeshStandardMaterial,
  time: TimeUniform,
  amount: { value: number },
  color: THREE.ColorRepresentation,
  wave: { x: number; y: number; z: number; speed: number; sharpness?: number },
  key = 'shimmer',
): void {
  const c = new THREE.Color(color);
  const sharp = wave.sharpness ?? 0.78;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uShimmerTime = time;
    shader.uniforms.uShimmerAmount = amount;
    shader.uniforms.uShimmerColor = { value: c };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShimmerPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShimmerPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShimmerPos;\nuniform float uShimmerTime;\nuniform float uShimmerAmount;\nuniform vec3 uShimmerColor;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{ float w = sin(dot(vShimmerPos, vec3(${wave.x.toFixed(4)}, ${wave.y.toFixed(4)}, ${wave.z.toFixed(4)})) - uShimmerTime * ${wave.speed.toFixed(4)});
  totalEmissiveRadiance += uShimmerColor * smoothstep(${sharp.toFixed(3)}, 1.0, w) * uShimmerAmount; }`,
      );
  };
  chainKey(material, `${key}:${wave.x},${wave.y},${wave.z},${wave.speed},${sharp}`);
}

/**
 * The back half (z ≤ 0) of a capsule lying along x: a cylinder |x| ≤
 * halfLength with hemispherical caps. Normals point outward.
 */
export function halfCapsuleGeometry(radius: number, halfLength: number, lengthSegments: number, capSegments: number, radialSegments: number): THREE.BufferGeometry {
  const profile: [number, number, number, number][] = [];
  for (let i = 0; i <= capSegments; i++) {
    const a = (i / capSegments) * (Math.PI / 2);
    profile.push([-halfLength - radius * Math.cos(a), radius * Math.sin(a), -Math.cos(a), Math.sin(a)]);
  }
  for (let i = 1; i < lengthSegments; i++) profile.push([-halfLength + (2 * halfLength * i) / lengthSegments, radius, 0, 1]);
  for (let i = capSegments; i >= 0; i--) {
    const a = (i / capSegments) * (Math.PI / 2);
    profile.push([halfLength + radius * Math.cos(a), radius * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [x, r, nx, nr] of profile) {
    for (let k = 0; k <= radialSegments; k++) {
      const phi = (k / radialSegments) * Math.PI;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      positions.push(x, r * c, -r * s);
      normals.push(nx, nr * c, -nr * s);
    }
  }
  const row = radialSegments + 1;
  for (let j = 0; j < profile.length - 1; j++) {
    for (let k = 0; k < radialSegments; k++) {
      const a = j * row + k;
      const b = (j + 1) * row + k;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

export interface BlobPart {
  center: THREE.Vector3;
  scale: THREE.Vector3;
  seed: string;
  roughness?: number;
  rotation?: THREE.Euler;
}

/** Several lumpy ellipsoids merged into one Goodsell-style protein shape. */
export function compositeBlob(parts: BlobPart[], detail: number): THREE.BufferGeometry {
  const pieces = parts.map((p) => {
    const g = blobGeometry(1, p.seed, p.roughness ?? 0.2, detail);
    g.deleteAttribute('uv');
    g.scale(p.scale.x, p.scale.y, p.scale.z);
    if (p.rotation) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(p.rotation));
    g.translate(p.center.x, p.center.y, p.center.z);
    return g;
  });
  const merged = mergeGeometries(pieces)!;
  pieces.forEach((g) => g.dispose());
  return merged;
}

/**
 * Merge geometries (disposing the inputs) after dropping attributes that not
 * all of them have and making indexing consistent.
 */
export function mergeLoose(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = Object.keys(geometries[0].attributes).filter((name) => geometries.every((g) => g.attributes[name] !== undefined));
  const anyNonIndexed = geometries.some((g) => g.index === null);
  const prepared = geometries.map((g) => {
    const h = anyNonIndexed && g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(h.attributes)) if (!names.includes(name)) h.deleteAttribute(name);
    return h;
  });
  const merged = mergeGeometries(prepared)!;
  new Set([...geometries, ...prepared]).forEach((g) => g.dispose());
  return merged;
}

/**
 * An open tube along a straight segment, optionally only part of the way
 * around (phi measured from `sideA` toward `sideB`). Normals point outward.
 */
export function segmentTube(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  sideA: THREE.Vector3,
  sideB: THREE.Vector3,
  phiStart = 0,
  phiLength = Math.PI * 2,
  radial = 8,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const o = new THREE.Vector3();
  for (const end of [from, to]) {
    for (let k = 0; k <= radial; k++) {
      const phi = phiStart + (phiLength * k) / radial;
      o.copy(sideA).multiplyScalar(Math.cos(phi)).addScaledVector(sideB, Math.sin(phi));
      positions.push(end.x + o.x * radius, end.y + o.y * radius, end.z + o.z * radius);
      normals.push(o.x, o.y, o.z);
    }
  }
  // Winding so that faces point outward: depends on the handedness of (A, B, axis).
  const axis = new THREE.Vector3().subVectors(to, from);
  const flip = new THREE.Vector3().crossVectors(sideA, sideB).dot(axis) > 0;
  const row = radial + 1;
  for (let k = 0; k < radial; k++) {
    const a = k;
    const b = row + k;
    if (flip) indices.push(a, a + 1, b + 1, a, b + 1, b);
    else indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

/** Quadratic Bézier points from a via control c to b (inclusive). */
export function bezierPoints(a: THREE.Vector2, c: THREE.Vector2, b: THREE.Vector2, steps: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push(new THREE.Vector2(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y));
  }
  return out;
}

/** Deterministic smooth wander: a sum of two sines per axis with phases from a seed. */
export function wander(seed: number, t: number, amplitude: number, target: THREE.Vector3): THREE.Vector3 {
  const a = seed * 12.9898;
  const b = seed * 78.233;
  const c = seed * 37.719;
  return target.set(
    (Math.sin(t * 0.9 + a) + 0.5 * Math.sin(t * 1.7 + b)) * amplitude * 0.67,
    (Math.sin(t * 0.7 + b) + 0.5 * Math.sin(t * 1.9 + c)) * amplitude * 0.67,
    (Math.sin(t * 1.1 + c) + 0.5 * Math.sin(t * 1.3 + a)) * amplitude * 0.67,
  );
}

// ── Membrane fusion ────────────────────────────────────────────────────────

export interface HoleClip {
  /** World-space centre of the compartment that gets the opening. */
  center: THREE.Vector3;
  /** Unit vector from that centre toward the fusion partner. */
  axis: THREE.Vector3;
  /** Opening radius (0 = closed). */
  radius: { value: number };
}

/**
 * Cut round openings (fusion pores) into a membrane surface: for each hole,
 * fragments on the `axis` side of `center` within `radius` of the axis are
 * discarded. A huge radius turns a hole into a clipping plane.
 */
export function addHoleClip(material: THREE.Material, holes: HoleClip | HoleClip[], key: string): void {
  const list = Array.isArray(holes) ? holes : [holes];
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    let decl = 'varying vec3 vHolePos;';
    let test = '';
    list.forEach((hole, i) => {
      shader.uniforms[`uHoleCenter${i}`] = { value: hole.center };
      shader.uniforms[`uHoleAxis${i}`] = { value: hole.axis };
      shader.uniforms[`uHoleRadius${i}`] = hole.radius;
      decl += `\nuniform vec3 uHoleCenter${i};\nuniform vec3 uHoleAxis${i};\nuniform float uHoleRadius${i};`;
      test += `\n{ vec3 d = vHolePos - uHoleCenter${i}; float a = dot(d, uHoleAxis${i});
  if (a > 0.0 && dot(d, d) - a * a < uHoleRadius${i} * uHoleRadius${i}) discard; }`;
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHolePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHolePos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>${test}`);
  };
  chainKey(material, `${key}:${list.length}`);
}

/**
 * The membrane neck joining two fusing compartments that lie in the cut
 * plane: the back half of a short tube between two points (both at z = 0),
 * plus its two banded cut edges. Update with `set` every frame.
 */
export class FusionNeck {
  readonly group = new THREE.Group();
  private readonly tube: THREE.Mesh;
  private readonly edges: THREE.Mesh;
  private readonly tubePos: THREE.BufferAttribute;
  private readonly tubeNormal: THREE.BufferAttribute;
  private readonly edgePos: THREE.BufferAttribute;
  private readonly segments: number;
  private readonly rings = 5;
  private readonly bands: Band[];
  private readonly thickness: number;
  private readonly axis = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly back = new THREE.Vector3(0, 0, -1);
  private readonly p = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  constructor(material: THREE.Material | THREE.Material[], edgeMaterial: THREE.Material, thickness: number, bands: Band[], segments = 24) {
    this.segments = segments;
    this.bands = bands;
    this.thickness = thickness;
    const ringCount = this.rings;
    const tube = new THREE.BufferGeometry();
    this.tubePos = new THREE.BufferAttribute(new Float32Array(ringCount * (segments + 1) * 3), 3);
    this.tubeNormal = new THREE.BufferAttribute(new Float32Array(ringCount * (segments + 1) * 3), 3);
    this.tubePos.setUsage(THREE.DynamicDrawUsage);
    this.tubeNormal.setUsage(THREE.DynamicDrawUsage);
    tube.setAttribute('position', this.tubePos);
    tube.setAttribute('normal', this.tubeNormal);
    const indices: number[] = [];
    const row = segments + 1;
    for (let r = 0; r < ringCount - 1; r++) {
      for (let k = 0; k < segments; k++) {
        const a = r * row + k;
        const b = (r + 1) * row + k;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    tube.setIndex(indices);
    const materials = Array.isArray(material) ? material : [material];
    this.tube = new THREE.Mesh(tube, materials[0]);
    this.tube.frustumCulled = false;
    // Extra materials (e.g. a separate luminal face) share the same geometry.
    for (const extra of materials.slice(1)) {
      const mesh = new THREE.Mesh(tube, extra);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    // Two banded strips (cut edges), each `rings` long and `bands` wide.
    const edge = new THREE.BufferGeometry();
    const nb = bands.length;
    this.edgePos = new THREE.BufferAttribute(new Float32Array(2 * ringCount * nb * 3), 3);
    this.edgePos.setUsage(THREE.DynamicDrawUsage);
    const colors: number[] = [];
    const normals: number[] = [];
    const edgeIndex: number[] = [];
    for (let s = 0; s < 2; s++) {
      for (let r = 0; r < ringCount; r++) {
        for (const band of bands) {
          colors.push(band.color.r, band.color.g, band.color.b);
          normals.push(0, 0, 1);
        }
      }
      for (let r = 0; r < ringCount - 1; r++) {
        for (let k = 0; k < nb - 1; k++) {
          const a = (s * ringCount + r) * nb + k;
          const b = (s * ringCount + r + 1) * nb + k;
          edgeIndex.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
    edge.setAttribute('position', this.edgePos);
    edge.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    edge.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    edge.setIndex(edgeIndex);
    this.edges = new THREE.Mesh(edge, edgeMaterial);
    this.edges.frustumCulled = false;
    this.group.add(this.tube, this.edges);
  }

  /** Neck from point a to point b (z = 0) with membrane radius r and a slight waist. */
  set(a: THREE.Vector3, b: THREE.Vector3, r: number): void {
    this.group.visible = r > 0.5;
    if (!this.group.visible) return;
    this.axis.subVectors(b, a);
    const length = this.axis.length();
    this.axis.normalize();
    this.side.set(-this.axis.y, this.axis.x, 0).normalize();
    const row = this.segments + 1;
    for (let ri = 0; ri < this.rings; ri++) {
      const u = ri / (this.rings - 1);
      const waist = r * (1 - 0.1 * Math.sin(u * Math.PI));
      for (let k = 0; k <= this.segments; k++) {
        const phi = (k / this.segments) * Math.PI;
        this.n.copy(this.side).multiplyScalar(Math.cos(phi)).addScaledVector(this.back, Math.sin(phi));
        this.p.copy(a).addScaledVector(this.axis, u * length).addScaledVector(this.n, waist);
        const i = ri * row + k;
        this.tubePos.setXYZ(i, this.p.x, this.p.y, this.p.z);
        this.tubeNormal.setXYZ(i, this.n.x, this.n.y, this.n.z);
      }
    }
    this.tubePos.needsUpdate = true;
    this.tubeNormal.needsUpdate = true;
    const nb = this.bands.length;
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? 1 : -1;
      for (let ri = 0; ri < this.rings; ri++) {
        const u = ri / (this.rings - 1);
        const waist = r * (1 - 0.1 * Math.sin(u * Math.PI));
        for (let k = 0; k < nb; k++) {
          const off = waist + this.bands[k].f * this.thickness;
          this.p.copy(a).addScaledVector(this.axis, u * length).addScaledVector(this.side, sign * off);
          this.edgePos.setXYZ((s * this.rings + ri) * nb + k, this.p.x, this.p.y, 0.05);
        }
      }
    }
    this.edgePos.needsUpdate = true;
  }

  dispose(): void {
    this.tube.geometry.dispose();
    this.edges.geometry.dispose();
  }
}

// ── Cut-open spheres ───────────────────────────────────────────────────────

export interface CutBowlOptions {
  radius: number;
  thickness: number;
  color: THREE.ColorRepresentation;
  /** Colour of the luminal (inner) surface. */
  innerColor?: THREE.ColorRepresentation;
  segments?: number;
  /** Colours of the banded cut edge (head groups, hydrophobic core). */
  band?: { head: THREE.ColorRepresentation; core: THREE.ColorRepresentation };
}

/**
 * A spherical membrane cut in half: the back half (z ≤ 0), open toward +z,
 * with the cut edge as a banded bilayer ring at z = 0. (Same idea as the
 * kit's cutShell, whose hemisphere ends up on the +z side, i.e. facing away.)
 * Children: [outer surface, inner surface, cut ring].
 */
export function cutBowl(options: CutBowlOptions): THREE.Group {
  const segments = options.segments ?? 64;
  const rings = Math.max(8, Math.round(segments / 2));
  const hemisphere = (r: number) => {
    const g = new THREE.SphereGeometry(r, segments, rings, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    g.rotateX(Math.PI / 2); // lower hemisphere (y ≤ 0) → back half (z ≤ 0)
    return g;
  };
  const group = new THREE.Group();
  const outer = new THREE.Mesh(hemisphere(options.radius), membraneMaterial(options.color, { side: THREE.FrontSide }));
  const innerColor = options.innerColor ?? new THREE.Color(options.color).multiplyScalar(0.6);
  const inner = new THREE.Mesh(hemisphere(options.radius - options.thickness), membraneMaterial(innerColor, { side: THREE.BackSide, rim: 0.25 }));
  const ring = options.band
    ? bilayerRingGeometry(options.radius - options.thickness, options.radius, segments, new THREE.Color(options.band.head), new THREE.Color(options.band.core))
    : bilayerRingGeometry(options.radius - options.thickness, options.radius, segments);
  const rim = new THREE.Mesh(ring, bandMaterial());
  rim.position.z = 0.05;
  group.add(outer, inner, rim);
  return group;
}

// ── Glow halos with per-point colour and size ─────────────────────────────

export interface Halos {
  points: THREE.Points;
  positions: Float32Array;
  colors: Float32Array;
  /** Size in scene units. */
  sizes: Float32Array;
  alphas: Float32Array;
  set(i: number, p: THREE.Vector3, alpha: number): void;
  commit(): void;
  dispose(): void;
}

/**
 * Soft additive glows that mark very small molecules (a few ångström across)
 * so they can be found next to much larger proteins. Like the kit's sparks,
 * but each point has its own colour and size.
 */
export function halos(count: number, pointScale: { value: number }): Halos {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3).fill(1);
  const sizes = new Float32Array(count).fill(1);
  const alphas = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  const attrs = [
    ['position', new THREE.BufferAttribute(positions, 3)],
    ['aColor', new THREE.BufferAttribute(colors, 3)],
    ['aSize', new THREE.BufferAttribute(sizes, 1)],
    ['aAlpha', new THREE.BufferAttribute(alphas, 1)],
  ] as const;
  for (const [name, attr] of attrs) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }
  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: pointScale },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      attribute float aSize;
      attribute vec3 aColor;
      uniform float uScale;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = aAlpha;
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.5, aSize * uScale / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        if (d > 1.0 || vAlpha <= 0.0) discard;
        float glow = pow(1.0 - d, 1.6);
        gl_FragColor = vec4(vColor * (0.5 + glow), glow * vAlpha * 0.8);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    positions,
    colors,
    sizes,
    alphas,
    set(i, p, alpha) {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      alphas[i] = alpha;
    },
    commit() {
      for (const [, attr] of attrs) attr.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ── Multi-coloured lumpy proteins ──────────────────────────────────────────

/** Merge parts into one geometry, each painted in one colour (vertex colours). */
export function paintedMerge(parts: { geometry: THREE.BufferGeometry; color: THREE.ColorRepresentation }[]): THREE.BufferGeometry {
  const prepared = parts.map(({ geometry, color }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    if (g.attributes.uv) g.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = c.r;
      colors[i + 1] = c.g;
      colors[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
  const merged = mergeGeometries(prepared)!;
  prepared.forEach((g) => g.dispose());
  return merged;
}

export interface Lump {
  at: [number, number, number];
  /** Radius, or radii along x, y, z. */
  r: number | [number, number, number];
  color: THREE.ColorRepresentation;
}

/** A Goodsell-style protein built from coloured lumps (use with a vertex-coloured material). */
export function paintedLumps(seed: string, lumps: Lump[], detail: number, roughness = 0.22): THREE.BufferGeometry {
  return paintedMerge(
    lumps.map((lump, i) => {
      const g = blobGeometry(1, `${seed}:${i}`, roughness, detail);
      const [sx, sy, sz] = typeof lump.r === 'number' ? [lump.r, lump.r, lump.r] : lump.r;
      g.scale(sx, sy, sz);
      g.translate(lump.at[0], lump.at[1], lump.at[2]);
      return { geometry: g, color: lump.color };
    }),
  );
}
