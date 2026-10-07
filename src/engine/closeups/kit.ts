import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { mergeGeometries } from '../core/geometry';
import { Rng } from '../core/random';
import { blobGeometry } from './common';

/**
 * Building blocks shared by the close-up scenes: lipid bilayers, nucleic-acid
 * helices, cytoskeletal filament lattices, protein blobs and glowing ion
 * "sparks". All sizes are in the scene's own units; at 1 nm per unit the
 * defaults below are true molecular dimensions.
 *
 * Thermal motion is done in the vertex shader (see `addJiggle`) so thousands
 * of molecules cost nothing on the CPU and stop exactly when biological time
 * is frozen.
 */

export type TimeUniform = { value: number };

export function byQuality<T>(quality: QualityLevel, values: { low: T; medium: T; high: T }): T {
  return values[quality];
}

/**
 * three.js measures curves with 200 samples by default, which spaces points
 * unevenly along long curves (e.g. hundreds of base pairs). Raise the
 * resolution so arc-length lookups are accurate to about `step`.
 */
export function refineCurve(curve: THREE.Curve<THREE.Vector3>, step: number): void {
  const divisions = Math.min(40_000, Math.max(curve.arcLengthDivisions, Math.ceil(curve.getLength() / step)));
  if (divisions !== curve.arcLengthDivisions) {
    curve.arcLengthDivisions = divisions;
    curve.updateArcLengths();
  }
}

// ── Materials ──────────────────────────────────────────────────────────────

/** Matte, softly self-lit "molecule" material in the atlas style. */
export function moleculeMaterial(
  color: THREE.ColorRepresentation,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.16, roughness: 0.55, metalness: 0, ...options });
}

/** White base colour, so per-instance colours (instanceColor) show exactly. */
export function instancedMaterial(options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#000000', roughness: 0.55, metalness: 0, ...options });
}

/** Self-lit tint for instanced materials: adds a fraction of the instance colour as emission. */
export function addInstanceGlow(material: THREE.MeshStandardMaterial, amount = 0.18, key = 'iglow'): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n#if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )\n totalEmissiveRadiance += vColor.rgb * ${amount.toFixed(3)};\n#endif`,
    );
  };
  chainCacheKey(material, `${key}${amount}`);
}

/** Translucent membrane surface with a brighter rim at grazing angles. */
export function membraneMaterial(
  color: THREE.ColorRepresentation,
  options: { opacity?: number; side?: THREE.Side; rim?: number } = {},
): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  const opacity = options.opacity ?? 1;
  const material = new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 0.12,
    roughness: 0.6,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 0.6,
    side: options.side ?? THREE.FrontSide,
  });
  const rim = options.rim ?? 0.5;
  if (rim > 0) {
    const rimColor = c.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = { value: rimColor };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;')
        .replace(
          '#include <dithering_fragment>',
          `{ float f = pow(1.0 - abs(dot(normalize(normal), normalize(-vViewPosition))), 2.4);
  gl_FragColor.rgb += uRimColor * f * ${rim.toFixed(2)};
  gl_FragColor.a = clamp(gl_FragColor.a + f * 0.3 * gl_FragColor.a, 0.0, 1.0); }
#include <dithering_fragment>`,
        );
    };
    chainCacheKey(material, `mrim${rim}`);
  }
  return material;
}

/** Additive glow (for highlights and energy cues). */
export function glowMaterial(color: THREE.ColorRepresentation, opacity = 0.8): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}

function chainCacheKey(material: THREE.Material, key: string): void {
  const previous = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previous ? previous() : ''}|${key}`;
}

// ── Thermal motion ─────────────────────────────────────────────────────────

export interface JiggleUniforms {
  time: TimeUniform;
  /** Global multiplier (set to ~0.3 when motion should be calm). */
  amount: { value: number };
}

export function createJiggle(time: TimeUniform): JiggleUniforms {
  return { time, amount: { value: 1 } };
}

/**
 * Random-looking thermal motion for an InstancedMesh, computed per instance
 * in the vertex shader. `amplitude` is per local axis (scene units); instances
 * sharing an `aSeed` value (see `setSeeds`) move together, so a lipid's head
 * and tails stay attached.
 */
export function addJiggle(material: THREE.Material, uniforms: JiggleUniforms, amplitude: THREE.Vector3, speed = 1, key = 'jiggle'): void {
  const amp = amplitude.clone();
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uJiggleAmount = uniforms.amount;
    shader.uniforms.uJiggleAmp = { value: amp };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute float aSeed;
uniform float uTime;
uniform float uJiggleAmount;
uniform vec3 uJiggleAmp;
vec3 jiggleOffset(float seed, float t) {
  vec3 ph = fract(sin(vec3(seed * 12.9898, seed * 78.233, seed * 37.719)) * 43758.5453) * 6.2831853;
  t *= ${speed.toFixed(3)};
  return vec3(
    sin(t * 1.7 + ph.x) + 0.5 * sin(t * 3.1 + ph.y),
    sin(t * 1.3 + ph.y) + 0.5 * sin(t * 2.9 + ph.z),
    sin(t * 1.9 + ph.z) + 0.5 * sin(t * 2.3 + ph.x)) * (1.0 / 1.5);
}`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
  mvPosition.xyz += jiggleOffset(aSeed, uTime) * uJiggleAmp * uJiggleAmount;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  chainCacheKey(material, key);
}

