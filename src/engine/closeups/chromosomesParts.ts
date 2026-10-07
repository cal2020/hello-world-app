import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { Rng } from '../core/random';
import { Simplex3 } from '../core/noise';
import { blobGeometry } from './common';
import {
  addInstanceGlow,
  addJiggle,
  alignY,
  anchorOn,
  byQuality,
  doubleHelix,
  instanced,
  instancedMaterial,
  moleculeMaterial,
  proteinShapes,
  randomQuaternion,
  setSeeds,
  sparks,
  type JiggleUniforms,
  type Placement,
} from './kit';
import type { CloseupLabel } from './types';

/** One view of a multi-view close-up: its own group, framing, labels and animation. */
export interface CloseupViewBuild {
  group: THREE.Group;
  target: THREE.Vector3;
  radius: number;
  direction: THREE.Vector3;
  labels: CloseupLabel[];
  update(time: number, calm: boolean): void;
  dispose(): void;
}

interface BuildContext {
  quality: QualityLevel;
  pointScale: { value: number };
  jiggle: JiggleUniforms;
}

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

// ═══════════════════════════════════════════════════════════════════════════
// Metaphase chromosome (1 unit = 10 nm)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dimensions in scene units (10 nm): each sister chromatid is ~5 µm long and
 * ~700 nm wide; the centromere sits off-centre (submetacentric: short arm
 * 1.8 µm, long arm 3.2 µm). Kinetochores are ~250 nm plates; kinetochore
 * microtubules are 25 nm wide.
 */
const MP = {
  half: 250,
  centroY: 70,
  rArm: 34,
  rCen: 17.5,
  offArm: 41,
  offCen: 15.5,
  splay: 15,
  kinetochoreRadius: 12.5,
  mtRadius: 1.25,
  mtPerKinetochore: 15,
  poleX: 640,
};

const CHROMATID_COLOR = new THREE.Color('#f06bc8');
const TELOMERE_COLOR = new THREE.Color('#fff07a');

function sisterOffset(y: number): number {
  const d = Math.abs(y - MP.centroY);
  const armLength = y > MP.centroY ? MP.half - MP.centroY : MP.half + MP.centroY;
  const pinch = THREE.MathUtils.smoothstep(d, 0, 62);
  return MP.offCen + (MP.offArm - MP.offCen) * pinch + MP.splay * (d / armLength) ** 2;
}

function sisterZ(y: number, side: number): number {
  return 3.2 * Math.sin(y * 0.011 + side * 1.3);
}

/** A gentle common bend of the arms (both sisters), zero at the centromere. */
function armBend(y: number): number {
  return y < MP.centroY ? -10 * ((MP.centroY - y) / (MP.half + MP.centroY)) ** 2 : 5 * ((y - MP.centroY) / (MP.half - MP.centroY)) ** 2;
}

function baseRadius(y: number, side: number): number {
  const d = y - MP.centroY;
  const r = MP.rArm - (MP.rArm - MP.rCen) * Math.exp(-((d / 25) ** 2));
  return r * (1 + 0.035 * Math.sin(y * 0.045 + side * 2.1));
}

/** Radius of the chromatid at height y including its rounded tips. */
function profileRadius(y: number, side: number): number {
  const r = baseRadius(y, side);
  const e = MP.half - Math.abs(y);
  const cap = r * 0.95;
  if (e >= cap) return r;
  const k = (cap - e) / cap;
  return r * Math.sqrt(Math.max(0, 1 - k * k));
}

function axisPoint(y: number, side: number, target: THREE.Vector3): THREE.Vector3 {
  return target.set(armBend(y) + side * sisterOffset(y), y, sisterZ(y, side));
}

/** Local frame of the chromatid axis at height y: radial directions are cos·n + sin·b. */
function axisFrame(y: number, side: number, n: THREE.Vector3, b: THREE.Vector3): void {
  const h = 0.5;
  const tx = armBend(y + h) - armBend(y - h) + side * (sisterOffset(y + h) - sisterOffset(y - h));
  const tz = sisterZ(y + h, side) - sisterZ(y - h, side);
  const t = new THREE.Vector3(tx, 2 * h, tz).normalize();
  n.crossVectors(t, new THREE.Vector3(0, 0, 1)).normalize();
  b.crossVectors(n, t).normalize();
}

/** Surface relief (fibrous chromatin) and colour factors at an undisplaced surface point. */
function chromatinRelief(noise: Simplex3, p: THREE.Vector3): { disp: number; shade: number } {
  const lumps = noise.fbm(p.x * 0.021, p.y * 0.021, p.z * 0.021, 3);
  const ridge = 1 - Math.abs(noise.noise(p.x * 0.085 + 11.3, p.y * 0.062, p.z * 0.085 - 4.1));
  const ridge2 = 1 - Math.abs(noise.noise(p.x * 0.16 - 7.7, p.y * 0.13 + 3.3, p.z * 0.16));
  const disp = lumps * 4.6 + (ridge * ridge - 0.45) * 4.2 + (ridge2 * ridge2 - 0.45) * 1.6;
  const shade = 0.74 + 0.3 * ridge * ridge + 0.1 * lumps + 0.08 * ridge2;
  return { disp, shade };
}

