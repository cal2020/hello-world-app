import * as THREE from 'three';
import { mergeGeometries } from '../core/geometry';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import {
  addInstanceGlow,
  addJiggle,
  alignY,
  anchorOn,
  byQuality,
  createJiggle,
  instanced,
  instancedMaterial,
  setSeeds,
  singleStrand,
  type Placement,
} from './kit';
import { duplexFrames, fineCurve, polylineTube } from './telomeresParts';
import type { CloseupFactory } from './types';

/**
 * The end of a chromosome's DNA (1 unit = 1 nm), drawn to scale: a B-DNA
 * duplex of TTAGGG repeats (one coloured segment = 6 bp ≈ 2 nm) comes in from
 * the left, curves round into a loop ~90 nm across, and its 3′ single-stranded
 * overhang (~134 nt) tucks back into the duplex where the loop closes: it
 * pairs with the C-rich strand over ~100 bp and displaces the G-rich strand as
 * a small D-loop. Shelterin coats the repeats: TRF1/TRF2 dimers (violet) on
 * the duplex — clustered at the junction — and POT1–TPP1 (teal) on the single
 * strands, with TIN2 bridges between them.
 *
 * Simplification: real T-loops are kilobases round (often 1–25 kb); this one
 * is ~0.9 kb so the whole loop fits the view.
 */

const REPEAT_COLORS = ['#fff07a', '#ffb547', '#fff6cf'].map((c) => new THREE.Color(c));
const C_STRAND_TINT = new THREE.Color('#ffffff');
const OVERHANG_COLOR = new THREE.Color('#ff7f5c');
const TRF1_COLOR = '#9b7bff';
const TRF2_COLOR = '#8466f2';
const RAP1_COLOR = '#c4b2ff';
const POT1_COLOR = new THREE.Color('#2ec4b6');
const TPP1_COLOR = new THREE.Color('#86e6dc');
const TIN2_COLOR = '#b4c4ff';

/** Duplex axis: in from the left, through the junction, round the loop to the duplex end. */
const AXIS: [number, number, number][] = [
  [-182, -19, -6],
  [-146, -14, -3.5],
  [-110, -9, -1],
  [-78, -5.4, 1],
  [-50, -2.4, 1.5],
  [-30, -0.7, 0.8],
  [-17, 0, 0], // invasion (D-loop) starts
  [0, 0.4, -0.3],
  [17, 1.3, 0], // invasion ends
  [30, 6, 1.5],
  [41, 17.5, 3],
  [47, 34, 3.5],
  [45, 53, 2.5],
  [35, 70, 0],
  [18, 81, -2.5],
  [-3, 85.5, -4],
  [-24, 81, -3.5],
  [-39, 68, -2],
  [-46.5, 50, 0],
  [-45.5, 33, 2],
  [-39.5, 20.5, 3],
  [-31, 13, 3], // duplex end; the 3′ overhang continues from here
];
const J0_POINT = new THREE.Vector3(-17, 0, 0);
const J1_POINT = new THREE.Vector3(17, 1.3, 0);
const LOOP_CENTER = new THREE.Vector3(0, 42, 0);
const VIEW_DIR = new THREE.Vector3(0.06, 0.26, 1).normalize();

