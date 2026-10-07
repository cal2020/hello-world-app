import * as THREE from 'three';
import { Rng } from '../core/random';
import { Simplex3 } from '../core/noise';
import { blobGeometry, createCloseupScene, disposeScene, smooth } from './common';
import {
  addInstanceGlow,
  addJiggle,
  anchorOn,
  byQuality,
  createJiggle,
  instanced,
  instancedMaterial,
  moleculeMaterial,
  proteinShapes,
  randomQuaternion,
  scatter,
  setSeeds,
  type Placement,
} from './kit';
import { bowlGeometry, edgeRadius, ellipseFaceGeometry, hash01, noisyDiscGeometry } from './nucleolusParts';
import { fineCurve, polylineTube } from './telomeresParts';
import type { CloseupFactory } from './types';

/**
 * A slice through a nucleolus (1 unit = 10 nm; molecules drawn up to ×3).
 * The cut face (z = 0) faces the camera: a fibrillar centre (FC, ~200 nm)
 * inside its dense fibrillar shell (DFC, ~90 nm thick), embedded in the
 * granular component (GC) that fills the ~1 µm slice; nucleoplasm beyond.
 *
 * One rRNA gene runs along the FC/DFC border. RNA polymerase I molecules are
 * loaded at the promoter every 0.5 s and take 12 s to reach the terminator,
 * so ~24 growing chains (each tipped by an early processing knob) form a
 * "Christmas tree". Released transcripts compact into pre-ribosomal particles
 * that cross the DFC, are joined by proteins, split into small (40S) and
 * large (60S) subunits in the GC, mature, and drift out to the nucleoplasm.
 * Every lineage is a pure function of time, so the flow is exactly periodic.
 */

const SLICE = 50;
const EDGE_NOISE = 0.06;
const FC = new THREE.Vector3(-9, -6, 0);
const FC_RADII = new THREE.Vector2(13, 10);
const DFC_THICKNESS = 10;
const DFC_RADII = new THREE.Vector2(FC_RADII.x + DFC_THICKNESS, FC_RADII.y + DFC_THICKNESS);

/** Gene arc on the FC/DFC border: ellipse angle from promoter to terminator. */
const GENE_FROM = THREE.MathUtils.degToRad(138);
const GENE_TO = THREE.MathUtils.degToRad(-12);
const GENE_SCALE = 1.05;
const GENE_Z = 1.55;

const T = {
  gene: 12,
  interval: 0.5,
  release: 0.8,
  travel: 2.2,
  split: 0.9,
  mature: 2.1,
  drift: 4.4,
};
const POST = T.release + T.travel + T.split + T.mature + T.drift;
const LIFETIME = T.gene + POST;
const CHAIN_MAX = 9.2;
const CHAIN_SEGMENTS = 9;
const SLOTS = 97;
const TRACK = 8;

const SMALL_RADIUS = 2.8;
const LARGE_RADIUS = 3.4;
const SMALL_COLOR = new THREE.Color('#f6d58c');
const LARGE_COLOR = new THREE.Color('#e3a83a');
const PARTICLE_PINK = new THREE.Color('#ff7fb3');
const PARTICLE_ORANGE = new THREE.Color('#f39a5a');
const FADE_COLOR = new THREE.Color('#2a1a22');
const BEAD_ORANGE = new THREE.Color('#ffb26b');

function genePoint(s: number, target: THREE.Vector3): THREE.Vector3 {
  const a = THREE.MathUtils.lerp(GENE_FROM, GENE_TO, s);
  return target.set(FC.x + Math.cos(a) * FC_RADII.x * GENE_SCALE, FC.y + Math.sin(a) * FC_RADII.y * GENE_SCALE, GENE_Z);
}

function geneNormal(s: number, target: THREE.Vector3): THREE.Vector3 {
  const a = THREE.MathUtils.lerp(GENE_FROM, GENE_TO, s);
  return target.set(Math.cos(a) / FC_RADII.x, Math.sin(a) / FC_RADII.y, 0).normalize();
}

