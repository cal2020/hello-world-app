import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { Rng } from '../core/random';
import { blobGeometry } from './common';
import {
  addInstanceGlow,
  addJiggle,
  anchorOn,
  byQuality,
  instanced,
  instancedMaterial,
  moleculeMaterial,
  randomQuaternion,
  scatter,
  setSeeds,
  type JiggleUniforms,
  type Placement,
} from './kit';
import {
  addShimmer,
  arcPoints,
  bezierPoints,
  cutFaceMaterial,
  halfCapsuleGeometry,
  membraneBands,
  mergeLoose,
  resamplePath,
  ribbonGeometry,
  segmentTube,
  smoothPath,
  twoToneMaterial,
} from './energyParts';
import type { CloseupLabel } from './types';

/**
 * A mitochondrion cut open lengthwise (1 unit = 10 nm): 500 nm wide and
 * 2 µm long, the back half shown with its cut faces toward the camera.
 * Smooth outer membrane, a 20-nm intermembrane space, and an inner membrane
 * folded into lamellar cristae that are joined to the boundary membrane by
 * narrow crista junctions. The matrix holds mtDNA nucleoids (rings) and
 * mitochondrial ribosomes (granules).
 */

const HALF = 75; // half-length of the cylindrical part (total length 2 × (75 + 25) = 200 units = 2 µm)
const R_OUTER = 25; // outer surface of the outer membrane (diameter 500 nm)
const OM = 0.7; // outer-membrane thickness, 7 nm
const IMS = 2.0; // intermembrane space, 20 nm
const IM = 0.6; // inner-membrane thickness, 6 nm
const R_OM_MID = R_OUTER - OM / 2;
const R_IB_MID = R_OUTER - OM - IMS - IM / 2; // inner boundary membrane (midline)
const R_IB_IN = R_IB_MID - IM / 2; // its matrix face
const LUMEN = 2.2; // crista lumen, 22 nm
const H = LUMEN / 2 + IM / 2; // crista membrane midline offset from the crista mid-plane
const JH = 0.8 + IM / 2; // crista junction (16-nm opening), midline radius
const RIM_GAP = 2.0; // matrix between a crista rim and the boundary membrane
const RIBOSOME_RADIUS = 1.25; // 25-nm granules

const COLORS = {
  outer: '#ff5a5f',
  ims: '#3e1222',
  matrixWall: '#7a2c3c',
  crista: '#e37760',
  outerHead: '#ffe2d8',
  outerCore: '#ff7d74',
  innerHead: '#ffeedd',
  innerCore: '#ffa276',
  nucleoid: '#7fd6ff',
  ribosome: '#ffc96b',
  shimmer: '#ffd7a0',
};

interface Crista {
  x: number;
  /** +1: attached to the bottom boundary (free edge toward +y); −1: attached to the top. */
  side: 1 | -1;
  rho: number;
  /** u of the free edge (≥ rho: the plate spans the whole width). */
  tip: number;
  cutJunction: boolean;
  /** Junction angles behind the cut plane (θ = π is the attached side at the cut). */
  backJunctions: number[];
  c: THREE.Vector3;
  n: THREE.Vector3;
  eu: THREE.Vector3;
  ev: THREE.Vector3;
}

export interface OrganelleView {
  group: THREE.Group;
  labels: CloseupLabel[];
  update(time: number, calm: boolean): void;
  dispose(): void;
}

/** Local radius of the inner boundary (matrix face) at position x along the axis. */
function innerRadiusAt(x: number): number {
  const d = Math.max(0, Math.abs(x) - HALF);
  return Math.sqrt(Math.max(0, R_IB_IN * R_IB_IN - d * d));
}