/** Give each instance a jiggle seed (instances with equal seeds move together). */
export function setSeeds(mesh: THREE.InstancedMesh, seeds: ArrayLike<number>): void {
  mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from(seeds), 1));
}

// ── Instancing helpers ─────────────────────────────────────────────────────

export interface Placement {
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  scale?: number | THREE.Vector3;
  color?: THREE.ColorRepresentation;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

export function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, placements: Placement[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, placements.length));
  placements.forEach((p, i) => {
    if (typeof p.scale === 'number') _s.setScalar(p.scale);
    else if (p.scale) _s.copy(p.scale);
    else _s.setScalar(1);
    mesh.setMatrixAt(i, _m.compose(p.position, p.quaternion ?? _q.identity(), _s));
    if (p.color !== undefined) mesh.setColorAt(i, _c.set(p.color));
  });
  mesh.count = placements.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Hide an instance (zero scale) without changing the instance count. */
export function hideInstance(mesh: THREE.InstancedMesh, index: number): void {
  mesh.setMatrixAt(index, _m.makeScale(0, 0, 0));
}

/** Random rotation. */
export function randomQuaternion(rng: Rng, target = new THREE.Quaternion()): THREE.Quaternion {
  const u1 = rng.next();
  const u2 = rng.next() * Math.PI * 2;
  const u3 = rng.next() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return target.set(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}

/** Rotation taking local +Y to `direction`, optionally spun around it. */
export function alignY(direction: THREE.Vector3, spin = 0, target = new THREE.Quaternion()): THREE.Quaternion {
  target.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  if (spin) target.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));
  return target;
}

/**
 * Dart-throwing placement: up to `maxCount` non-overlapping spheres in a box
 * (radius-aware, using a spatial hash), skipping points `reject` refuses.
 */
export function scatter(
  rng: Rng,
  box: THREE.Box3,
  maxCount: number,
  radius: (index: number) => number,
  reject?: (p: THREE.Vector3, r: number) => boolean,
  attempts = 30,
): { position: THREE.Vector3; radius: number }[] {
  const out: { position: THREE.Vector3; radius: number }[] = [];
  const size = box.getSize(new THREE.Vector3());
  let maxRadius = 0;
  const radii = Array.from({ length: maxCount }, (_, i) => {
    const r = radius(i);
    maxRadius = Math.max(maxRadius, r);
    return r;
  });
  const cell = Math.max(1e-3, maxRadius * 2);
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < maxCount; i++) {
    const r = radii[i];
    for (let a = 0; a < attempts; a++) {
      const p = new THREE.Vector3(box.min.x + rng.next() * size.x, box.min.y + rng.next() * size.y, box.min.z + rng.next() * size.z);
      if (reject?.(p, r)) continue;
      let ok = true;
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      const cz = Math.floor(p.z / cell);
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const j of bucket) {
              const o = out[j];
              const d = o.radius + r;
              if (o.position.distanceToSquared(p) < d * d) {
                ok = false;
                break;
              }
            }
          }
        }
      }
      if (ok) {
        const key = keyOf(p.x, p.y, p.z);
        const bucket = grid.get(key);
        if (bucket) bucket.push(out.length);
        else grid.set(key, [out.length]);
        out.push({ position: p, radius: r });
        break;
      }
    }
  }
  return out;
}

/** Minimum distance from a point to a set of sample points (cheap obstacle test). */
export function nearestDistance(point: THREE.Vector3, samples: THREE.Vector3[]): number {
  let best = Infinity;
  for (const s of samples) best = Math.min(best, s.distanceToSquared(point));
  return Math.sqrt(best);
}

/** A small set of lumpy protein shapes to share between many instanced meshes. */
export function proteinShapes(seed: string, count: number, detail = 2, roughness = 0.24): THREE.BufferGeometry[] {
  return Array.from({ length: count }, (_, i) => blobGeometry(1, `${seed}:${i}`, roughness, detail));
}

// ── Lipid bilayer (molecular scale, 1 nm per unit) ─────────────────────────