function geneTangent(s: number, target: THREE.Vector3): THREE.Vector3 {
  const a = THREE.MathUtils.lerp(GENE_FROM, GENE_TO, s);
  return target.set(Math.sin(a) * FC_RADII.x, -Math.cos(a) * FC_RADII.y, 0).normalize();
}

interface Slot {
  /** Lateral wobble phases of the chain. */
  phase: number;
  lean: number;
  path: THREE.CatmullRomCurve3;
  /** Path parameter where the particle splits (end of travel). */
  splitU: number;
  side: THREE.Vector3;
  smallLag: number;
  spin: number;
  beadDirs: THREE.Vector3[];
}

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#170d18');
  const rng = new Rng('closeup:nucleolus');
  const noise = new Simplex3('closeup:nucleolus:texture');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);

  // ── Static structure ───────────────────────────────────────────────────
  // Back of the slice: the dark matrix between granules.
  const backing = new THREE.Mesh(noisyDiscGeometry(SLICE + 1, -9.5, noise, EDGE_NOISE), moleculeMaterial('#4a2116', { emissiveIntensity: 0.25, roughness: 0.9 }));
  root.add(backing);

  // Fibrillar centre: pale cut face plus a shallow bowl behind it.
  const fcFace = ellipseFaceGeometry(
    { center: new THREE.Vector3(FC.x, FC.y, 0.05), inner: new THREE.Vector2(0, 0), outer: FC_RADII },
    byQuality(quality, { low: 10, medium: 14, high: 18 }),
    byQuality(quality, { low: 64, medium: 96, high: 128 }),
    (x, y) => 0.18 + 0.22 * noise.fbm(x * 0.25, y * 0.25, 1.5, 2),
    (x, y, _t, c) => {
      const n = noise.fbm(x * 0.35, y * 0.35, 7.1, 3);
      const fib = 1 - Math.abs(noise.noise(x * 0.9, y * 0.9, 2.2));
      return c.set('#ffd8c2').multiplyScalar(0.84 + 0.12 * n + 0.08 * fib * fib);
    },
  );
  const faceMaterial = instancedMaterial({ vertexColors: true, roughness: 0.75 });
  addInstanceGlow(faceMaterial, 0.2, 'nucleolusFaces');
  root.add(new THREE.Mesh(fcFace, faceMaterial));
  root.add(new THREE.Mesh(bowlGeometry(FC, new THREE.Vector3(FC_RADII.x, FC_RADII.y, 6.5), noise, 0.08), moleculeMaterial('#f2c3a8', { roughness: 0.8 })));

  // Dense fibrillar component: orange ring with a fibrous texture, bowl behind.
  const dfcFace = ellipseFaceGeometry(
    { center: new THREE.Vector3(FC.x, FC.y, 0), inner: FC_RADII, outer: DFC_RADII },
    byQuality(quality, { low: 8, medium: 10, high: 14 }),
    byQuality(quality, { low: 96, medium: 144, high: 192 }),
    (x, y, t) => 0.25 + 0.3 * noise.fbm(x * 0.3, y * 0.3, 4.4, 2) * Math.sin(Math.PI * t),
    (x, y, _t, c) => {
      const a = Math.atan2(y - FC.y, x - FC.x);
      const streak = 1 - Math.abs(noise.noise(Math.cos(a) * 3.2 + x * 0.12, Math.sin(a) * 3.2 + y * 0.12, (x + y) * 0.45));
      const n = noise.fbm(x * 0.4, y * 0.4, 9.3, 2);
      return c.set('#ff9a6b').multiplyScalar(0.66 + 0.28 * streak * streak + 0.07 * n);
    },
  );
  root.add(new THREE.Mesh(dfcFace, faceMaterial));
  root.add(
    new THREE.Mesh(
      bowlGeometry(FC, new THREE.Vector3(DFC_RADII.x, DFC_RADII.y, 9.2), noise, 0.06),
      moleculeMaterial('#e8865a', { roughness: 0.8 }),
    ),
  );

  // DFC fibrils: short curled strands lying on the ring.
  const fibrilShape = new THREE.TorusGeometry(1, 0.13, 4, byQuality(quality, { low: 6, medium: 8, high: 10 }), Math.PI * 0.9);
  fibrilShape.deleteAttribute('uv');
  const fibrils: Placement[] = [];
  const fibrilCount = byQuality(quality, { low: 220, medium: 340, high: 460 });
  for (let i = 0; i < fibrilCount; i++) {
    const a = rng.range(0, Math.PI * 2);
    const t = rng.range(0.08, 0.95);
    const x = FC.x + Math.cos(a) * THREE.MathUtils.lerp(FC_RADII.x, DFC_RADII.x, t);
    const y = FC.y + Math.sin(a) * THREE.MathUtils.lerp(FC_RADII.y, DFC_RADII.y, t);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a + Math.PI / 2 + rng.range(-0.6, 0.6));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rng.range(-0.5, 0.5)));
    fibrils.push({
      position: new THREE.Vector3(x, y, 0.45),
      quaternion: q,
      scale: rng.range(0.9, 1.7),
      color: new THREE.Color(rng.pick(['#d2683f', '#e47b50', '#c45c38', '#f2946a'])),
    });
  }
  const fibrilMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(fibrilMaterial, 0.16, 'dfcFibrils');
  root.add(instanced(fibrilShape, fibrilMaterial, fibrils));

  // Granular component: densely packed granules (pre-ribosomal particles) out to the rim.
  const granuleShapes = proteinShapes('closeup:nucleolus:granule', 3, quality === 'low' ? 0 : 1, 0.26);
  const granuleCount = byQuality(quality, { low: 1150, medium: 1600, high: 2200 });
  const box = new THREE.Box3(new THREE.Vector3(-SLICE - 2, -SLICE - 2, -8.6), new THREE.Vector3(SLICE + 2, SLICE + 2, 0.2));
  const granuleSpots = scatter(
    rng,
    box,
    granuleCount,
    () => rng.range(1.0, 1.55),
    (p, r) => {
      const a = Math.atan2(p.y, p.x);
      const edge = edgeRadius(SLICE, a, noise, EDGE_NOISE);
      const d = Math.hypot(p.x, p.y);
      if (d > edge - r * 0.5) return true;
      if (d > edge - 5 && rng.next() < (d - edge + 5) / 7) return true;
      const ex = (p.x - FC.x) / (DFC_RADII.x + r * 0.6);
      const ey = (p.y - FC.y) / (DFC_RADII.y + r * 0.6);
      const ez = p.z / (9.2 + r);
      return ex * ex + ey * ey + ez * ez < 1;
    },
    14,
  );
  const granulePalette = ['#e0693c', '#cc5a33', '#e8774a', '#c2512e', '#ec7f4e', '#d6633a'].map((c) => new THREE.Color(c));
  const granuleMaterial = instancedMaterial({ roughness: 0.62 });
  addInstanceGlow(granuleMaterial, 0.12, 'granules');
  addJiggle(granuleMaterial, jiggle, new THREE.Vector3(0.14, 0.14, 0.1), 0.5, 'granuleJiggle');
  const granuleBuckets: Placement[][] = granuleShapes.map(() => []);
  const granuleSeeds: number[][] = granuleShapes.map(() => []);
  granuleSpots.forEach((spot, i) => {
    const k = i % granuleShapes.length;
    granuleBuckets[k].push({
      position: spot.position,
      quaternion: randomQuaternion(rng),
      scale: spot.radius,
      color: granulePalette[i % granulePalette.length].clone().offsetHSL(rng.range(-0.01, 0.01), 0, rng.range(-0.06, 0.04)),
    });
    granuleSeeds[k].push(i + 1);
  });
  granuleShapes.forEach((shape, k) => {
    const mesh = instanced(shape, granuleMaterial, granuleBuckets[k]);
    setSeeds(mesh, granuleSeeds[k]);
    root.add(mesh);
  });

  // A sprinkling of nucleoplasm particles beyond the rim.
  const nucleoplasm: Placement[] = [];
  for (let i = 0; i < byQuality(quality, { low: 140, medium: 200, high: 260 }); i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = edgeRadius(SLICE, a, noise, EDGE_NOISE) + rng.range(3, 30);
    nucleoplasm.push({
      position: new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, rng.range(-9, 0)),
      quaternion: randomQuaternion(rng),
      scale: rng.range(0.45, 1.0),
      color: new THREE.Color(rng.pick(['#5d6c94', '#6f7fa8', '#7c6f9c'])).multiplyScalar(rng.range(0.7, 1)),
    });
  }
  const plasmMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(plasmMaterial, 0.12, 'nucleoplasm');
  root.add(instanced(granuleShapes[0], plasmMaterial, nucleoplasm));

  // Ribosomal DNA: wanders in the FC, runs along the border for the transcribed gene, returns.
  const rdnaPoints: THREE.Vector3[] = [];
  const pre = [
    [-5.5, -4.8],
    [-8.4, -1.6],
    [-9.8, 2.2],
  ].map(([x, y]) => new THREE.Vector3(FC.x + x, FC.y + y, GENE_Z));
  const post = [
    [10.5, -4.6],
    [6.2, -6.4],
    [1.5, -5.2],
    [-1.8, -2.4],
  ].map(([x, y]) => new THREE.Vector3(FC.x + x, FC.y + y, GENE_Z));
  rdnaPoints.push(...pre);
  for (let k = 0; k <= 60; k++) rdnaPoints.push(genePoint(k / 60, new THREE.Vector3()));
  rdnaPoints.push(...post);
  const rdnaCurve = fineCurve(rdnaPoints, 0.05);
  const rdnaSamples = rdnaCurve.getSpacedPoints(Math.ceil(rdnaCurve.getLength() / 0.35));
  const rdna = new THREE.Mesh(polylineTube(rdnaSamples, 0.33, quality === 'low' ? 6 : 8), moleculeMaterial('#7fb2ff', { emissiveIntensity: 0.35, roughness: 0.4 }));
  root.add(rdna);

  // ── Per-lineage variation (slot = lineage index mod SLOTS) ───────────────
  const releaseAt = genePoint(1, new THREE.Vector3()).addScaledVector(geneNormal(1, new THREE.Vector3()), CHAIN_MAX * 0.45);
  const makeSlot = (k: number, angleDeg: number): Slot => {
    const angle = THREE.MathUtils.degToRad(angleDeg);
    const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    // Exit point on the DFC rim in this general direction, then into the GC and out to the rim.
    const fromFc = new THREE.Vector3(Math.cos(angle) * 1.1 + 0.6, Math.sin(angle), 0).normalize();
    const rim = 1 / Math.sqrt((fromFc.x / DFC_RADII.x) ** 2 + (fromFc.y / DFC_RADII.y) ** 2);
    const border = FC.clone().addScaledVector(fromFc, rim + 1.5).setZ(2.2);
    const middle = releaseAt.clone().lerp(border, 0.5).addScaledVector(fromFc, 1.5).setZ(2.0);
    const splitPoint = border.clone().addScaledVector(dir, 9 + 3.5 * hash01(k, 2)).setZ(2.6);
    const edgeA = Math.atan2(splitPoint.y, splitPoint.x) * 0.35 + angle * 0.65;
    const edge = edgeRadius(SLICE, edgeA, noise, EDGE_NOISE);
    const outer = new THREE.Vector3(Math.cos(edgeA) * edge, Math.sin(edgeA) * edge, 2.4);
    const beyond = new THREE.Vector3(Math.cos(edgeA) * (edge + 9), Math.sin(edgeA) * (edge + 9), 2.0);
    const drift1 = splitPoint.clone().lerp(outer, 0.45).add(new THREE.Vector3(0, 0, 0.6 + hash01(k, 3)));
    const path = new THREE.CatmullRomCurve3([releaseAt.clone(), middle, border, splitPoint, drift1, outer, beyond], false, 'centripetal', 0.5);
    path.arcLengthDivisions = 400;
    const lengths = path.getLengths(6 * 40);
    const splitU = lengths[3 * 40] / lengths[lengths.length - 1];
    const tangent = path.getTangentAt(splitU);
    const side = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize().multiplyScalar(hash01(k, 4) < 0.5 ? 1 : -1);
    const beadDirs = Array.from({ length: 5 }, (_, b) => {
      const a = (b / 5) * Math.PI * 2 + hash01(k, 10 + b) * 0.8;
      return new THREE.Vector3(Math.cos(a), Math.sin(a), 0.35 * (hash01(k, 20 + b) - 0.5)).normalize();
    });
    return {
      phase: hash01(k, 5) * Math.PI * 2,
      lean: (hash01(k, 6) - 0.5) * 0.5,
      path,
      splitU,
      side,
      smallLag: 0.04 + 0.05 * hash01(k, 7),
      spin: hash01(k, 8) * Math.PI * 2,
      beadDirs,
    };
  };
  const slots = Array.from({ length: SLOTS }, (_, k) => makeSlot(k, THREE.MathUtils.lerp(-75, 130, hash01(k, 1))));
  // Every TRACK-th lineage carries the subunit labels; it drifts into open space (downward).
  const trackedSlots = [-100, -86, -112, -94].map((a, i) => makeSlot(SLOTS + i, a));
  const slotOf = (k: number) => {
    if (((k % TRACK) + TRACK) % TRACK === 0) return trackedSlots[(((k / TRACK) % trackedSlots.length) + trackedSlots.length) % trackedSlots.length];
    return slots[((k % SLOTS) + SLOTS) % SLOTS];
  };

  // ── Dynamic pools ───────────────────────────────────────────────────────
  const maxChains = Math.ceil((T.gene + T.release) / T.interval) + 2;
  const maxParticles = Math.ceil((T.travel + T.split) / T.interval) + 2;
  const maxSubunits = Math.ceil((T.split + T.mature + T.drift) / T.interval) + 2;

  const segGeometry = new THREE.CylinderGeometry(0.42, 0.42, 1, 6, 1, true);
  segGeometry.translate(0, 0.5, 0);
  const chainMaterial = moleculeMaterial('#ff7fb3', { emissiveIntensity: 0.42, roughness: 0.45 });
  const segments = new THREE.InstancedMesh(segGeometry, chainMaterial, maxChains * CHAIN_SEGMENTS);
  const knobGeometry = blobGeometry(1, 'closeup:nucleolus:knob', 0.18, 1);
  const knobMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(knobMaterial, 0.25, 'knobs');
  const knobs = new THREE.InstancedMesh(knobGeometry, knobMaterial, maxChains);
  const polGeometry = blobGeometry(1, 'closeup:nucleolus:pol1', 0.22, 1);
  const polMaterial = moleculeMaterial('#ece2ff', { emissiveIntensity: 0.25, roughness: 0.5 });
  const polymerases = new THREE.InstancedMesh(polGeometry, polMaterial, maxChains);
  const particleGeometry = blobGeometry(1, 'closeup:nucleolus:particle', 0.24, 2);
  const particleMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(particleMaterial, 0.22, 'preRibosomes');
  const particles = new THREE.InstancedMesh(particleGeometry, particleMaterial, maxParticles);
  const beadGeometry = new THREE.IcosahedronGeometry(1, 0);
  const beadMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(beadMaterial, 0.25, 'joiningProteins');
  const beads = new THREE.InstancedMesh(beadGeometry, beadMaterial, maxParticles * 5);
  const smallGeometry = blobGeometry(1, 'closeup:nucleolus:40s', 0.26, 2);
  smallGeometry.scale(1.15, 0.82, 0.95);
  const largeGeometry = blobGeometry(1, 'closeup:nucleolus:60s', 0.22, 2);
  largeGeometry.scale(1.08, 0.94, 1.0);
  const subunitMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(subunitMaterial, 0.24, 'subunits');
  const smalls = new THREE.InstancedMesh(smallGeometry, subunitMaterial, maxSubunits);
  const larges = new THREE.InstancedMesh(largeGeometry, subunitMaterial, maxSubunits);
  const dynamicMeshes = [segments, knobs, polymerases, particles, beads, smalls, larges];
  for (const mesh of dynamicMeshes) {
    mesh.frustumCulled = false;
    mesh.count = 0;
    root.add(mesh);
  }
  // Make sure the colour buffers exist before the first frame.
  const white = new THREE.Color('#ffffff');
  for (const mesh of [knobs, particles, beads, smalls, larges]) {
    for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, white);
  }

  // ── Animation ───────────────────────────────────────────────────────────
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const color = new THREE.Color();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const chainPts = Array.from({ length: CHAIN_SEGMENTS + 1 }, () => new THREE.Vector3());
  const smallTracked = new THREE.Vector3();
  const largeTracked = new THREE.Vector3();
  let trackedVisible = false;
  const knobColor = new THREE.Color('#ff5f97');

  const alignUp = new THREE.Vector3(0, 1, 0);
  const putSegment = (index: number, a: THREE.Vector3, b: THREE.Vector3) => {
    dir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) {
      segments.setMatrixAt(index, m4.makeScale(0, 0, 0));
      return;
    }
    q.setFromUnitVectors(alignUp, dir.divideScalar(len));
    sc.set(1, len, 1);
    segments.setMatrixAt(index, m4.compose(a, q, sc));
  };

  /** Chain shape for lineage k at progress s (0–1), contracted toward its middle by `collapse`. */
  const buildChain = (k: number, s: number, length: number, collapse: number, t: number) => {
    const slot = slotOf(k);
    genePoint(s, chainPts[0]);
    geneNormal(s, nrm);
    geneTangent(s, tan);
    const step = length / CHAIN_SEGMENTS;
    for (let j = 1; j <= CHAIN_SEGMENTS; j++) {
      const w = 0.32 * Math.sin(slot.phase + j * 0.95 + t * 0.7) + slot.lean;
      dir.copy(nrm).addScaledVector(tan, w).addScaledVector(zAxis, 0.12 * Math.sin(slot.phase * 1.7 + j * 1.3)).normalize();
      chainPts[j].copy(chainPts[j - 1]).addScaledVector(dir, step);
    }
    if (collapse > 0) {
      p2.copy(chainPts[Math.floor(CHAIN_SEGMENTS * 0.55)]);
      for (let j = 0; j <= CHAIN_SEGMENTS; j++) chainPts[j].lerp(p2, collapse);
    }
  };

  const update = (t: number, calm: boolean) => {
    const newest = Math.floor(t / T.interval);
    const oldest = Math.ceil((t - LIFETIME) / T.interval);
    let nChain = 0;
    let nParticle = 0;
    let nBead = 0;
    let nSub = 0;
    trackedVisible = false;
    const wob = calm ? 0.4 : 1;
    for (let k = newest; k >= oldest; k--) {
      const age = t - k * T.interval;
      if (age < 0) continue;
      const slot = slotOf(k);
      if (age < T.gene + T.release) {
        // Transcription (and the release of the finished chain).
        const s = Math.min(1, age / T.gene);
        const collapse = age > T.gene ? smooth((age - T.gene) / T.release) : 0;
        const length = CHAIN_MAX * Math.pow(s, 0.9);
        buildChain(k, s, length, collapse, t * wob);
        if (length > 0.05) {
          for (let j = 0; j < CHAIN_SEGMENTS; j++) putSegment(nChain * CHAIN_SEGMENTS + j, chainPts[j], chainPts[j + 1]);
        } else {
          for (let j = 0; j < CHAIN_SEGMENTS; j++) segments.setMatrixAt(nChain * CHAIN_SEGMENTS + j, m4.makeScale(0, 0, 0));
        }
        // Terminal knob (early processing particle) grows as the chain grows.
        const knobR = (0.6 + 0.75 * s) * (1 + 0.3 * collapse);
        const tip = collapse > 0 ? p.copy(chainPts[CHAIN_SEGMENTS]).lerp(releaseAt, collapse) : chainPts[CHAIN_SEGMENTS];
        knobs.setMatrixAt(nChain, m4.makeScale(knobR, knobR, knobR).setPosition(tip));
        knobs.setColorAt(nChain, color.copy(knobColor).lerp(PARTICLE_PINK, collapse));
        // RNA polymerase I on the gene (released at the terminator).
        const polR = 0.85 * (1 - smooth((age - T.gene) / (T.release * 0.7)));
        genePoint(s, p2).addScaledVector(geneNormal(s, nrm), 0.2);
        p2.z += 0.25;
        polymerases.setMatrixAt(nChain, m4.makeScale(polR, polR * 0.85, polR).setPosition(p2));
        nChain++;
        continue;
      }
      const post = age - T.gene - T.release;
      if (post < T.travel + T.split) {
        // Pre-ribosomal particle crossing the DFC, joined by proteins; then it splits.
        const u = Math.min(1, post / T.travel);
        const pathU = slot.splitU * smooth(u);
        slot.path.getPoint(pathU, p);
        const r = THREE.MathUtils.lerp(1.75, 2.4, u);
        if (post < T.travel) {
          particles.setMatrixAt(nParticle, m4.compose(p, q.setFromAxisAngle(zAxis, slot.spin + u * 1.5), sc.setScalar(r)));
          particles.setColorAt(nParticle, color.copy(PARTICLE_PINK).lerp(PARTICLE_ORANGE, smooth(u * 1.2)));
          nParticle++;
          // Proteins converge onto the particle and are absorbed.
          for (let b = 0; b < 5; b++) {
            const local = THREE.MathUtils.clamp(u * 1.6 - b * 0.12, 0, 1);
            const dist = THREE.MathUtils.lerp(5.5, r * 0.85, smooth(local));
            const br = local >= 1 ? 0 : 0.5;
            p2.copy(p).addScaledVector(slot.beadDirs[b], dist);
            beads.setMatrixAt(nBead, m4.makeScale(br, br, br).setPosition(p2));
            beads.setColorAt(nBead, b % 2 ? SMALL_COLOR : BEAD_ORANGE);
            nBead++;
          }
          continue;
        }
      }
      // Split into small and large subunits, which mature and drift out.
      const sub = post - T.travel;
      const splitT = smooth(Math.min(1, sub / T.split));
      const matureT = smooth((sub - T.split) / T.mature);
      const driftT = Math.max(0, (sub - T.split - T.mature) / T.drift);
      const along = slot.splitU + (1 - slot.splitU) * (0.03 * splitT + 0.97 * driftT);
      slot.path.getPoint(Math.min(1, along), p);
      slot.path.getPoint(Math.min(1, Math.max(0, along - slot.smallLag)), p2);
      const sep = 2.2 + 1.6 * splitT;
      const radius = Math.hypot(p.x, p.y);
      const edge = edgeRadius(SLICE, Math.atan2(p.y, p.x), noise, EDGE_NOISE);
      const fade = THREE.MathUtils.clamp((radius - (edge - 6)) / 12, 0, 1);
      const vis = (1 - smooth(fade)) * (1 - smooth((driftT - 0.88) / 0.12));
      const loose = 1 + 0.25 * (1 - matureT);
      // Large subunit.
      dir.copy(slot.side).multiplyScalar(sep * 0.45);
      p.add(dir);
      const grow = 0.5 + 0.2 * splitT + 0.3 * matureT;
      const lr = LARGE_RADIUS * loose * grow * vis;
      larges.setMatrixAt(nSub, m4.compose(p, q.setFromAxisAngle(zAxis, slot.spin + sub * 0.25), sc.set(lr, lr * (1.06 - 0.12 * matureT), lr)));
      larges.setColorAt(nSub, color.copy(PARTICLE_ORANGE).lerp(LARGE_COLOR, matureT).lerp(FADE_COLOR, fade * 0.85));
      // Small subunit.
      p2.addScaledVector(dir, -1.25);
      const sr = SMALL_RADIUS * loose * grow * vis;
      smalls.setMatrixAt(nSub, m4.compose(p2, q.setFromAxisAngle(zAxis, slot.spin * 1.3 - sub * 0.3), sc.set(sr, sr * (1.08 - 0.14 * matureT), sr)));
      smalls.setColorAt(nSub, color.copy(PARTICLE_ORANGE).lerp(SMALL_COLOR, matureT).lerp(FADE_COLOR, fade * 0.85));
      nSub++;
      // Label tracking: every 12th lineage, while its subunits are formed and still inside.
      if (((k % TRACK) + TRACK) % TRACK === 0 && sub > T.split + T.mature + 0.3 && sub < T.split + T.mature + T.drift * 0.86) {
        smallTracked.copy(p2);
        smallTracked.z += sr * 0.8;
        largeTracked.copy(p);
        largeTracked.z += lr * 0.8;
        trackedVisible = true;
      }
    }
    segments.count = nChain * CHAIN_SEGMENTS;
    knobs.count = nChain;
    polymerases.count = nChain;
    particles.count = nParticle;
    beads.count = nBead;
    smalls.count = nSub;
    larges.count = nSub;
    for (const mesh of dynamicMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };
  update(0, false);

  // ── Labels ──────────────────────────────────────────────────────────────
  const fcAnchor = new THREE.Vector3(FC.x - 1, FC.y - 7.8, 0.7);
  const dfcAnchor = new THREE.Vector3(FC.x + Math.cos(4.15) * (FC_RADII.x + DFC_THICKNESS * 0.5), FC.y + Math.sin(4.15) * (FC_RADII.y + DFC_THICKNESS * 0.5), 0.9);
  const gcAnchor = new THREE.Vector3(-34, 27, 2);
  const rdnaAnchor = pre[1].clone().add(new THREE.Vector3(0, 0, 0.5));
  const chainsAnchor = genePoint(0.82, new THREE.Vector3()).addScaledVector(geneNormal(0.82, new THREE.Vector3()), CHAIN_MAX * 0.8).setZ(2.0);
  const plasmA = THREE.MathUtils.degToRad(-42);
  const plasmR = edgeRadius(SLICE, plasmA, noise, EDGE_NOISE) + 4;
  const nucleoplasmAnchor = new THREE.Vector3(Math.cos(plasmA) * plasmR, Math.sin(plasmA) * plasmR, 0);
  const trackedVisibleFn = () => trackedVisible;

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(-4, -2, 0),
        radius: 60,
        direction: new THREE.Vector3(0.08, 0.18, 1).normalize(),
        labels: [
          { part: 'fibrillar-center', anchor: anchorOn(root, fcAnchor) },
          { part: 'dense-fibrillar', anchor: anchorOn(root, dfcAnchor) },
          { part: 'granular', anchor: anchorOn(root, gcAnchor) },
          { part: 'rdna', anchor: anchorOn(root, rdnaAnchor) },
          { textKey: 'closeupCaptions.rnaChains', anchor: anchorOn(root, chainsAnchor) },
          { part: 'small-subunit', anchor: () => smallTracked, visible: trackedVisibleFn },
          { part: 'large-subunit', anchor: () => largeTracked, visible: trackedVisibleFn },
          { textKey: 'closeupCaptions.nucleoplasm', anchor: anchorOn(root, nucleoplasmAnchor) },
        ],
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      update(t, calm);
    },
    dispose() {
      disposeScene(scene);
    },
  };
};

export default create;