function buildCristae(rng: Rng): Crista[] {
  // Positions (in 10-nm units) with three wider matrix spaces for nucleoids.
  const xs = [-86, -77.5, -68.5, -59.5, -50.5, -34.5, -25.5, -16.5, -7.5, 7.5, 16.5, 25.5, 34.5, 49.5, 58.5, 67.5, 76.5, 85.5];
  const sides: (1 | -1)[] = [1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, 1];
  return xs.map((x0, i) => {
    const x = x0 + rng.range(-0.8, 0.8);
    const side = sides[i];
    const inCap = Math.abs(x) > HALF - 4;
    const rho = innerRadiusAt(x) - RIM_GAP - H - IM / 2;
    const span = rng.next();
    // Most plates span 70–90 % of the width; some cross it completely.
    const tip = span < 0.3 ? rho : rho * rng.range(0.35, 0.72);
    const slant = rng.range(-0.07, 0.07);
    const yaw = -0.13 + rng.range(-0.04, 0.04);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side * yaw, slant, 'ZYX'));
    if (side === -1) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
    const n = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const eu = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const ev = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const cutJunction = !inCap && rng.next() < 0.7;
    const backJunctions = inCap ? [] : rng.next() < 0.5 ? [rng.range(2.1, 2.5)] : [rng.range(2.0, 2.3), rng.range(1.3, 1.7)];
    return { x, side, rho, tip, cutJunction, backJunctions, c: new THREE.Vector3(x, 0, 0), n, eu, ev };
  });
}

/** The crista rim (plate outline behind the cut) in plate coordinates (u, v ≥ 0). */
function rimOutline(cr: Crista): THREE.Vector2[] {
  const full = cr.tip >= cr.rho - 0.01;
  const thetaEnd = full ? 0 : Math.acos(THREE.MathUtils.clamp(cr.tip / cr.rho, -1, 1));
  const pts = arcPoints(0, 0, cr.rho, Math.PI, thetaEnd, 28);
  if (!full) {
    const vEnd = cr.rho * Math.sin(thetaEnd);
    pts.push(new THREE.Vector2(cr.tip, vEnd * 0.66), new THREE.Vector2(cr.tip, vEnd * 0.33), new THREE.Vector2(cr.tip, 0));
  }
  return smoothPath(resamplePath(pts, false, 1.5), false, 1);
}