export interface BilayerOptions {
  /** Patch size along x and z (the bilayer lies in the xz plane, outer leaflet toward +y). */
  width: number;
  depth: number;
  seed: string;
  quality: QualityLevel;
  jiggle: JiggleUniforms;
  /** Distance between neighbouring lipids (≈0.8–0.9 nm in real membranes). */
  spacing?: number;
  /** Head-group to head-group distance (≈4 nm). */
  thickness?: number;
  headRadius?: number;
  headColor?: THREE.ColorRepresentation;
  /** Optional colour for the outer (+y) leaflet heads. */
  outerHeadColor?: THREE.ColorRepresentation;
  tailColor?: THREE.ColorRepresentation;
  /** Leave out lipids where proteins sit. leaflet: +1 outer, −1 inner. */
  exclude?: (x: number, z: number, leaflet: 1 | -1) => boolean;
  /** Round patch instead of a rectangle. */
  circular?: boolean;
}

export interface Bilayer {
  group: THREE.Group;
  heads: THREE.InstancedMesh;
  tails: THREE.InstancedMesh;
  lipidCount: number;
  /** y of the outer and inner head-group planes. */
  outerY: number;
  innerY: number;
  dispose(): void;
}

/**
 * Individual phospholipids: a round head group and two fatty-acid tails each,
 * in two leaflets. Lipids jiggle and wander sideways (a 2-D fluid).
 */
export function lipidBilayer(options: BilayerOptions): Bilayer {
  const spacing = options.spacing ?? 0.9;
  const thickness = options.thickness ?? 4;
  const headRadius = options.headRadius ?? 0.42;
  const rng = new Rng(options.seed);
  const half = thickness / 2;
  const tailLength = half - headRadius * 0.6;

  const headGeometry = new THREE.IcosahedronGeometry(1, options.quality === 'high' ? 1 : 0);
  const tailParts: THREE.BufferGeometry[] = [];
  for (const offset of [-0.2, 0.2]) {
    const tail = new THREE.CylinderGeometry(0.15, 0.11, 1, options.quality === 'low' ? 4 : 5, 1, true);
    tail.translate(offset, -0.5, 0);
    tailParts.push(tail);
  }
  const tailGeometry = mergeGeometries(tailParts)!;
  tailParts.forEach((g) => g.dispose());

  const headColor = new THREE.Color(options.headColor ?? '#f2e6cf');
  const outerHeadColor = new THREE.Color(options.outerHeadColor ?? headColor);
  const tailColor = new THREE.Color(options.tailColor ?? '#d9b45a');

  const heads: Placement[] = [];
  const tails: Placement[] = [];
  const seeds: number[] = [];
  const rows = Math.floor(options.depth / (spacing * 0.866));
  const cols = Math.floor(options.width / spacing);
  const up = new THREE.Vector3(0, 1, 0);
  let seed = 0;
  for (const leaflet of [1, -1] as const) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -options.width / 2 + (c + (r % 2) * 0.5 + 0.5) * spacing + rng.range(-0.18, 0.18);
        const z = -options.depth / 2 + (r + 0.5) * spacing * 0.866 + rng.range(-0.18, 0.18);
        if (options.circular && x * x + z * z > (options.width / 2) * (options.width / 2)) continue;
        if (options.exclude?.(x, z, leaflet)) continue;
        const headY = leaflet * half;
        const tint = rng.range(-0.06, 0.06);
        const hc = (leaflet === 1 ? outerHeadColor : headColor).clone().offsetHSL(0, 0, tint);
        heads.push({ position: new THREE.Vector3(x, headY, z), scale: headRadius * rng.range(0.9, 1.1), color: hc });
        // Tails hang from the head toward the bilayer middle, slightly splayed.
        const tilt = new THREE.Vector3(rng.range(-0.18, 0.18), -leaflet, rng.range(-0.18, 0.18)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(up, tilt.clone().negate());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI)));
        tails.push({
          position: new THREE.Vector3(x, headY - leaflet * headRadius * 0.6, z),
          quaternion: q,
          scale: new THREE.Vector3(1, tailLength * rng.range(0.85, 1.05), 1),
          color: tailColor.clone().offsetHSL(0, 0, tint * 0.5),
        });
        seeds.push(seed++);
      }
    }
  }

  const headMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(headMaterial, 0.2, 'lipidHead');
  const tailMaterial = instancedMaterial({ roughness: 0.7 });
  addInstanceGlow(tailMaterial, 0.12, 'lipidTail');
  const amplitude = new THREE.Vector3(0.22, 0.08, 0.22);
  addJiggle(headMaterial, options.jiggle, amplitude, 1, 'lipidJiggle');
  addJiggle(tailMaterial, options.jiggle, amplitude, 1, 'lipidJiggle');

  const headMesh = instanced(headGeometry, headMaterial, heads);
  const tailMesh = instanced(tailGeometry, tailMaterial, tails);
  setSeeds(headMesh, seeds);
  setSeeds(tailMesh, seeds);
  const group = new THREE.Group();
  group.add(headMesh, tailMesh);
  return {
    group,
    heads: headMesh,
    tails: tailMesh,
    lipidCount: heads.length,
    outerY: half,
    innerY: -half,
    dispose() {
      headGeometry.dispose();
      tailGeometry.dispose();
      headMaterial.dispose();
      tailMaterial.dispose();
    },
  };
}