function tipFade(y: number): number {
  return THREE.MathUtils.smoothstep(MP.half - Math.abs(y), 0, 18);
}

/** One sister chromatid: a noise-displaced tube with rounded tips and a pinched centromere. */
function chromatidGeometry(side: number, noise: Simplex3, rings: number, radial: number): THREE.BufferGeometry {
  // Parametrise by meridian length so the tips and the constriction get more rings.
  const fine = 2000;
  const cum = new Float64Array(fine + 1);
  let prevY = -MP.half;
  let prevR = 0;
  for (let k = 1; k <= fine; k++) {
    const y = -MP.half + (2 * MP.half * k) / fine;
    const r = profileRadius(y, side);
    cum[k] = cum[k - 1] + Math.hypot(y - prevY, r - prevR);
    prevY = y;
    prevR = r;
  }
  const total = cum[fine];
  const ys: number[] = [];
  let k = 0;
  for (let i = 1; i < rings; i++) {
    const target = (i / rings) * total;
    while (k < fine && cum[k + 1] < target) k++;
    const f = (target - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]);
    ys.push(-MP.half + ((k + f) / fine) * 2 * MP.half);
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  const pushVertex = (pos: THREE.Vector3, shade: number, y: number) => {
    positions.push(pos.x, pos.y, pos.z);
    color.copy(CHROMATID_COLOR).multiplyScalar(shade);
    const glow = 1 - THREE.MathUtils.smoothstep(MP.half - Math.abs(y), 6, 34);
    color.lerp(TELOMERE_COLOR, glow * 0.92);
    colors.push(color.r, color.g, color.b);
  };

  // Bottom apex.
  axisPoint(-MP.half, side, c);
  pushVertex(c, 1, -MP.half);
  for (const y of ys) {
    axisPoint(y, side, c);
    axisFrame(y, side, n, b);
    const r = profileRadius(y, side);
    const fade = tipFade(y);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU;
      d.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
      p.copy(c).addScaledVector(d, r);
      const relief = chromatinRelief(noise, p);
      p.addScaledVector(d, relief.disp * fade);
      pushVertex(p, THREE.MathUtils.lerp(1, relief.shade, fade), y);
    }
  }
  axisPoint(MP.half, side, c);
  pushVertex(c, 1, MP.half);
  const top = positions.length / 3 - 1;
  const ringStart = (i: number) => 1 + i * radial;
  for (let j = 0; j < radial; j++) indices.push(0, ringStart(0) + j, ringStart(0) + ((j + 1) % radial));
  for (let i = 0; i < ys.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = ringStart(i) + j;
      const a2 = ringStart(i) + ((j + 1) % radial);
      const bb = ringStart(i + 1) + j;
      const b2 = ringStart(i + 1) + ((j + 1) % radial);
      indices.push(a, bb, a2, a2, bb, b2);
    }
  }
  const last = ringStart(ys.length - 1);
  for (let j = 0; j < radial; j++) indices.push(top, last + ((j + 1) % radial), last + j);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A chromatin loop: an arc of a torus whose two feet sit in the surface (local +y = outward). */
function loopGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const radial = byQuality(quality, { low: 3, medium: 4, high: 5 });
  const tubular = byQuality(quality, { low: 6, medium: 8, high: 10 });
  const g = new THREE.TorusGeometry(1, 0.19, radial, tubular, Math.PI * 1.3);
  g.rotateZ(-0.15 * Math.PI);
  g.deleteAttribute('uv');
  return g;
}