function plateGeometry(cr: Crista, radial: number): THREE.BufferGeometry {
  const rim = rimOutline(cr);
  const to3 = (u: number, v: number, w: number) => cr.c.clone().addScaledVector(cr.eu, u).addScaledVector(cr.ev, v).addScaledVector(cr.n, w);
  const parts: THREE.BufferGeometry[] = [];
  // The two flat faces of the sac (membrane midlines at ±H).
  const tris = THREE.ShapeUtils.triangulateShape(rim, []);
  for (const sign of [1, -1]) {
    const positions: number[] = [];
    const normals: number[] = [];
    for (const p of rim) {
      const q = to3(p.x, p.y, sign * H);
      positions.push(q.x, q.y, q.z);
      normals.push(cr.n.x * sign, cr.n.y * sign, cr.n.z * sign);
    }
    const indices: number[] = [];
    // Orient triangles so their front faces point away from the mid-plane.
    const a = to3(rim[tris[0][0]].x, rim[tris[0][0]].y, 0);
    const b = to3(rim[tris[0][1]].x, rim[tris[0][1]].y, 0);
    const c = to3(rim[tris[0][2]].x, rim[tris[0][2]].y, 0);
    const facing = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).dot(cr.n) * sign > 0;
    for (const t of tris) {
      if (facing) indices.push(t[0], t[1], t[2]);
      else indices.push(t[0], t[2], t[1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setIndex(indices);
    parts.push(g);
  }
  // The rounded rim joining the faces.
  const rimCurve = new THREE.CatmullRomCurve3(rim.map((p) => to3(p.x, p.y, 0)));
  const tube = new THREE.TubeGeometry(rimCurve, rim.length, H, radial, false);
  parts.push(tube);
  // Crista junctions: narrow necks from the rim to the boundary membrane.
  const boundary = Math.sqrt(Math.max(0, R_IB_MID * R_IB_MID - Math.max(0, Math.abs(cr.x) - HALF) ** 2));
  const junctions = [...cr.backJunctions.map((theta) => ({ theta, cut: false })), ...(cr.cutJunction ? [{ theta: Math.PI, cut: true }] : [])];
  for (const j of junctions) {
    const dir = cr.eu.clone().multiplyScalar(Math.cos(j.theta)).addScaledVector(cr.ev, Math.sin(j.theta));
    const from = cr.c.clone().addScaledVector(dir, cr.rho);
    const to = cr.c.clone().addScaledVector(dir, boundary + IM * 0.5);
    const sideA = cr.n.clone();
    const sideB = new THREE.Vector3().crossVectors(dir, sideA).normalize();
    // At the cut plane only the back half of the neck remains.
    if (j.cut) {
      const back = sideB.dot(cr.ev) >= 0 ? sideB : sideB.clone().negate();
      parts.push(segmentTube(from, to, JH, sideA, back, 0, Math.PI, radial));
    } else {
      parts.push(segmentTube(from, to, JH, sideA, sideB, 0, Math.PI * 2, radial));
    }
  }
  return mergeLoose(parts);
}

/** 2-D section of a crista in the cut plane (z = 0): a membrane loop or, with a junction at the cut, an excursion of the boundary outline. */
function cristaSection(cr: Crista): { excursion: THREE.Vector2[] | null; loop: THREE.Vector2[] | null } {
  const c2 = new THREE.Vector2(cr.c.x, cr.c.y);
  const eu = new THREE.Vector2(cr.eu.x, cr.eu.y).normalize();
  const p = new THREE.Vector2(cr.n.x, cr.n.y).normalize();
  const at = (s: number, w: number) => c2.clone().addScaledVector(eu, s).addScaledVector(p, w);
  const tipS = Math.min(cr.tip, cr.rho);
  const tipArc = (): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    for (let k = 1; k < 12; k++) {
      const phi = (k / 12) * Math.PI;
      out.push(at(tipS + H * Math.sin(phi), -H * Math.cos(phi)));
    }
    return out;
  };
  if (!cr.cutJunction) {
    const loop: THREE.Vector2[] = [];
    const walls = 6;
    for (let k = 0; k <= walls; k++) loop.push(at(-cr.rho + ((tipS + cr.rho) * k) / walls, -H));
    loop.push(...tipArc());
    for (let k = walls; k >= 0; k--) loop.push(at(-cr.rho + ((tipS + cr.rho) * k) / walls, H));
    for (let k = 1; k < 12; k++) {
      const phi = (k / 12) * Math.PI;
      loop.push(at(-cr.rho - H * Math.sin(phi), H * Math.cos(phi)));
    }
    return { excursion: null, loop };
  }
  // Junction at the cut plane: the outline leaves the boundary, runs up one
  // side of the crista, around its free edge and back down the other side.
  const boundaryY = -cr.side * R_IB_MID;
  const sAtBoundary = (w: number) => (boundaryY - c2.y - w * p.y) / eu.y;
  const width = (s: number) => {
    const t = THREE.MathUtils.smoothstep(s, -cr.rho - 0.6, -cr.rho + 1.6);
    return JH + (H - JH) * t;
  };
  const fillet = 0.6;
  const walk = new THREE.Vector2(p.x, p.y); // walking direction along the boundary near this crista
  const wall = (w: number, sign: 1 | -1): THREE.Vector2[] => {
    const s0 = sAtBoundary(sign * w) + fillet;
    const samples = [s0, -cr.rho - 0.8, -cr.rho - 0.2, -cr.rho + 0.4, -cr.rho + 1.0, -cr.rho + 1.8, (-cr.rho + 1.8 + tipS) / 2, tipS].filter((s, i, arr) => i === 0 || s > arr[0]);
    return samples.map((s) => at(s, sign * width(s)));
  };
  const leftBase = at(sAtBoundary(-JH), -JH);
  const rightBase = at(sAtBoundary(JH), JH);
  const left = wall(JH, -1);
  const right = wall(JH, 1).reverse();
  const excursion = [
    ...bezierPoints(leftBase.clone().addScaledVector(walk, -fillet), leftBase, left[0], 4),
    ...left.slice(1),
    ...tipArc(),
    ...right.slice(0, -1),
    ...bezierPoints(right[right.length - 1], rightBase, rightBase.clone().addScaledVector(walk, fillet), 4),
  ];
  return { excursion, loop: null };
}

/** Stadium outline (midline radius r) walked counter-clockwise, with crista excursions spliced into the straight edges. */
function stadiumOutline(r: number, excursions: { side: 1 | -1; pts: THREE.Vector2[] }[], capSteps: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const bottom = excursions.filter((e) => e.side === 1).sort((a, b) => a.pts[0].x - b.pts[0].x);
  const top = excursions.filter((e) => e.side === -1).sort((a, b) => b.pts[0].x - a.pts[0].x);
  const straight = (from: number, to: number, y: number) => {
    const steps = Math.max(1, Math.round(Math.abs(to - from) / 4));
    for (let i = 0; i < steps; i++) out.push(new THREE.Vector2(from + ((to - from) * i) / steps, y));
  };
  let x = -HALF;
  for (const e of bottom) {
    straight(x, e.pts[0].x, -r);
    out.push(...e.pts);
    x = e.pts[e.pts.length - 1].x;
  }
  straight(x, HALF, -r);
  out.push(...arcPoints(HALF, 0, r, -Math.PI / 2, Math.PI / 2, capSteps).slice(0, -1));
  x = HALF;
  for (const e of top) {
    straight(x, e.pts[0].x, r);
    out.push(...e.pts);
    x = e.pts[e.pts.length - 1].x;
  }
  straight(x, -HALF, r);
  out.push(...arcPoints(-HALF, 0, r, Math.PI / 2, (3 * Math.PI) / 2, capSteps).slice(0, -1));
  return out;
}

export function buildOrganelleView(quality: QualityLevel, jiggle: JiggleUniforms, time: { value: number }): OrganelleView {
  const rng = new Rng('closeup:mitochondria:organelle');
  const group = new THREE.Group();
  const radial = byQuality(quality, { low: 6, medium: 8, high: 10 });
  const disposables: { dispose(): void }[] = [];

  // ── Boundary membranes (back halves) ──
  const capSegments = byQuality(quality, { low: 10, medium: 14, high: 18 });
  const ringSegments = byQuality(quality, { low: 36, medium: 48, high: 64 });
  const outerMaterial = twoToneMaterial(COLORS.outer, COLORS.ims, { emissive: 0.16, backEmissive: 0.1, key: 'mitoOuter' });
  const outer = new THREE.Mesh(halfCapsuleGeometry(R_OM_MID, HALF, 24, capSegments, ringSegments), outerMaterial);
  const innerMaterial = twoToneMaterial(COLORS.ims, COLORS.matrixWall, { emissive: 0.1, backEmissive: 0.2, key: 'mitoInner' });
  const inner = new THREE.Mesh(halfCapsuleGeometry(R_IB_MID, HALF, 24, capSegments, ringSegments), innerMaterial);
  group.add(outer, inner);

  // ── Cristae ──
  const cristae = buildCristae(rng);
  const cristaMaterial = twoToneMaterial(COLORS.crista, COLORS.ims, { emissive: 0.15, backEmissive: 0.12, key: 'mitoCrista' });
  const shimmerAmount = { value: 0.5 };
  addShimmer(cristaMaterial, time, shimmerAmount, COLORS.shimmer, { x: 0.035, y: 0.2, z: 0.03, speed: 1.1, sharpness: 0.7 }, 'mitoShimmer');
  const cristaGeometry = mergeLoose(cristae.map((cr) => plateGeometry(cr, radial)));
  group.add(new THREE.Mesh(cristaGeometry, cristaMaterial));

  // ── Cut faces: banded membrane edges in the plane z = 0 ──
  const sections = cristae.map(cristaSection);
  const excursions = sections.flatMap((s, i) => (s.excursion ? [{ side: cristae[i].side, pts: s.excursion }] : []));
  const capSteps = byQuality(quality, { low: 40, medium: 56, high: 72 });
  const outerOutline = stadiumOutline(R_OM_MID, [], capSteps);
  const innerOutline = stadiumOutline(R_IB_MID, excursions, capSteps);
  const outerBands = membraneBands(COLORS.outerHead, COLORS.outerCore);
  const innerBands = membraneBands(COLORS.innerHead, COLORS.innerCore);
  const cutParts = [ribbonGeometry(outerOutline, true, OM, outerBands, 0.04), ribbonGeometry(innerOutline, true, IM, innerBands, 0.04)];
  for (const s of sections) if (s.loop) cutParts.push(ribbonGeometry(s.loop, true, IM, innerBands, 0.04));
  const cutMaterial = cutFaceMaterial(0.42);
  group.add(new THREE.Mesh(mergeLoose(cutParts), cutMaterial));

  // ── mtDNA nucleoids: small rings in the wider matrix spaces ──
  const nucleoidSpots = [
    { p: new THREE.Vector3(-42.5, 6.5, -7), r: 3.6 },
    { p: new THREE.Vector3(-42, -9, -11), r: 3.0 },
    { p: new THREE.Vector3(0, -3.5, -6.5), r: 3.8 },
    { p: new THREE.Vector3(42, 8.5, -8.5), r: 3.2 },
    { p: new THREE.Vector3(41.5, -8, -5.5), r: 3.5 },
  ];
  const ringParts: THREE.BufferGeometry[] = [];
  const nucleoidTops: THREE.Vector3[] = [];
  nucleoidSpots.forEach((spot, i) => {
    const pts: THREE.Vector3[] = [];
    const k = 40;
    const phase = rng.range(0, Math.PI * 2);
    for (let s = 0; s < k; s++) {
      const a = (s / k) * Math.PI * 2;
      const rr = spot.r * (1 + 0.1 * Math.sin(3 * a + phase) + 0.05 * Math.sin(5 * a + i));
      pts.push(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a) * rr, 0.5 * Math.sin(2 * a + phase)));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const g = new THREE.TubeGeometry(curve, byQuality(quality, { low: 48, medium: 64, high: 80 }), 0.42, 6, true);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.45, 0.45) - 0.2, rng.range(-0.5, 0.5), rng.range(0, Math.PI)));
    g.applyQuaternion(q);
    g.translate(spot.p.x, spot.p.y, spot.p.z);
    ringParts.push(g);
    nucleoidTops.push(new THREE.Vector3(0, spot.r, 0).applyQuaternion(q).add(spot.p));
  });
  const nucleoidMaterial = moleculeMaterial(COLORS.nucleoid, { emissiveIntensity: 0.6, roughness: 0.35 });
  const nucleoids = new THREE.Mesh(mergeLoose(ringParts), nucleoidMaterial);
  group.add(nucleoids);

  // ── Mitochondrial ribosomes: granules filling the matrix between the cristae ──
  const insideCrista = (p: THREE.Vector3, r: number) =>
    cristae.some((cr) => {
      const d = p.clone().sub(cr.c);
      const w = d.dot(cr.n);
      if (Math.abs(w) > H + IM / 2 + r + 0.2) return false;
      const u = d.dot(cr.eu);
      const v = d.dot(cr.ev);
      return u * u + v * v < (cr.rho + H + 3) ** 2 && u < cr.tip + H + r + 0.3;
    });
  const nearNucleoid = (p: THREE.Vector3, r: number) => nucleoidSpots.some((s) => s.p.distanceTo(p) < s.r + r + 1.2);
  const box = new THREE.Box3(new THREE.Vector3(-HALF - R_IB_IN, -R_IB_IN, -R_IB_IN), new THREE.Vector3(HALF + R_IB_IN, R_IB_IN, -RIBOSOME_RADIUS - 0.3));
  const count = byQuality(quality, { low: 300, medium: 440, high: 600 });
  const spots = scatter(
    rng,
    box,
    count,
    () => RIBOSOME_RADIUS * rng.range(0.85, 1.12),
    (p, r) => {
      const ax = Math.max(0, Math.abs(p.x) - HALF);
      const radial2 = Math.sqrt(p.y * p.y + p.z * p.z + ax * ax);
      return radial2 > R_IB_IN - r - 0.4 || insideCrista(p, r) || nearNucleoid(p, r);
    },
    20,
  );
  const granuleGeometry = blobGeometry(1, 'mito-ribosome', 0.24, quality === 'low' ? 1 : 2);
  const granuleMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(granuleMaterial, 0.3, 'mitoRibo');
  addJiggle(granuleMaterial, jiggle, new THREE.Vector3(0.22, 0.22, 0.22), 0.8, 'mitoRiboJiggle');
  const base = new THREE.Color(COLORS.ribosome);
  const placements: Placement[] = spots.map((s) => ({
    position: s.position,
    quaternion: randomQuaternion(rng),
    scale: new THREE.Vector3(s.radius, s.radius * 0.85, s.radius * 0.95),
    color: base.clone().offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.06, 0.04)),
  }));
  const granules = instanced(granuleGeometry, granuleMaterial, placements);
  setSeeds(
    granules,
    placements.map((_, i) => i),
  );
  group.add(granules);
  disposables.push(granuleGeometry);

  // ── Labels ──
  let riboAnchor = new THREE.Vector3(-20, -10, -3);
  let best = -Infinity;
  for (const s of spots) {
    const score = s.position.z * 1.5 - Math.abs(s.position.x + 20) * 0.5 - Math.abs(s.position.y + 10) * 0.5;
    if (score > best) {
      best = score;
      riboAnchor = s.position.clone();
    }
  }
  const labelCrista = cristae.reduce((a, b) => (Math.abs(b.x - 16.5) < Math.abs(a.x - 16.5) ? b : a));
  const cristaTip = labelCrista.c.clone().addScaledVector(labelCrista.eu, Math.min(labelCrista.tip, labelCrista.rho) + H);
  cristaTip.z = 0.05;
  const xsSorted = cristae.map((c) => c.x).sort((a, b) => a - b);
  const gapIndex = xsSorted.findIndex((x) => x > -66);
  const matrixGap = (xsSorted[gapIndex - 1] + xsSorted[gapIndex]) / 2;
  const nucleoidLabel = nucleoidTops[4];
  const labels: CloseupLabel[] = [
    { part: 'outer-membrane', anchor: anchorOn(group, new THREE.Vector3(-72, R_OUTER * Math.cos(0.22), -R_OUTER * Math.sin(0.22))) },
    { part: 'intermembrane-space', anchor: anchorOn(group, new THREE.Vector3(52, R_IB_MID + IM / 2 + IMS / 2, 0.05)) },
    { part: 'inner-membrane', anchor: anchorOn(group, new THREE.Vector3(-44, -R_IB_MID, 0.05)) },
    { part: 'cristae', anchor: anchorOn(group, cristaTip) },
    { part: 'matrix', anchor: anchorOn(group, new THREE.Vector3(matrixGap, -4, -13)) },
    { part: 'mtdna', anchor: anchorOn(group, nucleoidLabel) },
    { textKey: 'closeupCaptions.mitoRibosomes', anchor: anchorOn(group, riboAnchor) },
  ];

  return {
    group,
    labels,
    update(_time, calm) {
      shimmerAmount.value = calm ? 0.14 : 0.3;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