// ── Smooth membranes (organelle scale, or large molecular scenes) ─────────

const BAND_HEAD = new THREE.Color('#f1e3c8');
const BAND_CORE = new THREE.Color('#b08a3e');

/**
 * A flat ring whose radial bands read as a cut bilayer: head groups, the
 * hydrophobic core, head groups. Faces +z.
 */
export function bilayerRingGeometry(innerRadius: number, outerRadius: number, segments = 96, head = BAND_HEAD, core = BAND_CORE): THREE.BufferGeometry {
  const radii = [0, 0.28, 0.36, 0.64, 0.72, 1].map((f) => innerRadius + (outerRadius - innerRadius) * f);
  const colors = [head, head, core, core, head, head];
  const positions: number[] = [];
  const cols: number[] = [];
  const indices: number[] = [];
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    for (let k = 0; k < radii.length; k++) {
      positions.push(Math.cos(a) * radii[k], Math.sin(a) * radii[k], 0);
      cols.push(colors[k].r, colors[k].g, colors[k].b);
    }
  }
  const n = radii.length;
  for (let s = 0; s < segments; s++) {
    for (let k = 0; k < n - 1; k++) {
      const a = s * n + k;
      const b = (s + 1) * n + k;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * A rectangular strip (width × thickness) coloured as a cut bilayer, facing
 * +z, centred on the origin, thickness along y. Use it to close the cut edge
 * of a membrane sheet.
 */
export function bilayerStripGeometry(width: number, thickness: number, head = BAND_HEAD, core = BAND_CORE): THREE.BufferGeometry {
  const ys = [0, 0.28, 0.36, 0.64, 0.72, 1].map((f) => -thickness / 2 + thickness * f);
  const colors = [head, head, core, core, head, head];
  const positions: number[] = [];
  const cols: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < ys.length; k++) {
    for (const x of [-width / 2, width / 2]) {
      positions.push(x, ys[k], 0);
      cols.push(colors[k].r, colors[k].g, colors[k].b);
    }
  }
  for (let k = 0; k < ys.length - 1; k++) {
    const a = k * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Material for the banded cut-edge geometries above. */
export function bandMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: '#2a2010', side: THREE.DoubleSide });
}

export interface CutShellOptions {
  radius: number;
  /** Bilayer thickness (≈4–5 nm at molecular scale). */
  thickness: number;
  color: THREE.ColorRepresentation;
  segments?: number;
  /** Outer surface opacity (inner surface stays opaque for depth). */
  opacity?: number;
}

/**
 * A spherical membrane cut in half: a bowl open toward +z, with the cut edge
 * shown as a banded bilayer ring. Look at it from +z to see inside.
 */
export function cutShell(options: CutShellOptions): THREE.Group {
  const segments = options.segments ?? 64;
  const group = new THREE.Group();
  const outerGeometry = new THREE.SphereGeometry(options.radius, segments, Math.round(segments / 2), 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  outerGeometry.rotateX(-Math.PI / 2); // open side toward +z
  const innerGeometry = new THREE.SphereGeometry(options.radius - options.thickness, segments, Math.round(segments / 2), 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  innerGeometry.rotateX(-Math.PI / 2);
  const outer = new THREE.Mesh(outerGeometry, membraneMaterial(options.color, { opacity: options.opacity ?? 1, side: THREE.FrontSide }));
  const inner = new THREE.Mesh(innerGeometry, membraneMaterial(new THREE.Color(options.color).multiplyScalar(0.8), { side: THREE.BackSide, rim: 0.2 }));
  const rim = new THREE.Mesh(bilayerRingGeometry(options.radius - options.thickness, options.radius, segments), bandMaterial());
  group.add(outer, inner, rim);
  return group;
}

/**
 * A membrane tube (e.g. an ER tubule) with its two ends cut open: outer and
 * inner surfaces plus banded rims at both ends.
 */
export function membraneTube(curve: THREE.Curve<THREE.Vector3>, radius: number, thickness: number, color: THREE.ColorRepresentation, segments = 48): THREE.Group {
  const group = new THREE.Group();
  const radial = 32;
  const outer = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, radial, false), membraneMaterial(color));
  const inner = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segments, radius - thickness, radial, false),
    membraneMaterial(new THREE.Color(color).multiplyScalar(0.75), { side: THREE.BackSide, rim: 0.2 }),
  );
  group.add(outer, inner);
  const band = bandMaterial();
  for (const u of [0, 1]) {
    const ring = new THREE.Mesh(bilayerRingGeometry(radius - thickness, radius, radial), band);
    ring.position.copy(curve.getPointAt(u));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(u));
    group.add(ring);
  }
  return group;
}