function nearestIndex(centers: THREE.Vector3[], point: THREE.Vector3): number {
  let best = 0;
  let bestD = Infinity;
  centers.forEach((c, i) => {
    const d = c.distanceToSquared(point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function repeatColor(index: number): THREE.Color {
  return REPEAT_COLORS[Math.floor(index / 6) % REPEAT_COLORS.length];
}

/** TRF1/TRF2 homodimer: two Myb domains gripping the duplex, the TRFH dimer above (DNA along +x, up = +y). */
function trfGeometry(detail: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry) => {
    if (g.attributes.uv) g.deleteAttribute('uv');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const myb = [new THREE.Vector3(-2.1, 1.0, 1.05), new THREE.Vector3(2.1, 1.0, -1.05)];
  const trfh = [new THREE.Vector3(-1.45, 3.9, 0.1), new THREE.Vector3(1.45, 3.9, -0.1)];
  myb.forEach((p, i) => {
    const g = blobGeometry(1.25, `trf:myb:${i}`, 0.2, detail);
    g.translate(p.x, p.y, p.z);
    add(g);
  });
  trfh.forEach((p, i) => {
    const g = blobGeometry(1.95, `trf:trfh:${i}`, 0.22, detail);
    g.scale(1, 0.92, 1.05);
    g.translate(p.x, p.y, p.z);
    add(g);
  });
  myb.forEach((p, i) => {
    const from = trfh[i];
    const dir = new THREE.Vector3().subVectors(p, from);
    const length = dir.length();
    const g = new THREE.CapsuleGeometry(0.38, length, 2, 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate((p.x + from.x) / 2, (p.y + from.y) / 2, (p.z + from.z) / 2);
    add(g);
  });
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

/** POT1 (on the single strand) with TPP1 on its back; vertex-coloured (strand along +x, up = +y). */
function potGeometry(detail: number): THREE.BufferGeometry {
  const pot1 = blobGeometry(1, 'pot1', 0.24, detail);
  pot1.scale(2.4, 1.75, 1.9);
  pot1.translate(0, 1.35, 0);
  const tpp1 = blobGeometry(1.45, 'tpp1', 0.22, detail);
  tpp1.translate(1.2, 3.75, 0.5);
  const parts = [pot1, tpp1].map((g, i) => {
    g.deleteAttribute('uv');
    const color = i === 0 ? POT1_COLOR : TPP1_COLOR;
    const n = g.attributes.position.count;
    const rgb = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) rgb.set([color.r, color.g, color.b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    return g;
  });
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

/** Orthonormal frame: x = along the DNA, y = `up` made perpendicular to it. */
function frameQuaternion(tangent: THREE.Vector3, up: THREE.Vector3, target = new THREE.Quaternion()): THREE.Quaternion {
  const x = tangent.clone().normalize();
  const y = up.clone().addScaledVector(x, -up.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return target.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#141026');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);
  const disposables: { dispose(): void }[] = [];

  // ── Duplex: one ring per base pair.
  const axisCurve = fineCurve(AXIS.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const duplex = duplexFrames(axisCurve);
  const N = duplex.count;
  const j0 = nearestIndex(duplex.centers, J0_POINT);
  const j1 = nearestIndex(duplex.centers, J1_POINT);
  const radial = byQuality(quality, { low: 5, medium: 6, high: 8 });
  const strandRadius = 0.28;

  const gStrand: THREE.Vector3[] = [];
  const cStrand: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    gStrand.push(duplex.strand(0, i));
    cStrand.push(duplex.strand(1, i));
  }
  const strandMaterial = instancedMaterial({ vertexColors: true, roughness: 0.42 });
  addInstanceGlow(strandMaterial, 0.18, 'telomereStrands');
  const tube = (from: number, to: number, points: THREE.Vector3[], tint: THREE.Color | null, amount: number) => {
    const pts = points.slice(from, to + 1);
    const colors = pts.map((_, k) => {
      const c = repeatColor(from + k).clone();
      return tint ? c.lerp(tint, amount) : c;
    });
    const mesh = new THREE.Mesh(polylineTube(pts, strandRadius, radial, { colors }), strandMaterial);
    root.add(mesh);
    return mesh;
  };
  // G-rich strand (5′→3′ toward the end): before the D-loop and from its far end to the duplex end.
  tube(0, j0, gStrand, null, 0);
  tube(j1, N - 1, gStrand, null, 0);
  // The invading 3′ overhang occupies the G-strand's place inside the D-loop.
  tube(j0, j1, gStrand, OVERHANG_COLOR, 0.82);
  // C-rich strand (pairs with the G strand, and with the invader inside the D-loop).
  tube(0, N - 1, cStrand, C_STRAND_TINT, 0.38);

  // Base pairs, coloured by repeat.
  const rungGeometry = new THREE.CylinderGeometry(0.17, 0.17, 1, quality === 'low' ? 4 : 5, 1, true);
  const rungMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(rungMaterial, 0.18, 'telomereRungs');
  const rungs: Placement[] = [];
  const mid = new THREE.Vector3();
  const span = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    mid.addVectors(gStrand[i], cStrand[i]).multiplyScalar(0.5);
    span.subVectors(cStrand[i], gStrand[i]);
    rungs.push({ position: mid.clone(), quaternion: alignY(span), scale: new THREE.Vector3(1, span.length() * 0.92, 1), color: repeatColor(i) });
  }
  root.add(instanced(rungGeometry, rungMaterial, rungs));

  // ── D-loop: the displaced G strand bulges out of the invaded region (single-stranded).
  const bulgePoints: THREE.Vector3[] = [];
  const bulgeOut = new THREE.Vector3(0, -0.55, 0.84).normalize();
  const dir = new THREE.Vector3();
  for (let i = j0; i <= j1; i += 2) {
    const u = (i - j0) / (j1 - j0);
    const t = duplex.tangents[i];
    dir.copy(bulgeOut).addScaledVector(t, -bulgeOut.dot(t)).normalize();
    const arc = duplex.centers[i].clone().addScaledVector(dir, 1.05 + 4.2 * Math.pow(Math.sin(Math.PI * u), 0.85));
    const w = THREE.MathUtils.smoothstep(u, 0, 0.16) * (1 - THREE.MathUtils.smoothstep(u, 0.84, 1));
    bulgePoints.push(gStrand[i].clone().lerp(arc, w));
  }
  if (bulgePoints[bulgePoints.length - 1].distanceTo(gStrand[j1]) > 1e-3) bulgePoints.push(gStrand[j1].clone());
  const bulgeCurve = fineCurve(bulgePoints);
  const displacedCount = j1 - j0;
  const displaced = singleStrand({
    curve: bulgeCurve,
    quality,
    spacing: bulgeCurve.getLength() / displacedCount,
    backboneRadius: strandRadius,
    backboneColor: '#ffd166',
    baseColor: (i) => repeatColor(j0 + i),
    baseLength: 0.75,
  });
  root.add(displaced.group);
  disposables.push(displaced);

  // ── 3′ overhang bridge: from the duplex end back to the start of the invasion.
  const endTangent = duplex.tangents[N - 1];
  const inTangent = duplex.tangents[j0];
  const bridgeStart = gStrand[N - 1].clone();
  const bridgeEnd = gStrand[j0].clone();
  const bridgePoints = [
    bridgeStart,
    bridgeStart.clone().addScaledVector(endTangent, 4.5).add(new THREE.Vector3(-1.5, 0, 2.5)),
    new THREE.Vector3(-27.5, 3.8, 5.2),
    new THREE.Vector3(-22.5, 0.6, 3.6),
    bridgeEnd.clone().addScaledVector(inTangent, -2.2).add(new THREE.Vector3(0, -0.4, 1.2)),
    bridgeEnd,
  ];
  const bridgeCurve = fineCurve(bridgePoints);
  const bridgeNt = 34;
  const bridge = singleStrand({
    curve: bridgeCurve,
    quality,
    spacing: bridgeCurve.getLength() / bridgeNt,
    backboneRadius: strandRadius,
    backboneColor: OVERHANG_COLOR,
    baseColor: (i) => repeatColor(N + i),
    baseLength: 0.75,
  });
  root.add(bridge.group);
  disposables.push(bridge);

  // ── Shelterin.
  const detail = quality === 'low' ? 1 : 2;
  const jiggleAmp = new THREE.Vector3(0.28, 0.28, 0.28);

  // POT1–TPP1 on the single-stranded parts: the overhang bridge and the displaced strand.
  const potShape = potGeometry(detail);
  const potMaterial = instancedMaterial({ vertexColors: true, roughness: 0.5 });
  addInstanceGlow(potMaterial, 0.2, 'pot1');
  addJiggle(potMaterial, jiggle, jiggleAmp, 0.7, 'shelterinJiggle');
  const potPlacements: Placement[] = [];
  const potSpots: { curve: THREE.CatmullRomCurve3; u: number; up: THREE.Vector3 }[] = [
    { curve: bridgeCurve, u: 0.2, up: VIEW_DIR.clone().add(new THREE.Vector3(-0.3, 0.5, 0)) },
    { curve: bridgeCurve, u: 0.72, up: VIEW_DIR.clone().add(new THREE.Vector3(-0.2, -0.5, 0)) },
    { curve: bulgeCurve, u: 0.2, up: bulgeOut },
    { curve: bulgeCurve, u: 0.5, up: bulgeOut },
    { curve: bulgeCurve, u: 0.82, up: bulgeOut },
  ];
  const tpp1Local = new THREE.Vector3(1.2, 3.75, 0.5);
  const tpp1Centers: THREE.Vector3[] = [];
  potSpots.forEach((spot) => {
    const position = spot.curve.getPointAt(spot.u);
    const q = frameQuaternion(spot.curve.getTangentAt(spot.u), spot.up);
    potPlacements.push({ position, quaternion: q });
    tpp1Centers.push(tpp1Local.clone().applyQuaternion(q).add(position));
  });
  const potMesh = instanced(potShape, potMaterial, potPlacements);
  setSeeds(
    potMesh,
    potPlacements.map((_, i) => 100 + i),
  );
  root.add(potMesh);

  // TRF1/TRF2 dimers every ~20 nm along the duplex, TRF2 clustered at the junction.
  const trfShape = trfGeometry(detail);
  const trfMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(trfMaterial, 0.2, 'trf');
  addJiggle(trfMaterial, jiggle, jiggleAmp, 0.7, 'shelterinJiggle');
  interface Site {
    index: number;
    kind: 'TRF1' | 'TRF2';
    up: THREE.Vector3;
    /** POT1–TPP1 this dimer is bridged to by TIN2 (index into potSpots). */
    partner?: number;
  }
  const sites: Site[] = [];
  const upAt = (i: number, flip: number) => {
    const c = duplex.centers[i];
    const outward = c.clone().sub(LOOP_CENTER).setZ(0).normalize();
    const onLoop = i > j1;
    const up = onLoop ? outward.multiplyScalar(0.55).addScaledVector(VIEW_DIR, 0.85) : VIEW_DIR.clone().add(new THREE.Vector3(0, 0.45 * flip, 0));
    return up.normalize();
  };
  /** Junction dimers turn their TRFH domain toward their TPP1 partner. */
  const upToward = (i: number, partner: number) => tpp1Centers[partner].clone().sub(duplex.centers[i]).normalize().add(VIEW_DIR.clone().multiplyScalar(0.35)).normalize();
  const incoming = [17, 82, 142, 204, 266, 330, 396];
  incoming.forEach((back, k) => {
    const index = j0 - back;
    if (index < 12) return;
    if (k === 0) sites.push({ index, kind: 'TRF2', up: upToward(index, 1), partner: 1 });
    else sites.push({ index, kind: k % 2 === 0 ? 'TRF2' : 'TRF1', up: upAt(index, k % 2 ? 1 : -1) });
  });
  sites.push({ index: j1 + 8, kind: 'TRF2', up: upToward(j1 + 8, 4), partner: 4 });
  for (let index = j1 + 74, k = 0; index < N - 60; index += 60, k++) {
    sites.push({ index, kind: k % 3 === 1 ? 'TRF2' : 'TRF1', up: upAt(index, 1) });
  }
  sites.push({ index: N - 7, kind: 'TRF2', up: upToward(N - 7, 0), partner: 0 });
  const sliderSite = sites.findIndex((s) => j0 - s.index === 204);

  const trfPlacements: Placement[] = sites.map((s) => ({
    position: duplex.centers[s.index].clone(),
    quaternion: frameQuaternion(duplex.tangents[s.index], s.up),
    color: s.kind === 'TRF1' ? TRF1_COLOR : TRF2_COLOR,
  }));
  const trfMesh = instanced(trfShape, trfMaterial, trfPlacements);
  setSeeds(
    trfMesh,
    sites.map((_, i) => i + 1),
  );
  root.add(trfMesh);

  // RAP1 sits on each TRF2.
  const rapShape = blobGeometry(1.3, 'rap1', 0.22, detail);
  const rapMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(rapMaterial, 0.2, 'rap1');
  addJiggle(rapMaterial, jiggle, jiggleAmp, 0.7, 'shelterinJiggle');
  const rapSites = sites.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'TRF2');
  const rapLocal = new THREE.Vector3(0.2, 6.1, 0.9);
  const rapMesh = instanced(
    rapShape,
    rapMaterial,
    rapSites.map(({ i }) => ({
      position: rapLocal.clone().applyQuaternion(trfPlacements[i].quaternion!).add(trfPlacements[i].position),
      color: RAP1_COLOR,
    })),
  );
  setSeeds(
    rapMesh,
    rapSites.map(({ i }) => i + 1),
  );
  root.add(rapMesh);

  // TIN2 bridges each junction TRF2 to its TPP1 partner: a small protein with two short arms.
  const trfhTop = new THREE.Vector3(0, 5.0, 0);
  const tinPlacements: Placement[] = [];
  const tinSeeds: number[] = [];
  sites.forEach((site, i) => {
    if (site.partner === undefined) return;
    const top = trfhTop.clone().applyQuaternion(trfPlacements[i].quaternion!).add(trfPlacements[i].position);
    const tpp = tpp1Centers[site.partner];
    const along = new THREE.Vector3().subVectors(tpp, top);
    const length = Math.max(0.8, along.length() - 2.6);
    tinPlacements.push({
      position: top.clone().addScaledVector(along.clone().normalize(), 1.3 + length / 2),
      quaternion: alignY(along),
      scale: new THREE.Vector3(1, length, 1),
      color: TIN2_COLOR,
    });
    tinSeeds.push(i + 1);
  });
  const tinShape = new THREE.CapsuleGeometry(0.62, 1, 2, 8);
  const tinMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(tinMaterial, 0.2, 'tin2');
  addJiggle(tinMaterial, jiggle, jiggleAmp, 0.7, 'shelterinJiggle');
  const tinMesh = instanced(tinShape, tinMaterial, tinPlacements);
  setSeeds(tinMesh, tinSeeds);
  root.add(tinMesh);

  // ── Labels.
  const towardCamera = (p: THREE.Vector3, amount: number) => p.clone().addScaledVector(VIEW_DIR, amount);
  const repeatsAnchor = towardCamera(duplex.centers[j0 - 175], 1.6);
  const overhangAnchor = towardCamera(bridgeCurve.getPointAt(0.52), 1.2);
  let topIndex = j1;
  let rightIndex = j1;
  for (let i = j1; i < N; i++) {
    if (duplex.centers[i].y > duplex.centers[topIndex].y) topIndex = i;
    if (duplex.centers[i].x > duplex.centers[rightIndex].x) rightIndex = i;
  }
  const loopAnchor = duplex.centers[topIndex].clone().add(new THREE.Vector3(0, 1.4, 1.2));
  const endAnchor = duplex.centers[rightIndex].clone().add(new THREE.Vector3(1.4, 0, 1.2));
  // Shelterin label on a TRF dimer on the upper left of the loop (clear of the other labels).
  let shelterinSite = 0;
  sites.forEach((s, i) => {
    const c = duplex.centers[s.index];
    const best = duplex.centers[sites[shelterinSite].index];
    if (s.index > j1 && c.y > 30 && (best.y <= 30 || c.x < best.x)) shelterinSite = i;
  });
  const shelterinAnchor = new THREE.Vector3(0, 5.4, 0).applyQuaternion(trfPlacements[shelterinSite].quaternion!).add(trfPlacements[shelterinSite].position);

  // Sliding TRF1 (moves along the duplex axis; everything else only jiggles).
  const slideM = new THREE.Matrix4();
  const slideP = new THREE.Vector3();
  const slideQ = new THREE.Quaternion();
  const slideQ2 = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const slider = sliderSite >= 0 ? sites[sliderSite] : null;
  const sliderQuats = slider ? Array.from({ length: 41 }, (_, k) => frameQuaternion(duplex.tangents[slider.index - 20 + k], slider.up)) : [];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(-12, 33, 0),
        radius: 80,
        direction: VIEW_DIR.clone(),
        labels: [
          { part: 'repeats', anchor: anchorOn(root, repeatsAnchor) },
          { part: 'overhang', anchor: anchorOn(root, overhangAnchor) },
          { part: 't-loop', anchor: anchorOn(root, loopAnchor) },
          { part: 'shelterin', anchor: anchorOn(root, shelterinAnchor) },
          { part: 'chromosome-end', anchor: anchorOn(root, endAnchor) },
        ],
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      if (slider) {
        // One TRF1 dimer diffuses a few nanometres back and forth along the repeats.
        const offset = (calm ? 6 : 12) * Math.sin((Math.PI * 2 * t) / 11) + (calm ? 0 : 3 * Math.sin((Math.PI * 2 * t) / 4.3));
        const f = THREE.MathUtils.clamp(20 + offset, 0, 39.999);
        const k = Math.floor(f);
        const w = f - k;
        const i = slider.index - 20 + k;
        slideP.copy(duplex.centers[i]).lerp(duplex.centers[i + 1], w);
        slideQ.copy(sliderQuats[k]).slerp(slideQ2.copy(sliderQuats[k + 1]), w);
        trfMesh.setMatrixAt(sliderSite, slideM.compose(slideP, slideQ, one));
        trfMesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      disposeScene(scene);
    },
  };
};

export default create;