export function buildMetaphase(ctx: BuildContext): CloseupViewBuild {
  const { quality } = ctx;
  const rng = new Rng('closeup:chromosomes:metaphase');
  const noise = new Simplex3('closeup:chromosomes:chromatin');
  const group = new THREE.Group();
  group.name = 'metaphase';
  const chromosome = new THREE.Group();
  group.add(chromosome);

  // Sister chromatids.
  const rings = byQuality(quality, { low: 150, medium: 200, high: 250 });
  const radial = byQuality(quality, { low: 30, medium: 40, high: 52 });
  const chromatidMaterial = instancedMaterial({ vertexColors: true, roughness: 0.62 });
  addInstanceGlow(chromatidMaterial, 0.2, 'chromatid');
  const sisters = [-1, 1].map((side) => {
    const mesh = new THREE.Mesh(chromatidGeometry(side, noise, rings, radial), chromatidMaterial);
    chromosome.add(mesh);
    return mesh;
  });

  // Chromatin loops studding the surface (the fibrous texture of condensed chromatin).
  const loopCount = byQuality(quality, { low: 1400, medium: 2200, high: 3200 });
  const loops: Placement[] = [];
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const b = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();
  const loopPalette = ['#f47fd2', '#e85dc0', '#ff94de', '#d94fb3', '#f6a0e0', '#ea6fd0'].map((h) => new THREE.Color(h));
  const kinetochoreX = MP.offCen + MP.rCen + 7.5;
  const kinetochoreCenters = [-1, 1].map((side) => new THREE.Vector3(side * kinetochoreX, MP.centroY, sisterZ(MP.centroY, side)));
  let guard = 0;
  while (loops.length < loopCount && guard++ < loopCount * 8) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const y = rng.range(-MP.half + 14, MP.half - 14);
    const r = profileRadius(y, side);
    if (rng.next() > r / MP.rArm) continue;
    const a = rng.range(0, TAU);
    axisPoint(y, side, c);
    axisFrame(y, side, n, b);
    dir.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
    p.copy(c).addScaledVector(dir, r);
    const relief = chromatinRelief(noise, p);
    p.addScaledVector(dir, relief.disp * tipFade(y));
    // Keep the kinetochore plates clear.
    if (kinetochoreCenters.some((k) => k.distanceTo(p) < 17)) continue;
    const scale = rng.range(0, 1) < 0.7 ? rng.range(2.6, 4.6) : rng.range(4.6, 7.4);
    const tilt = new THREE.Vector3(rng.range(-0.35, 0.35), 0, rng.range(-0.35, 0.35));
    const up = dir.clone().add(tilt).normalize();
    const q = alignY(up, rng.range(0, TAU));
    loops.push({
      position: p.clone().addScaledVector(dir, -0.28 * scale),
      quaternion: q,
      scale,
      color: loopPalette[rng.int(0, loopPalette.length - 1)].clone().offsetHSL(rng.range(-0.015, 0.015), 0, rng.range(-0.05, 0.04)),
    });
  }
  const loopShape = loopGeometry(quality);
  const loopMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(loopMaterial, 0.2, 'chromatinLoops');
  const loopMesh = instanced(loopShape, loopMaterial, loops);
  chromosome.add(loopMesh);

  // Kinetochores: curved protein plates on the outer face of each sister's centromere.
  const plate = blobGeometry(1, 'closeup:kinetochore', 0.12, quality === 'low' ? 2 : 3);
  plate.scale(3.3, MP.kinetochoreRadius, MP.kinetochoreRadius);
  {
    const pos = plate.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      pos.setX(i, pos.getX(i) - (y * y + z * z) / (2 * 34));
    }
    plate.computeVertexNormals();
  }
  const kinetochoreMaterial = moleculeMaterial('#7ee8fa', { emissiveIntensity: 1.0, roughness: 0.4 });
  const kinetochores = [-1, 1].map((side) => {
    const mesh = new THREE.Mesh(plate, kinetochoreMaterial);
    mesh.position.set(side * kinetochoreX, MP.centroY, sisterZ(MP.centroY, side));
    if (side < 0) mesh.rotation.y = Math.PI;
    chromosome.add(mesh);
    return mesh;
  });

  // Kinetochore microtubules: plus ends embedded in the plate, minus ends at the far spindle poles.
  const mtGeometry = new THREE.CylinderGeometry(MP.mtRadius, MP.mtRadius, 1, quality === 'low' ? 6 : 8, 8, true);
  mtGeometry.translate(0, 0.5, 0);
  {
    const pos = mtGeometry.attributes.position as THREE.BufferAttribute;
    const rgba = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const v = pos.getY(i);
      rgba.set([1, 1, 1, 1 - THREE.MathUtils.smoothstep(v, 0.3, 0.62)], i * 4);
    }
    mtGeometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  }
  const mtMaterial = new THREE.MeshStandardMaterial({
    color: '#9bd4ff',
    emissive: '#9bd4ff',
    emissiveIntensity: 0.5,
    roughness: 0.45,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const microtubules = new THREE.InstancedMesh(mtGeometry, mtMaterial, MP.mtPerKinetochore * 2);
  microtubules.frustumCulled = false;
  group.add(microtubules);
  const mtStarts: THREE.Vector3[] = [];
  const mtEnds: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (let m = 0; m < MP.mtPerKinetochore; m++) {
      // Spread over the plate (sunflower pattern), plus ends at the plate's outer face.
      const f = (m + 0.5) / MP.mtPerKinetochore;
      const rr = Math.sqrt(f) * MP.kinetochoreRadius * 0.86;
      const aa = m * 2.39996 + (side > 0 ? 0 : 1.1);
      const dy = Math.cos(aa) * rr;
      const dz = Math.sin(aa) * rr;
      const bend = (dy * dy + dz * dz) / (2 * 34);
      mtStarts.push(new THREE.Vector3(side * (kinetochoreX + 1.8 - bend), MP.centroY + dy, sisterZ(MP.centroY, side) + dz));
      mtEnds.push(new THREE.Vector3(side * MP.poleX, MP.centroY + dy * 0.18 + rng.range(-3, 3), dz * 0.18 + rng.range(-3, 3)));
    }
  }

  // Telomeres: the four chromatid tips glow.
  const tips: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const y = end * (MP.half - 7);
      tips.push(axisPoint(y, side, new THREE.Vector3()));
    }
  }
  const tipCore = new THREE.SphereGeometry(9, 14, 10);
  const tipMaterial = new THREE.MeshStandardMaterial({ color: '#fff07a', emissive: '#fff07a', emissiveIntensity: 0.85, roughness: 0.4 });
  const tipMesh = instanced(tipCore, tipMaterial, tips.map((t) => ({ position: t })));
  chromosome.add(tipMesh);
  const glow = sparks(4, '#fff07a', 95, ctx.pointScale);
  tips.forEach((t, i) => glow.positions.set([t.x, t.y, t.z], i * 3));
  glow.commit();
  chromosome.add(glow.points);
  // A soft cyan halo marks each kinetochore plate.
  const kinetochoreGlow = sparks(2, '#7ee8fa', 62, ctx.pointScale);
  kinetochoreCenters.forEach((k, i) => kinetochoreGlow.positions.set([k.x + Math.sign(k.x) * 3, k.y, k.z], i * 3));
  kinetochoreGlow.alphas.fill(0.8);
  kinetochoreGlow.commit();
  chromosome.add(kinetochoreGlow.points);

  // Animation scratch.
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const start = new THREE.Vector3();
  const along = new THREE.Vector3();
  const updateMicrotubules = () => {
    chromosome.updateMatrix();
    for (let i = 0; i < mtStarts.length; i++) {
      start.copy(mtStarts[i]).applyMatrix4(chromosome.matrix);
      along.subVectors(mtEnds[i], start);
      const length = along.length();
      q.setFromUnitVectors(UP, along.divideScalar(length));
      s.set(1, length, 1);
      microtubules.setMatrixAt(i, m4.compose(start, q, s));
    }
    microtubules.instanceMatrix.needsUpdate = true;
  };
  updateMicrotubules();

  const chromatidAnchor = axisPoint(-120, -1, new THREE.Vector3()).add(new THREE.Vector3(-6, 0, MP.rArm));
  const centromereAnchor = new THREE.Vector3(0, MP.centroY, 11);
  const kinetochoreAnchor = new THREE.Vector3(kinetochoreX + 2, MP.centroY + 4, sisterZ(MP.centroY, 1) + 6);
  const endAnchor = tips[2].clone().add(new THREE.Vector3(6, -6, 10));
  const spindleAnchor = new THREE.Vector3(185, MP.centroY, 0);

  return {
    group,
    target: new THREE.Vector3(0, 0, 0),
    radius: 300,
    direction: new THREE.Vector3(0.34, 0.1, 1).normalize(),
    labels: [
      { part: 'chromatid', anchor: anchorOn(chromosome, chromatidAnchor) },
      { part: 'centromere', anchor: anchorOn(chromosome, centromereAnchor) },
      { part: 'kinetochore', anchor: anchorOn(chromosome, kinetochoreAnchor) },
      { part: 'chromosome-end', anchor: anchorOn(chromosome, endAnchor) },
      { textKey: 'closeupCaptions.spindle', anchor: anchorOn(group, spindleAnchor) },
    ],
    update(time, calm) {
      // Metaphase oscillation along the spindle axis: the kinetochore fibre on the
      // leading side shortens while the trailing one lengthens (plus ends at the kinetochore).
      const amp = calm ? 0.55 : 1;
      const w = (TAU * time) / 16;
      chromosome.position.x = 12 * amp * Math.sin(w);
      chromosome.rotation.z = 0.012 * amp * Math.sin(w + 1.1);
      chromosome.rotation.y = 0.05 * amp * Math.sin((TAU * time) / 23);
      updateMicrotubules();
      const pulse = calm ? 0.9 : 0.82 + 0.14 * Math.sin(time * 1.3);
      for (let i = 0; i < 4; i++) glow.alphas[i] = pulse;
      glow.commit();
    },
    dispose() {
      sisters.forEach((m) => m.geometry.dispose());
      kinetochores.forEach((m) => m.geometry.dispose());
      loopShape.dispose();
      glow.dispose();
      kinetochoreGlow.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Nucleosomes: "beads on a string" (1 unit = 1 nm)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nucleosome core particle (Luger et al. 1997): 147 bp of DNA, 1.65
 * left-handed superhelical turns of radius 4.18 nm (to the DNA axis) and
 * pitch 2.39 nm around a histone octamer; ~10 bp at each end run off
 * straight. The disc is ~11 nm across and ~6 nm thick.
 */
const NUC = {
  radius: 4.18,
  pitch: 2.39,
  turns: 1.65,
  flank: 10 * 0.34,
  rise: 0.34,
  midAngle: -Math.PI / 2,
};

const HISTONE_COLORS = { h2a: '#c58bff', h2b: '#ff8fb3', h3: '#8fb3ff', h4: '#ffb38f' } as const;
type HistoneKind = keyof typeof HISTONE_COLORS;

function superhelix(theta: number, target: THREE.Vector3): THREE.Vector3 {
  return target.set(NUC.radius * Math.cos(theta), NUC.radius * Math.sin(theta), (-NUC.pitch * (theta - NUC.midAngle)) / TAU);
}

function superhelixTangent(theta: number, target: THREE.Vector3): THREE.Vector3 {
  return target.set(-NUC.radius * Math.sin(theta), NUC.radius * Math.cos(theta), -NUC.pitch / TAU).normalize();
}

interface NucleosomePose {
  center: THREE.Vector3;
  quaternion: THREE.Quaternion;
  matrix: THREE.Matrix4;
}

export function buildNucleosomes(ctx: BuildContext): CloseupViewBuild {
  const { quality } = ctx;
  const rng = new Rng('closeup:chromosomes:nucleosomes');
  const group = new THREE.Group();
  group.name = 'nucleosomes';
  const fiber = new THREE.Group();
  group.add(fiber);

  const theta0 = NUC.midAngle - NUC.turns * Math.PI;
  const theta1 = NUC.midAngle + NUC.turns * Math.PI;
  const entryTangent = superhelixTangent(theta0, new THREE.Vector3());
  const exitTangent = superhelixTangent(theta1, new THREE.Vector3());
  const entryPoint = superhelix(theta0, new THREE.Vector3()).addScaledVector(entryTangent, -NUC.flank);
  const exitPoint = superhelix(theta1, new THREE.Vector3()).addScaledVector(exitTangent, NUC.flank);

  // ── Layout: the cores sit along a gentle zigzag; each core's orientation is
  // searched so the DNA leaving one core runs smoothly into the next one
  // through a gently curved linker of 20–50 bp.
  const coreX = [-30, -15, 0, 15, 30];
  /** Target contour length of each linker (nm) — about 41, 47, 35 and 44 bp; all must stay within 20–50 bp. */
  const linkerTarget = [14, 16, 12, 15];
  const LINKER_MIN = 7.5;
  const LINKER_MAX = 16.8;
  const count = coreX.length;
  const desired = coreX.map((x, i) => new THREE.Vector3(x, (i % 2 ? -1 : 1) * 3.2, (i % 2 ? 1 : -1) * 3.5));
  const viewDir = new THREE.Vector3(0.18, 0.42, 1).normalize();
  const poses: NucleosomePose[] = [];
  const candidate = new THREE.Quaternion();
  const ePos = new THREE.Vector3();
  const eTan = new THREE.Vector3();
  const link = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const plusX = new THREE.Vector3(1, 0, 0);
  const angleBetween = (a: THREE.Vector3, b: THREE.Vector3) => Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  /** Contour length of the linker Bézier (leaves along fromTan, arrives along toTan). */
  const bz = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const bzA = new THREE.Vector3();
  const bzB = new THREE.Vector3();
  const linkerContour = (from: THREE.Vector3, fromTan: THREE.Vector3, to: THREE.Vector3, toTan: THREE.Vector3) => {
    const d = from.distanceTo(to);
    bz[0].copy(from);
    bz[1].copy(from).addScaledVector(fromTan, d * 0.38);
    bz[2].copy(to).addScaledVector(toTan, -d * 0.38);
    bz[3].copy(to);
    let length = 0;
    bzA.copy(from);
    for (let k = 1; k <= 16; k++) {
      const t = k / 16;
      const u = 1 - t;
      bzB.set(0, 0, 0)
        .addScaledVector(bz[0], u * u * u)
        .addScaledVector(bz[1], 3 * u * u * t)
        .addScaledVector(bz[2], 3 * u * t * t)
        .addScaledVector(bz[3], t * t * t);
      length += bzA.distanceTo(bzB);
      bzA.copy(bzB);
    }
    return length;
  };
  /** Random unit vector within `maxAngle` of `axisDir`. */
  const perturb = (axisDir: THREE.Vector3, maxAngle: number, target: THREE.Vector3) => {
    const side = new THREE.Vector3().crossVectors(axisDir, Math.abs(axisDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : plusX).normalize();
    const angle = maxAngle * Math.sqrt(rng.next());
    side.applyAxisAngle(axisDir, rng.range(0, TAU));
    return target.copy(axisDir).applyAxisAngle(side, angle).normalize();
  };
  const chord = new THREE.Vector3();
  const tE = new THREE.Vector3();
  const centerC = new THREE.Vector3();
  const rollQ = new THREE.Quaternion();
  const facingOf = (q: THREE.Quaternion) => Math.abs(axis.set(0, 0, 1).applyQuaternion(q).dot(viewDir));
  // Beam search over the whole string: keep the best partial strings, extend each
  // with random gently-bent linkers, so later cores can still head on to the right.
  interface Partial {
    poses: NucleosomePose[];
    cost: number;
  }
  const BEAM = 24;
  const EXPAND = 600;
  let beam: Partial[] = [];
  for (let k = 0; k < EXPAND * 4; k++) {
    randomQuaternion(rng, candidate);
    // A core's net through-direction (entry + exit tangents) is its local +x axis.
    const cost = 1.5 * angleBetween(eTan.set(1, 0, 0).applyQuaternion(candidate), plusX) + 0.8 * (1 - facingOf(candidate));
    beam.push({ poses: [{ center: desired[0].clone(), quaternion: candidate.clone(), matrix: new THREE.Matrix4().compose(desired[0], candidate, new THREE.Vector3(1, 1, 1)) }], cost });
  }
  beam.sort((a, b) => a.cost - b.cost);
  beam = beam.slice(0, BEAM);
  for (let i = 1; i < count; i++) {
    const next: Partial[] = [];
    for (const partial of beam) {
      const prev = partial.poses[i - 1];
      const prevExit = exitPoint.clone().applyMatrix4(prev.matrix);
      const prevTan = exitTangent.clone().applyQuaternion(prev.quaternion);
      for (let k = 0; k < EXPAND; k++) {
        perturb(prevTan, 0.9, chord);
        const length = linkerTarget[i - 1] * rng.range(0.85, 1.12);
        ePos.copy(prevExit).addScaledVector(chord, length * 0.93);
        perturb(chord, 0.9, tE);
        candidate.setFromUnitVectors(entryTangent, tE);
        rollQ.setFromAxisAngle(tE, rng.range(0, TAU));
        candidate.premultiply(rollQ);
        centerC.copy(entryPoint).applyQuaternion(candidate).negate().add(ePos);
        const contour = linkerContour(prevExit, prevTan, ePos, tE);
        if (contour < LINKER_MIN || contour > LINKER_MAX) continue;
        let cost = 0.06 * centerC.distanceToSquared(desired[i]) + 0.15 * Math.abs(contour - linkerTarget[i - 1]);
        for (let j = 0; j < i; j++) {
          const dd = centerC.distanceTo(partial.poses[j].center);
          if (dd < 14) cost += (14 - dd) * 6;
        }
        for (let j = 0; j < i - 1; j++) {
          for (let u = 1; u < 4; u++) {
            link.copy(prevExit).lerp(ePos, u / 4);
            const dd = link.distanceTo(partial.poses[j].center);
            if (dd < 8) cost += (8 - dd) * 4;
          }
        }
        cost += 0.35 * (i % 2 === 0 ? 1 - facingOf(candidate) : facingOf(candidate));
        cost += 0.8 * angleBetween(eTan.set(1, 0, 0).applyQuaternion(candidate), plusX);
        const total = partial.cost + cost;
        if (next.length >= BEAM * 4 && total > next[next.length - 1].cost) continue;
        next.push({
          poses: [...partial.poses, { center: centerC.clone(), quaternion: candidate.clone(), matrix: new THREE.Matrix4().compose(centerC, candidate, new THREE.Vector3(1, 1, 1)) }],
          cost: total,
        });
        next.sort((a, b) => a.cost - b.cost);
        if (next.length > BEAM * 4) next.length = BEAM * 4;
      }
    }
    beam = next.slice(0, BEAM);
  }
  // The last core's exit should head on out of the view (to the right).
  beam.sort((a, b) => {
    const tail = (p: Partial) => angleBetween(exitTangent.clone().applyQuaternion(p.poses[count - 1].quaternion), plusX);
    return a.cost + tail(a) - (b.cost + tail(b));
  });
  poses.push(...beam[0].poses);

  // ── One continuous DNA axis through every wrap and linker.
  const points: THREE.Vector3[] = [];
  const linkerSegments: { from: THREE.Vector3; to: THREE.Vector3; mid: THREE.Vector3; bp: number }[] = [];
  const pushSegment = (from: THREE.Vector3, to: THREE.Vector3, step: number) => {
    const n = Math.max(1, Math.round(from.distanceTo(to) / step));
    for (let k = 1; k <= n; k++) points.push(from.clone().lerp(to, k / n));
  };
  const first = poses[0];
  const leadDir = entryTangent.clone().applyQuaternion(first.quaternion);
  const leadStart = entryPoint.clone().applyMatrix4(first.matrix).addScaledVector(leadDir, -24 * NUC.rise);
  points.push(leadStart);
  const tmp = new THREE.Vector3();
  poses.forEach((pose, i) => {
    const entryW = entryPoint.clone().applyMatrix4(pose.matrix);
    if (i === 0) {
      pushSegment(points[points.length - 1], entryW, 1.6);
    } else {
      // Linker: cubic Bézier leaving along the previous exit tangent and arriving along this entry tangent.
      const from = points[points.length - 1].clone();
      const fromTan = exitTangent.clone().applyQuaternion(poses[i - 1].quaternion);
      const toTan = entryTangent.clone().applyQuaternion(pose.quaternion);
      const d = from.distanceTo(entryW);
      const bezier = new THREE.CubicBezierCurve3(
        from.clone(),
        from.clone().addScaledVector(fromTan, d * 0.38),
        entryW.clone().addScaledVector(toTan, -d * 0.38),
        entryW.clone(),
      );
      const length = bezier.getLength();
      const n = Math.max(2, Math.round(length / 0.9));
      for (let k = 1; k <= n; k++) points.push(bezier.getPoint(k / n));
      linkerSegments.push({ from, to: entryW.clone(), mid: bezier.getPoint(0.5), bp: Math.round(length / NUC.rise) });
    }
    const wrapStart = superhelix(theta0, tmp).clone().applyMatrix4(pose.matrix);
    pushSegment(entryW, wrapStart, 1.2);
    const samples = Math.ceil(((theta1 - theta0) / TAU) * 40);
    for (let k = 1; k <= samples; k++) {
      points.push(superhelix(theta0 + ((theta1 - theta0) * k) / samples, tmp).clone().applyMatrix4(pose.matrix));
    }
    const exitW = exitPoint.clone().applyMatrix4(pose.matrix);
    pushSegment(points[points.length - 1], exitW, 1.2);
    if (i === poses.length - 1) {
      const outDir = exitTangent.clone().applyQuaternion(pose.quaternion);
      pushSegment(exitW, exitW.clone().addScaledVector(outDir, 26 * NUC.rise), 1.6);
    }
  });
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  let polyLength = 0;
  for (let k = 1; k < points.length; k++) polyLength += points[k].distanceTo(points[k - 1]);
  curve.arcLengthDivisions = Math.ceil(polyLength / 0.04);
  const dna = doubleHelix({
    curve,
    quality,
    strandColors: ['#dce9ff', '#a9c9ff'],
    baseColor: (i) => (i % 2 ? '#ffd58a' : '#fff1d6'),
  });
  fiber.add(dna.group);

  // ── Histone octamers: two layers of four (H2A, H2B, H3, H4), pseudo-twofold about the dyad.
  const shapes = proteinShapes('closeup:histone', 3, quality === 'low' ? 2 : 3, 0.2);
  const layerAngles: Record<HistoneKind, [number, number]> = {
    h2a: [45, 135],
    h2b: [135, 45],
    h4: [225, 315],
    h3: [315, 225],
  };
  const buckets: Placement[][] = shapes.map(() => []);
  const seedBuckets: number[][] = shapes.map(() => []);
  let histoneIndex = 0;
  const local = new THREE.Vector3();
  poses.forEach((pose) => {
    (Object.keys(layerAngles) as HistoneKind[]).forEach((kind) => {
      [1, -1].forEach((layer, li) => {
        const a = THREE.MathUtils.degToRad(layerAngles[kind][li]);
        local.set(Math.cos(a) * 1.6, Math.sin(a) * 1.6, layer * 1.42);
        const radialDir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
        const qLocal = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), radialDir);
        qLocal.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rng.range(0, TAU)));
        const k = histoneIndex % shapes.length;
        buckets[k].push({
          position: local.clone().applyMatrix4(pose.matrix),
          quaternion: pose.quaternion.clone().multiply(qLocal),
          scale: new THREE.Vector3(1.78, 1.62, 1.5).multiplyScalar(rng.range(0.95, 1.04)),
          color: new THREE.Color(HISTONE_COLORS[kind]).offsetHSL(0, 0, rng.range(-0.03, 0.03)),
        });
        seedBuckets[k].push(histoneIndex + 1);
        histoneIndex++;
      });
    });
  });
  const histoneMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(histoneMaterial, 0.18, 'histones');
  addJiggle(histoneMaterial, ctx.jiggle, new THREE.Vector3(0.06, 0.06, 0.06), 0.8, 'histoneJiggle');
  shapes.forEach((shape, k) => {
    if (!buckets[k].length) return;
    const mesh = instanced(shape, histoneMaterial, buckets[k]);
    setSeeds(mesh, seedBuckets[k]);
    fiber.add(mesh);
  });

  // ── Histone tails: short flexible chains that leave the core and wiggle.
  interface Tail {
    root: THREE.Vector3;
    dir: THREE.Vector3;
    u: THREE.Vector3;
    v: THREE.Vector3;
    phase: number;
    beads: number;
  }
  const tails: Tail[] = [];
  const tailColors: THREE.Color[] = [];
  const tailSpec: { kind: HistoneKind; r: number; da: number; z: number; out: number; lift: number }[] = [
    { kind: 'h3', r: 2.2, da: 0, z: 2.6, out: 0.75, lift: 0.6 },
    { kind: 'h4', r: 1.2, da: 0, z: 2.9, out: 0.45, lift: 0.9 },
    { kind: 'h2a', r: 2.4, da: -15, z: 2.3, out: 0.85, lift: 0.45 },
    { kind: 'h2a', r: 2.6, da: 30, z: 1.5, out: 0.95, lift: 0.25 },
    { kind: 'h2b', r: 2.5, da: 10, z: 2.5, out: 0.8, lift: 0.55 },
  ];
  const beadsPerTail = 7;
  poses.forEach((pose) => {
    tailSpec.forEach((spec) => {
      [1, -1].forEach((layer, li) => {
        const a = THREE.MathUtils.degToRad(layerAngles[spec.kind][li] + spec.da * layer);
        const radialDir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
        const rootLocal = radialDir.clone().multiplyScalar(spec.r).setZ(layer * spec.z);
        const dirLocal = radialDir.clone().multiplyScalar(spec.out).add(new THREE.Vector3(0, 0, layer * spec.lift)).normalize();
        const root = rootLocal.applyMatrix4(pose.matrix);
        const dir = dirLocal.applyQuaternion(pose.quaternion);
        const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
        const v = new THREE.Vector3().crossVectors(dir, u).normalize();
        tails.push({ root, dir, u, v, phase: rng.range(0, TAU), beads: beadsPerTail });
        tailColors.push(new THREE.Color(HISTONE_COLORS[spec.kind]).lerp(new THREE.Color('#ffffff'), 0.25));
      });
    });
  });
  const beadGeometry = new THREE.IcosahedronGeometry(1, quality === 'low' ? 0 : 1);
  const beadMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(beadMaterial, 0.2, 'histoneTails');
  const beadCount = tails.length * beadsPerTail;
  const beads = new THREE.InstancedMesh(beadGeometry, beadMaterial, beadCount);
  beads.frustumCulled = false;
  tails.forEach((_, ti) => {
    for (let k = 0; k < beadsPerTail; k++) beads.setColorAt(ti * beadsPerTail + k, tailColors[ti]);
  });
  if (beads.instanceColor) beads.instanceColor.needsUpdate = true;
  fiber.add(beads);
  const bp = new THREE.Vector3();
  const bd = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const beadRadius = 0.36;
  const spacing = 0.66;
  const updateTails = (time: number, calm: boolean) => {
    const amp = calm ? 0.45 : 1;
    const speed = calm ? 0.45 : 1;
    const t = time * speed;
    for (let ti = 0; ti < tails.length; ti++) {
      const tail = tails[ti];
      bp.copy(tail.root).addScaledVector(tail.dir, 0.3);
      for (let k = 0; k < tail.beads; k++) {
        const wob = (0.25 + 0.14 * k) * amp;
        bd.copy(tail.dir)
          .addScaledVector(tail.u, wob * Math.sin(t * 1.7 + tail.phase + k * 0.8))
          .addScaledVector(tail.v, wob * Math.sin(t * 1.3 + tail.phase * 1.7 + k * 0.65))
          .normalize();
        if (k > 0) bp.addScaledVector(bd, spacing);
        m4.makeScale(beadRadius, beadRadius, beadRadius).setPosition(bp);
        beads.setMatrixAt(ti * beadsPerTail + k, m4);
      }
    }
    beads.instanceMatrix.needsUpdate = true;
  };
  updateTails(0, false);

  // ── Framing and labels.
  const center = new THREE.Vector3();
  poses.forEach((pose) => center.add(pose.center));
  center.divideScalar(poses.length);
  const direction = viewDir;
  const faceAnchor = (pose: NucleosomePose) => {
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
    const sign = axis.dot(direction) >= 0 ? 1 : -1;
    return new THREE.Vector3(0.8, 0.6, sign * 3.1).applyMatrix4(pose.matrix);
  };
  const mid = poses[Math.floor(poses.length / 2)];
  // DNA label: the wrapped gyre point of nucleosome 1 that faces the camera most.
  const dnaPose = poses[1];
  let bestTheta = theta0;
  let bestDot = -Infinity;
  for (let k = 0; k <= 80; k++) {
    const th = theta0 + ((theta1 - theta0) * k) / 80;
    const radial = new THREE.Vector3(Math.cos(th), Math.sin(th), 0).applyQuaternion(dnaPose.quaternion);
    const dd = radial.dot(direction);
    if (dd > bestDot) {
      bestDot = dd;
      bestTheta = th;
    }
  }
  const dnaAnchor = superhelix(bestTheta, new THREE.Vector3())
    .multiplyScalar((NUC.radius + 1.1) / NUC.radius)
    .applyMatrix4(dnaPose.matrix);
  const longest = linkerSegments.reduce((a, s) => (s.bp > a.bp ? s : a), linkerSegments[0]);
  const linkerAnchor = longest.mid.clone().addScaledVector(direction, 1.2);

  // Pivot the gentle sway around the string's centre.
  fiber.position.copy(center);
  fiber.children.forEach((child) => child.position.sub(center));
  const toFiber = (p: THREE.Vector3) => p.clone().sub(center);

  return {
    group,
    target: center.clone(),
    radius: 45,
    direction,
    labels: [
      { part: 'nucleosome', anchor: anchorOn(fiber, toFiber(faceAnchor(mid))) },
      { part: 'dna', anchor: anchorOn(fiber, toFiber(dnaAnchor)) },
      { textKey: 'closeupCaptions.linkerDna', anchor: anchorOn(fiber, toFiber(linkerAnchor)) },
    ],
    update(time, calm) {
      const amp = calm ? 0.5 : 1;
      fiber.rotation.y = 0.07 * amp * Math.sin((TAU * time) / 17);
      fiber.rotation.x = 0.035 * amp * Math.sin((TAU * time) / 13 + 0.7);
      updateTails(time, calm);
    },
    dispose() {
      dna.dispose();
      shapes.forEach((g) => g.dispose());
      beadGeometry.dispose();
    },
  };
}