// ── Nucleic acids ──────────────────────────────────────────────────────────

export interface HelixOptions {
  /** Axis of the helix. */
  curve: THREE.Curve<THREE.Vector3>;
  quality: QualityLevel;
  /** Helix radius to the backbone (B-DNA ≈1 nm). */
  radius?: number;
  /** Rise per base pair (B-DNA 0.34 nm). */
  rise?: number;
  bpPerTurn?: number;
  backboneRadius?: number;
  strandColors?: [THREE.ColorRepresentation, THREE.ColorRepresentation];
  /** Colour of base pair i (default: pale pairs alternating with warm pairs). */
  baseColor?: (index: number, count: number) => THREE.ColorRepresentation;
  /** Phase offset of the second strand (radians); ≈ 2.4 makes major and minor grooves. */
  strandOffset?: number;
}

export interface Helix {
  group: THREE.Group;
  bpCount: number;
  bases: THREE.InstancedMesh;
  /** Backbone position of strand 0/1 at base pair i. */
  backbone(strand: 0 | 1, index: number, target?: THREE.Vector3): THREE.Vector3;
  /** Recolour base pair i (call `bases.instanceColor.needsUpdate = true` afterwards). */
  setBaseColor(index: number, color: THREE.ColorRepresentation): void;
  dispose(): void;
}

/** Double-stranded DNA (two backbones joined by base pairs) along any curve. */
export function doubleHelix(options: HelixOptions): Helix {
  const radius = options.radius ?? 1;
  const rise = options.rise ?? 0.34;
  const bpPerTurn = options.bpPerTurn ?? 10.5;
  const backboneRadius = options.backboneRadius ?? 0.28;
  const offset = options.strandOffset ?? 2.4;
  const curve = options.curve;
  refineCurve(curve, rise / 2);
  const length = curve.getLength();
  const bpCount = Math.max(2, Math.floor(length / rise));
  const frames = curve.computeFrenetFrames(bpCount * 2, false);
  const strandPoints: THREE.Vector3[][] = [[], []];
  const samples = bpCount * 2;
  const p = new THREE.Vector3();
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    curve.getPointAt(u, p);
    const angle = (u * length / rise / bpPerTurn) * Math.PI * 2;
    for (const strand of [0, 1] as const) {
      const a = angle + strand * offset;
      const n = frames.normals[s];
      const b = frames.binormals[s];
      strandPoints[strand].push(p.clone().addScaledVector(n, Math.cos(a) * radius).addScaledVector(b, Math.sin(a) * radius));
    }
  }
  const radialSegments = options.quality === 'low' ? 4 : 6;
  const group = new THREE.Group();
  const strandColors = options.strandColors ?? ['#7fb2ff', '#a98bff'];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  strandPoints.forEach((points, i) => {
    const path = new THREE.CatmullRomCurve3(points);
    const geometry = new THREE.TubeGeometry(path, points.length * 2, backboneRadius, radialSegments, false);
    const material = moleculeMaterial(strandColors[i], { roughness: 0.4 });
    geometries.push(geometry);
    materials.push(material);
    group.add(new THREE.Mesh(geometry, material));
  });
  const baseGeometry = new THREE.CylinderGeometry(0.17, 0.17, 1, options.quality === 'low' ? 4 : 5, 1, true);
  const baseMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(baseMaterial, 0.15, 'bases');
  geometries.push(baseGeometry);
  materials.push(baseMaterial);
  const baseColor = options.baseColor ?? ((i: number) => (i % 2 ? '#ffd58a' : '#fff1d6'));
  const placements: Placement[] = [];
  const mid = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const backbone = (strand: 0 | 1, index: number, target = new THREE.Vector3()) => target.copy(strandPoints[strand][Math.min(samples, index * 2 + 1)]);
  for (let i = 0; i < bpCount; i++) {
    const a = backbone(0, i);
    const b = backbone(1, i);
    mid.addVectors(a, b).multiplyScalar(0.5);
    dir.subVectors(b, a);
    const len = dir.length();
    placements.push({ position: mid.clone(), quaternion: alignY(dir), scale: new THREE.Vector3(1, len * 0.92, 1), color: baseColor(i, bpCount) });
  }
  const bases = instanced(baseGeometry, baseMaterial, placements);
  group.add(bases);
  return {
    group,
    bpCount,
    bases,
    backbone,
    setBaseColor(index, color) {
      bases.setColorAt(index, _c.set(color));
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

export interface StrandOptions {
  curve: THREE.Curve<THREE.Vector3>;
  quality: QualityLevel;
  /** Distance between nucleotides along the strand (≈0.6 nm for stretched RNA). */
  spacing?: number;
  backboneRadius?: number;
  backboneColor?: THREE.ColorRepresentation;
  /** Colour of nucleotide i (e.g. codons in alternating colours). */
  baseColor?: (index: number, count: number) => THREE.ColorRepresentation;
  baseLength?: number;
}

export interface Strand {
  group: THREE.Group;
  count: number;
  bases: THREE.InstancedMesh;
  /** Position of nucleotide i on the backbone. */
  position(index: number, target?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/** Single-stranded nucleic acid (mRNA, a telomere overhang): backbone with short bases. */
export function singleStrand(options: StrandOptions): Strand {
  const spacing = options.spacing ?? 0.6;
  const curve = options.curve;
  refineCurve(curve, spacing / 2);
  const length = curve.getLength();
  const count = Math.max(2, Math.floor(length / spacing));
  const backboneRadius = options.backboneRadius ?? 0.3;
  const baseLength = options.baseLength ?? 0.9;
  const tube = new THREE.TubeGeometry(curve, Math.max(8, count), backboneRadius, options.quality === 'low' ? 4 : 6, false);
  const tubeMaterial = moleculeMaterial(options.backboneColor ?? '#ff9db0', { roughness: 0.4 });
  const baseGeometry = new THREE.CapsuleGeometry(0.2, 1, 1, options.quality === 'low' ? 4 : 5);
  baseGeometry.translate(0, 0.5, 0);
  const baseMaterial = instancedMaterial();
  addInstanceGlow(baseMaterial, 0.2, 'ssbases');
  const frames = curve.computeFrenetFrames(count, false);
  const placements: Placement[] = [];
  const colorAt = options.baseColor ?? (() => '#ffe0a8');
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const pos = curve.getPointAt(u);
    const k = Math.min(count, Math.round(u * count));
    const angle = i * 0.6;
    const dir = frames.normals[k].clone().multiplyScalar(Math.cos(angle)).addScaledVector(frames.binormals[k], Math.sin(angle));
    placements.push({ position: pos, quaternion: alignY(dir), scale: new THREE.Vector3(1, baseLength, 1), color: colorAt(i, count) });
  }
  const bases = instanced(baseGeometry, baseMaterial, placements);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(tube, tubeMaterial), bases);
  return {
    group,
    count,
    bases,
    position(index, target = new THREE.Vector3()) {
      return curve.getPointAt(THREE.MathUtils.clamp((index + 0.5) / count, 0, 1), target);
    },
    dispose() {
      tube.dispose();
      tubeMaterial.dispose();
      baseGeometry.dispose();
      baseMaterial.dispose();
    },
  };
}

/**
 * Two strands wound around each other (an α-helical coiled coil, e.g. an
 * intermediate-filament dimer or a motor's stalk). Returns one merged geometry.
 */
export function coiledCoilGeometry(curve: THREE.Curve<THREE.Vector3>, options: { coilRadius?: number; strandRadius?: number; pitch?: number; radialSegments?: number } = {}): THREE.BufferGeometry {
  const coilRadius = options.coilRadius ?? 0.5;
  const strandRadius = options.strandRadius ?? 0.5;
  const pitch = options.pitch ?? 14;
  refineCurve(curve, 0.4);
  const length = curve.getLength();
  const samples = Math.max(16, Math.ceil(length / 0.8));
  const frames = curve.computeFrenetFrames(samples, false);
  const parts: THREE.BufferGeometry[] = [];
  for (const phase of [0, Math.PI]) {
    const points: THREE.Vector3[] = [];
    for (let s = 0; s <= samples; s++) {
      const u = s / samples;
      const a = (u * length / pitch) * Math.PI * 2 + phase;
      points.push(curve.getPointAt(u).addScaledVector(frames.normals[s], Math.cos(a) * coilRadius).addScaledVector(frames.binormals[s], Math.sin(a) * coilRadius));
    }
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), samples * 2, strandRadius, options.radialSegments ?? 6, false));
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

// ── Cytoskeletal lattices ─────────────────────────────────────────────────

/** Actin filament geometry: subunit centre i along an axis (two-start helix, 2.75 nm rise, −166.6° twist). */
export const ACTIN = { rise: 2.75, twistDeg: -166.6, centerRadius: 1.4, subunitRadius: 2.4 };

export interface ActinFilamentOptions {
  curve: THREE.Curve<THREE.Vector3>;
  quality: QualityLevel;
  color?: THREE.ColorRepresentation;
  /** Colour of subunit i (e.g. bright ATP-actin near the barbed end). */
  subunitColor?: (index: number, count: number) => THREE.ColorRepresentation;
  seed?: string;
}

export interface ActinFilament {
  mesh: THREE.InstancedMesh;
  count: number;
  /** Centre of subunit i. */
  positions: THREE.Vector3[];
  /** Show only subunits in [from, to) (others hidden) — e.g. treadmilling. */
  setVisibleRange(from: number, to: number): void;
  setColor(index: number, color: THREE.ColorRepresentation): void;
  dispose(): void;
}

export function actinFilament(options: ActinFilamentOptions): ActinFilament {
  const curve = options.curve;
  refineCurve(curve, ACTIN.rise / 2);
  const length = curve.getLength();
  const count = Math.max(2, Math.floor(length / ACTIN.rise));
  const frames = curve.computeFrenetFrames(count, false);
  const geometry = blobGeometry(1, options.seed ?? 'actin-subunit', 0.16, options.quality === 'high' ? 2 : 1);
  geometry.scale(1, 0.75, 0.9);
  const material = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(material, 0.18, 'actin');
  const positions: THREE.Vector3[] = [];
  const matrices: THREE.Matrix4[] = [];
  const placements: Placement[] = [];
  const twist = THREE.MathUtils.degToRad(ACTIN.twistDeg);
  const base = new THREE.Color(options.color ?? '#ff8f8f');
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const k = Math.min(count, Math.round(u * count));
    const p = curve.getPointAt(u);
    const a = i * twist;
    const offset = frames.normals[k].clone().multiplyScalar(Math.cos(a) * ACTIN.centerRadius).addScaledVector(frames.binormals[k], Math.sin(a) * ACTIN.centerRadius);
    const center = p.clone().add(offset);
    positions.push(center);
    const q = alignY(frames.tangents[k], a);
    const color = options.subunitColor ? options.subunitColor(i, count) : base.clone().offsetHSL(0, 0, ((i * 7) % 5) * 0.012);
    placements.push({ position: center, quaternion: q, scale: ACTIN.subunitRadius, color });
    matrices.push(new THREE.Matrix4().compose(center, q, new THREE.Vector3().setScalar(ACTIN.subunitRadius)));
  }
  const mesh = instanced(geometry, material, placements);
  return {
    mesh,
    count,
    positions,
    setVisibleRange(from, to) {
      for (let i = 0; i < count; i++) {
        if (i >= from && i < to) mesh.setMatrixAt(i, matrices[i]);
        else hideInstance(mesh, i);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    setColor(index, color) {
      mesh.setColorAt(index, _c.set(color));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Microtubule lattice constants (nm): 13 protofilaments, 25 nm wide, 8 nm dimers, 3-start helix. */
export const MICROTUBULE = { protofilaments: 13, outerRadius: 12.5, centerRadius: 10.2, monomer: 4.05, helixRise: 12.3 };

export interface MicrotubuleLattice {
  /** Local transform of monomer `m` (0 = α of dimer 0, 1 = β of dimer 0, …) of protofilament `pf`, with optional outward curl (radians). */
  monomer(pf: number, m: number, curl?: number, curlFrom?: number, target?: THREE.Matrix4): THREE.Matrix4;
}

/**
 * Positions for a straight microtubule along +y starting at the origin. A
 * protofilament can curl outward (catastrophe) beyond monomer `curlFrom`.
 */
export function microtubuleLattice(scale = 1): MicrotubuleLattice {
  const { protofilaments, centerRadius, monomer, helixRise } = MICROTUBULE;
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const tangentAxis = new THREE.Vector3();
  return {
    monomer(pf, m, curl = 0, curlFrom = Infinity, target = new THREE.Matrix4()) {
      const angle = (pf / protofilaments) * Math.PI * 2;
      // Each protofilament is staggered ≈0.9 nm, so one turn rises three monomers
      // (the 3-start helix; the mismatch is the "seam" between the last and first).
      const yOffset = pf * (helixRise / protofilaments);
      radial.set(Math.cos(angle), 0, Math.sin(angle));
      tangentAxis.set(-Math.sin(angle), 0, Math.cos(angle));
      const straight = Math.min(m, curlFrom);
      p.copy(radial).multiplyScalar(centerRadius);
      p.y = yOffset + straight * monomer + monomer / 2;
      q.identity();
      if (m > curlFrom && curl !== 0) {
        // Curl outward: walk along an arc in the plane of the radial direction and the axis.
        const steps = m - curlFrom;
        const angleStep = curl;
        let dir = new THREE.Vector3(0, 1, 0);
        for (let k = 0; k < steps; k++) {
          dir = dir.applyAxisAngle(tangentAxis, -angleStep).normalize();
          p.addScaledVector(dir, monomer);
        }
        q.setFromAxisAngle(tangentAxis, -angleStep * steps);
      }
      s.setScalar(scale);
      return target.compose(p, q, s);
    },
  };
}

// ── Common molecular shapes ────────────────────────────────────────────────

/** An L-shaped transfer RNA (~7 nm arms). The elbow is at the origin; the
 *  anticodon tip points to −y and the amino-acid end to +x. */
export function trnaGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const radial = quality === 'low' ? 5 : 8;
  const armA = new THREE.CapsuleGeometry(1, 5.5, 2, radial);
  armA.translate(0, -3.2, 0);
  const armB = new THREE.CapsuleGeometry(1, 5.5, 2, radial);
  armB.rotateZ(Math.PI / 2);
  armB.translate(3.2, 0, 0);
  const loop = new THREE.SphereGeometry(1.35, radial, radial);
  loop.translate(0, -6.6, 0);
  const elbow = new THREE.SphereGeometry(1.5, radial, radial);
  for (const g of [armA, armB, loop, elbow]) {
    g.deleteAttribute('uv');
  }
  const merged = mergeGeometries([armA, armB, loop, elbow])!;
  [armA, armB, loop, elbow].forEach((g) => g.dispose());
  return merged;
}

export const TRNA_TIPS = { anticodon: new THREE.Vector3(0, -7.6, 0), aminoAcid: new THREE.Vector3(7, 0, 0) };

/**
 * An 80S ribosome (~26 nm across) as two lumpy subunits in a shared frame:
 * mRNA runs along x through the cleft (y ≈ −2), the exit tunnel leaves the
 * large subunit at +y. Sites A, P and E sit along +x → −x.
 */
export function ribosomeGeometries(quality: QualityLevel, seed = 'ribosome'): { small: THREE.BufferGeometry; large: THREE.BufferGeometry } {
  const detail = quality === 'low' ? 2 : 3;
  const large = blobGeometry(1, `${seed}:large`, 0.22, detail);
  large.scale(13, 9.5, 12);
  large.translate(0, 6, 0);
  const small = blobGeometry(1, `${seed}:small`, 0.26, detail);
  small.scale(11.5, 5.5, 9.5);
  small.translate(0, -7.2, 0.5);
  return { small, large };
}

export const RIBOSOME_FRAME = {
  /** mRNA path through the cleft between the subunits. */
  mrnaY: -2.6,
  /** tRNA site positions (elbows), A → P → E. */
  sites: { A: new THREE.Vector3(3.8, 4.2, 1.5), P: new THREE.Vector3(0, 4.2, 1.5), E: new THREE.Vector3(-3.8, 4.2, 1.5) },
  /** Where the new chain leaves the large subunit. */
  exit: new THREE.Vector3(0, 15.6, -1.5),
};

// ── Glowing particles (ions, protons, small molecules) ─────────────────────

export interface Sparks {
  points: THREE.Points;
  /** xyz per particle; edit, then call `commit()`. */
  positions: Float32Array;
  /** 0–1 visibility per particle. */
  alphas: Float32Array;
  commit(): void;
  dispose(): void;
}

/**
 * Additive glowing dots with a size in scene units (they shrink with
 * distance like real objects). `pointScale` comes from the close-up context.
 */
export function sparks(count: number, color: THREE.ColorRepresentation, size: number, pointScale: { value: number }): Sparks {
  const positions = new Float32Array(count * 3);
  const alphas = new Float32Array(count).fill(1);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const alphaAttribute = new THREE.BufferAttribute(alphas, 1);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  alphaAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aAlpha', alphaAttribute);
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uScale: pointScale },
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
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        if (d > 1.0 || vAlpha <= 0.0) discard;
        float core = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(uColor * (0.6 + core * 1.2), core * vAlpha);
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

// ── Animation helpers ──────────────────────────────────────────────────────

export interface TimelineStep {
  id: string;
  /** Seconds. */
  duration: number;
}

/** Where a looping sequence of steps is at `time`: step index, its id and progress 0–1. */
export function timeline(time: number, steps: TimelineStep[]): { index: number; id: string; t: number; loop: number } {
  const total = steps.reduce((sum, s) => sum + s.duration, 0);
  const loop = Math.floor(time / total);
  let local = ((time % total) + total) % total;
  for (let i = 0; i < steps.length; i++) {
    if (local < steps[i].duration) return { index: i, id: steps[i].id, t: local / steps[i].duration, loop };
    local -= steps[i].duration;
  }
  const last = steps.length - 1;
  return { index: last, id: steps[last].id, t: 1, loop };
}

/** World position of a point given in an object's local frame (for label anchors). */
export function anchorOn(object: THREE.Object3D, local: THREE.Vector3): () => THREE.Vector3 {
  const target = new THREE.Vector3();
  return () => {
    object.updateWorldMatrix(true, false);
    return object.localToWorld(target.copy(local));
  };
}

/** Pick a point along a polyline/curve with eased progress. */
export function along(curve: THREE.Curve<THREE.Vector3>, t: number, target = new THREE.Vector3()): THREE.Vector3 {
  return curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1), target);
}
