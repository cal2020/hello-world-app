import * as THREE from 'three';
import { Rng } from '../core/random';
import { mergeGeometries } from '../core/geometry';
import { blobGeometry, createCloseupScene, disposeScene, easeInOut, smooth } from './common';
import {
  addInstanceGlow,
  addJiggle,
  alignY,
  anchorOn,
  byQuality,
  createJiggle,
  instanced,
  instancedMaterial,
  proteinShapes,
  randomQuaternion,
  setSeeds,
  sparks,
  type Placement,
} from './kit';
import { addHoleClip, cutBowl, cutFaceMaterial, FusionNeck, membraneBands, membraneMaterial, wander, type HoleClip } from './energyParts';
import type { CloseupFactory, CloseupLabel } from './types';

/**
 * A lysosome cut open (1 unit = 1 nm), 300 nm across. V-ATPase pumps (orange)
 * in the membrane push protons into the acidic lumen; a sugar coat lines the
 * inner face. A late endosome (150 nm, left) fuses through a neck and
 * delivers protein aggregates; hydrolases (purple) gather on them and cut
 * them into smaller and smaller pieces, down to amino acids that leave
 * through transporters (blue) into the cytosol. The loop lasts 20 s.
 */

const R_L = 150; // lysosome radius (300 nm)
const MEMBRANE = 5; // bilayer thickness
const R_E = 75; // late endosome radius (150 nm)
const NECK_LEN = 6;
const NECK_MAX = 52;
const LOOP = 20;

const T = {
  approachEnd: 4.6,
  poreOpen: 7.0,
  mergeStart: 8.0,
  mergeEnd: 10.5,
  transferStart: 5.4,
  transferStep: 0.22,
  transferDuration: 2.2,
  gatherStart: 8.6,
  gatherEnd: 10.4,
  splits: [10.8, 11.8, 12.8, 13.8],
  returnStart: 14.2,
  returnEnd: 17.5,
  ilvDigest: [11.0, 14.0],
};

const COLORS = {
  lysosome: '#c77dff',
  lysosomeInner: '#5b3488',
  v1: '#ffb257',
  v0: '#e57f22',
  vStalk: '#ff9e3d',
  hydrolase: '#8f5bff',
  glycan: '#e9d5ff',
  glycanShade: '#cdb3ec',
  transporter: '#4cc9f0',
  endosome: '#4cc9f0',
  cargo: '#ffd166',
  amino: '#ffe7a0',
  proton: '#ff4d4d',
  ilv: '#9be7ff',
};

const PUMP_ANGLES = [34, 58, 104, 128, 146, 214, 234, 280, 304, 348];
const TRANSPORTER_ANGLES = [10, 80, 258, 326];

const dirAt = (deg: number, target = new THREE.Vector3()) => target.set(Math.cos(THREE.MathUtils.degToRad(deg)), Math.sin(THREE.MathUtils.degToRad(deg)), 0);

/** Merge parts, each painted one colour (vertex colours). */
function coloredMerge(parts: { geometry: THREE.BufferGeometry; color: THREE.ColorRepresentation }[]): THREE.BufferGeometry {
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

function lump(seed: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, detail: number): THREE.BufferGeometry {
  const g = blobGeometry(1, seed, 0.22, detail);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** V-ATPase along +y (outward): V0 ring in the membrane (y ≈ 0), stalk, V1 head in the cytosol. ~23 nm tall. */
function vAtpaseGeometry(detail: number): THREE.BufferGeometry {
  const parts: { geometry: THREE.BufferGeometry; color: THREE.ColorRepresentation }[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    parts.push({ geometry: lump(`v0:${k}`, Math.cos(a) * 3.3, 0, Math.sin(a) * 3.3, 1.6, 2.6, 1.6, detail), color: COLORS.v0 });
  }
  parts.push({ geometry: lump('v0:a', 5.6, 0.3, 0, 2.1, 2.8, 2.0, detail), color: COLORS.v0 });
  parts.push({ geometry: lump('v0:ac45', 0, -3.4, 0, 3.2, 1.3, 2.8, detail), color: COLORS.v0 });
  parts.push({ geometry: lump('v0:d', 0, 3.6, 0, 2.3, 1.5, 2.3, detail), color: COLORS.vStalk });
  const stalk = new THREE.CapsuleGeometry(1.1, 5, 2, 6);
  stalk.translate(0, 7.2, 0);
  parts.push({ geometry: stalk, color: COLORS.vStalk });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    parts.push({ geometry: lump(`v1:${k}`, Math.cos(a) * 3.0, 13.4, Math.sin(a) * 3.0, 2.5, 4.0, 2.5, detail), color: COLORS.v1 });
  }
  parts.push({ geometry: lump('v1:c', -4.8, 5.2, 1.2, 2.0, 1.6, 1.8, detail), color: COLORS.vStalk });
  for (const a of [0.2, 2.3, 4.4]) {
    const curve = new THREE.LineCurve3(new THREE.Vector3(Math.cos(a) * 5.4, 3.0, Math.sin(a) * 5.4), new THREE.Vector3(Math.cos(a) * 4.6, 17.0, Math.sin(a) * 4.6));
    parts.push({ geometry: new THREE.TubeGeometry(curve, 4, 0.5, 5, false), color: COLORS.vStalk });
  }
  return coloredMerge(parts);
}

function glycanGeometry(quality: 'low' | 'medium' | 'high'): THREE.BufferGeometry {
  const radial = quality === 'low' ? 3 : 4;
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.3, 0.36, 2.2, radial, 1, true);
  stem.translate(0, 1.1, 0);
  parts.push(stem);
  for (const s of [-1, 1]) {
    const branch = new THREE.CylinderGeometry(0.26, 0.3, 1.8, radial, 1, true);
    branch.translate(0, 0.9, 0);
    branch.rotateZ(s * 0.6);
    branch.translate(0, 2.1, 0);
    parts.push(branch);
    const bead = new THREE.TetrahedronGeometry(0.55, quality === 'high' ? 1 : 0);
    bead.translate(-s * Math.sin(0.6) * 1.8, 2.1 + Math.cos(0.6) * 1.8, 0);
    parts.push(bead);
  }
  const top = new THREE.TetrahedronGeometry(0.5, quality === 'high' ? 1 : 0);
  top.translate(0, 2.4, 0.4);
  parts.push(top);
  const prepared = parts.map((g) => {
    const h = g.index ? g.toNonIndexed() : g;
    if (h !== g) g.dispose();
    if (h.attributes.uv) h.deleteAttribute('uv');
    return h;
  });
  const merged = mergeGeometries(prepared)!;
  prepared.forEach((g) => g.dispose());
  return merged;
}

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#150c24');
  const rng = new Rng('closeup:lysosomes');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);
  const detail = quality === 'low' ? 1 : 2;
  const disposables: { dispose(): void }[] = [];

  // ── Lysosome membrane: a bowl open toward the camera, with a fusion pore on the left ──
  const lysoHole: HoleClip = { center: new THREE.Vector3(0, 0, 0), axis: new THREE.Vector3(-1, 0, 0), radius: { value: 0 } };
  const lysosome = cutBowl({ radius: R_L, thickness: MEMBRANE, color: COLORS.lysosome, innerColor: COLORS.lysosomeInner, segments: byQuality(quality, { low: 56, medium: 72, high: 96 }) });
  lysosome.children.forEach((child, i) => addHoleClip((child as THREE.Mesh).material as THREE.Material, lysoHole, `lysoHole${i}`));
  root.add(lysosome);

  // ── Late endosome (cut open too) ──
  const endoHole: HoleClip = { center: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), radius: { value: 0 } };
  const endosome = cutBowl({ radius: R_E, thickness: MEMBRANE, color: COLORS.endosome, innerColor: '#1f5f7a', segments: byQuality(quality, { low: 40, medium: 48, high: 64 }) });
  endosome.children.forEach((child, i) => addHoleClip((child as THREE.Mesh).material as THREE.Material, endoHole, `endoHole${i}`));
  root.add(endosome);
  // The neck is drawn like the bowls: an outer face and a lit luminal face.
  const neckMaterials = [
    membraneMaterial(COLORS.lysosome, { side: THREE.FrontSide }),
    membraneMaterial(COLORS.lysosomeInner, { side: THREE.BackSide, rim: 0.25 }),
  ];
  const neck = new FusionNeck(neckMaterials, cutFaceMaterial(0.25), MEMBRANE, membraneBands('#f1e3c8', '#b08a3e'), 24);
  root.add(neck.group);
  disposables.push(neck);

  // ── Sugar coat on the inner face: dense, short, branched glycans ──
  const glycanShape = glycanGeometry(quality);
  disposables.push(glycanShape);
  const glycanCount = byQuality(quality, { low: 1000, medium: 1800, high: 3000 });
  const fringeCount = byQuality(quality, { low: 170, medium: 230, high: 300 });
  const glycanPlacements: Placement[] = [];
  const glycanBase = new THREE.Color(COLORS.glycan).lerp(new THREE.Color(COLORS.glycanShade), 0.5);
  const occupied = [...PUMP_ANGLES, ...TRANSPORTER_ANGLES];
  const addGlycan = (dir: THREE.Vector3) => {
    const p = dir.clone().multiplyScalar(R_L - MEMBRANE + 0.2);
    glycanPlacements.push({
      position: p,
      quaternion: alignY(dir.clone().negate(), rng.range(0, Math.PI * 2)),
      scale: rng.range(0.8, 1.25),
      color: glycanBase.clone().offsetHSL(0, 0, rng.range(-0.08, 0.04)),
    });
  };
  for (let i = 0; i < glycanCount; i++) {
    const d = rng.direction();
    if (d.z > 0) d.z = -d.z;
    addGlycan(d);
  }
  for (let i = 0; i < fringeCount; i++) {
    const deg = rng.range(0, 360);
    if (occupied.some((a) => Math.abs(((deg - a + 540) % 360) - 180) < 2.5)) continue;
    const d = dirAt(deg);
    d.z = -rng.range(0.004, 0.05);
    addGlycan(d.normalize());
  }
  const glycanMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(glycanMaterial, 0.1, 'glycans');
  const glycans = instanced(glycanShape, glycanMaterial, glycanPlacements);
  root.add(glycans);
  // Glycans that sit where the fusion pore opens (hidden while it is open).
  const poreGlycans = glycanPlacements.map((p, i) => ({ i, p })).filter(({ p }) => p.position.x < 0 && p.position.y * p.position.y + p.position.z * p.position.z < 70 * 70);
  const glycanMatrices = poreGlycans.map(({ i }) => {
    const m = new THREE.Matrix4();
    glycans.getMatrixAt(i, m);
    return m;
  });

  // ── V-ATPase pumps and nutrient transporters around the cut rim ──
  const pumpShape = vAtpaseGeometry(detail);
  const pumpMaterial = instancedMaterial({ roughness: 0.5, vertexColors: true });
  addInstanceGlow(pumpMaterial, 0.2, 'vatpase');
  const pumps = instanced(
    pumpShape,
    pumpMaterial,
    PUMP_ANGLES.map((deg, i) => ({
      position: dirAt(deg).multiplyScalar(R_L - MEMBRANE / 2),
      quaternion: alignY(dirAt(deg), i * 1.3),
      color: '#ffffff',
    })),
  );
  root.add(pumps);
  disposables.push(pumpShape);
  const transporterShape = mergeGeometries([lump('tr:0', 0, 1.6, 0, 2.2, 2.9, 2.2, detail + 1), lump('tr:1', 0.3, -1.7, 0.2, 2.4, 2.6, 2.3, detail + 1)])!;
  const transporterMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(transporterMaterial, 0.45, 'lysoTransporter');
  const transporters = instanced(
    transporterShape,
    transporterMaterial,
    TRANSPORTER_ANGLES.map((deg) => ({ position: dirAt(deg).multiplyScalar(R_L - MEMBRANE / 2), quaternion: alignY(dirAt(deg)), color: COLORS.transporter })),
  );
  root.add(transporters);
  disposables.push(transporterShape);

  // ── Hydrolases floating in the lumen (background ones jiggle on the GPU) ──
  const hydrolaseShapes = proteinShapes('lyso-hydrolase', 3, detail + 1, 0.3);
  disposables.push(...hydrolaseShapes);
  const hydroMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(hydroMaterial, 0.22, 'hydrolase');
  addJiggle(hydroMaterial, jiggle, new THREE.Vector3(1.6, 1.6, 1.6), 0.5, 'hydroJiggle');
  const hydroBase = new THREE.Color(COLORS.hydrolase);
  const background: Placement[][] = hydrolaseShapes.map(() => []);
  const backgroundSeeds: number[][] = hydrolaseShapes.map(() => []);
  const hydroPositions: THREE.Vector3[] = [];
  const backgroundCount = 36;
  for (let i = 0; i < backgroundCount; i++) {
    const p = new THREE.Vector3();
    for (let a = 0; a < 20; a++) {
      rng.inBall(p).multiplyScalar(R_L - 16);
      if (p.z > -8) p.z = -8 - rng.next() * 30;
      if (p.length() < R_L - 14 && !(p.x < -20 && Math.abs(p.y) < 50 && p.z > -60)) break;
    }
    hydroPositions.push(p);
    const k = i % hydrolaseShapes.length;
    background[k].push({ position: p, quaternion: randomQuaternion(rng), scale: rng.range(2.6, 4), color: hydroBase.clone().offsetHSL(rng.range(-0.03, 0.03), 0, rng.range(-0.08, 0.06)) });
    backgroundSeeds[k].push(i);
  }
  hydrolaseShapes.forEach((shape, k) => {
    const mesh = instanced(shape, hydroMaterial, background[k]);
    setSeeds(mesh, backgroundSeeds[k]);
    root.add(mesh);
  });
  // Worker hydrolases (CPU): four per cargo aggregate, gathering and cutting.
  const workerCount = 12;
  const workerMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(workerMaterial, 0.26, 'hydroWorker');
  const workers = new THREE.InstancedMesh(hydrolaseShapes[0], workerMaterial, workerCount);
  workers.frustumCulled = false;
  const workerHomes: THREE.Vector3[] = [];
  const workerRot: THREE.Quaternion[] = [];
  const workerScale: number[] = [];
  for (let w = 0; w < workerCount; w++) {
    const home = new THREE.Vector3(rng.range(-90, 60), rng.range(-90, 90), rng.range(-95, -25));
    workerHomes.push(home);
    workerRot.push(randomQuaternion(rng));
    workerScale.push(rng.range(2.8, 3.6));
    workers.setColorAt(w, hydroBase.clone().offsetHSL(0, 0.05, rng.range(-0.04, 0.06)));
  }
  root.add(workers);
  const tetra = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, -1, 1), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(1, -1, -1)].map((v) => v.normalize());

  // ── Cargo (endosome contents): protein aggregates and intraluminal vesicles ──
  const aggregates = [
    { offset: new THREE.Vector3(24, -2, -21), dest: new THREE.Vector3(-56, 26, -40), r: 17 },
    { offset: new THREE.Vector3(-24, -12, -18), dest: new THREE.Vector3(-34, -36, -34), r: 15 },
    { offset: new THREE.Vector3(0, 21, -24), dest: new THREE.Vector3(-2, 14, -56), r: 14 },
  ];
  const ilvs = [
    { offset: new THREE.Vector3(-31, 21, -31), dest: new THREE.Vector3(-100, 58, -48), r: 15 },
    { offset: new THREE.Vector3(13, -36, -27), dest: new THREE.Vector3(-92, -62, -42), r: 14 },
    { offset: new THREE.Vector3(-14, -21, -48), dest: new THREE.Vector3(-70, -4, -92), r: 13 },
    { offset: new THREE.Vector3(31, 31, -31), dest: new THREE.Vector3(-38, 72, -62), r: 13 },
  ];
  const nodesPerTree = 15;
  const pieceShape = blobGeometry(1, 'lyso-cargo', 0.3, detail + 1);
  disposables.push(pieceShape);
  const pieceMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(pieceMaterial, 0.24, 'cargoPieces');
  const pieces = new THREE.InstancedMesh(pieceShape, pieceMaterial, aggregates.length * nodesPerTree);
  pieces.frustumCulled = false;
  const pieceDirs: THREE.Vector3[] = [];
  const pieceRot: THREE.Quaternion[] = [];
  for (let a = 0; a < aggregates.length; a++) {
    const base = new THREE.Color(COLORS.cargo).offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.05, 0.03));
    for (let n = 0; n < nodesPerTree; n++) {
      pieceDirs.push(rng.direction(new THREE.Vector3()));
      pieceRot.push(randomQuaternion(rng));
      pieces.setColorAt(a * nodesPerTree + n, base.clone().offsetHSL(0, 0, rng.range(-0.05, 0.05)));
    }
  }
  root.add(pieces);
  const ilvGeometry = new THREE.SphereGeometry(1, 24, 16);
  disposables.push(ilvGeometry);
  const ilvMaterial = instancedMaterial({ roughness: 0.5, transparent: false });
  addInstanceGlow(ilvMaterial, 0.18, 'ilv');
  const ilvMesh = new THREE.InstancedMesh(ilvGeometry, ilvMaterial, ilvs.length);
  ilvMesh.frustumCulled = false;
  ilvs.forEach((_, i) => ilvMesh.setColorAt(i, new THREE.Color(COLORS.ilv)));
  root.add(ilvMesh);

  // ── Amino acids (small beads) and their way out ──
  const beadsPerPiece = 4;
  const beadCount = aggregates.length * 8 * beadsPerPiece;
  const beadShape = new THREE.IcosahedronGeometry(1.1, 0);
  disposables.push(beadShape);
  const beadMaterial = instancedMaterial({ roughness: 0.4 });
  addInstanceGlow(beadMaterial, 0.55, 'aminoBeads');
  const beads = new THREE.InstancedMesh(beadShape, beadMaterial, beadCount);
  beads.frustumCulled = false;
  const beadInfo = Array.from({ length: beadCount }, (_, b) => ({
    tree: Math.floor(b / (8 * beadsPerPiece)),
    node: 7 + Math.floor((b % (8 * beadsPerPiece)) / beadsPerPiece),
    offset: rng.direction(new THREE.Vector3()).multiplyScalar(rng.range(1.5, 4)),
    delay: b === 0 ? 0.1 : rng.range(0, 1.8),
    travel: rng.range(2.3, 2.9),
    transporter: b % TRANSPORTER_ANGLES.length,
    seed: rng.range(0, 100),
  }));
  for (let b = 0; b < beadCount; b++) beads.setColorAt(b, new THREE.Color(COLORS.amino).offsetHSL(rng.range(-0.03, 0.03), 0, rng.range(-0.05, 0.05)));
  root.add(beads);
  const beadPositions = Array.from({ length: beadCount }, () => new THREE.Vector3());

  // ── Protons: many in the acidic lumen, freshly pumped ones near each V-ATPase ──
  const protonCount = byQuality(quality, { low: 260, medium: 340, high: 420 });
  const protonHomes: THREE.Vector3[] = [];
  for (let i = 0; i < protonCount; i++) {
    const p = rng.inBall(new THREE.Vector3()).multiplyScalar(R_L - 10);
    if (p.z > -2) p.z = -p.z - 2;
    protonHomes.push(p);
  }
  const lumenProtons = sparks(protonCount, COLORS.proton, 3.4, ctx.pointScale);
  const pumped = sparks(PUMP_ANGLES.length * 2, '#ff6a5a', 4.4, ctx.pointScale);
  root.add(lumenProtons.points, pumped.points);
  disposables.push(lumenProtons, pumped);
  const pumpDrift = Array.from({ length: PUMP_ANGLES.length * 2 }, () => new THREE.Vector3(rng.range(-8, 8), rng.range(-8, 8), rng.range(-14, -2)));

  // ── Animation state ──
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  const endoCenter = new THREE.Vector3();
  const neckA = new THREE.Vector3();
  const neckB = new THREE.Vector3();
  const nodePos = Array.from({ length: aggregates.length * nodesPerTree }, () => new THREE.Vector3());
  const aggCenter = aggregates.map(() => new THREE.Vector3());
  const tmpDir = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3(0.3, 1, 0.2).normalize();
  const pieceRadius = (r0: number, level: number) => r0 * Math.pow(2, -level / 3);
  const endoState = { visible: true, scale: 1 };
  const beadsState = { visible: false };

  const bezier = (a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, target: THREE.Vector3) => {
    const k = 1 - u;
    return target.set(
      k * k * a.x + 2 * k * u * c.x + u * u * b.x,
      k * k * a.y + 2 * k * u * c.y + u * u * b.y,
      k * k * a.z + 2 * k * u * c.z + u * u * b.z,
    );
  };

  const update = (t: number, calm: boolean) => {
    const amp = calm ? 0.35 : 1;
    const lt = ((t % LOOP) + LOOP) % LOOP;

    // Endosome approach, pore opening and merging.
    let rE = R_E;
    let rho = 0;
    let xE: number;
    if (lt < T.approachEnd) {
      xE = THREE.MathUtils.lerp(-390, -(R_L + NECK_LEN + R_E), easeInOut(lt / T.approachEnd));
    } else {
      rho = NECK_MAX * smooth((lt - T.approachEnd) / (T.poreOpen - T.approachEnd));
      if (lt > T.mergeStart) {
        rE = R_E * (1 - easeInOut((lt - T.mergeStart) / (T.mergeEnd - T.mergeStart)));
        rho = Math.min(rho, rE * 0.8);
      }
      xE = -Math.sqrt(R_L * R_L - rho * rho) - NECK_LEN - Math.sqrt(Math.max(0, rE * rE - rho * rho));
    }
    endoState.visible = rE > 1;
    endoState.scale = rE / R_E;
    endosome.visible = endoState.visible;
    endosome.position.set(xE, 0, 0);
    endosome.scale.setScalar(Math.max(0.001, endoState.scale));
    endoCenter.set(xE, 0, 0);
    endoHole.center.copy(endoCenter);
    endoHole.radius.value = rho;
    lysoHole.radius.value = rho;
    // The neck runs between the luminal faces, covering the cut membranes around the pore.
    const rEin = (R_E - MEMBRANE) * endoState.scale;
    neckA.set(xE + Math.sqrt(Math.max(0, rEin * rEin - rho * rho)), 0, 0);
    neckB.set(-Math.sqrt(Math.max(0, (R_L - MEMBRANE) * (R_L - MEMBRANE) - rho * rho)), 0, 0);
    neck.set(neckA, neckB, endoState.visible ? rho : 0);
    // Glycans give way where the pore is open.
    poreGlycans.forEach(({ i, p }, k) => {
      const open = rho > 0.5 && p.position.y * p.position.y + p.position.z * p.position.z < (rho + 4) * (rho + 4);
      if (open) glycans.setMatrixAt(i, m.makeScale(0, 0, 0));
      else glycans.setMatrixAt(i, glycanMatrices[k]);
    });
    glycans.instanceMatrix.needsUpdate = true;

    // Cargo and vesicles travel from the endosome through the neck into the lumen.
    const neckPoint = (offset: THREE.Vector3, target: THREE.Vector3) => target.set(neckB.x - 4, offset.y * 0.25, Math.min(-12, offset.z * 0.7));
    const transferU = (k: number) => smooth((lt - T.transferStart - k * T.transferStep) / T.transferDuration);
    aggregates.forEach((agg, a) => {
      const u = transferU(a);
      v.copy(endoCenter).add(agg.offset);
      if (u <= 0) aggCenter[a].copy(v);
      else bezier(v, neckPoint(agg.offset, w), agg.dest, u, aggCenter[a]);
      wander(a * 5 + 1, lt * 0.7, 1.2 * amp, w);
      aggCenter[a].add(w);
    });
    ilvs.forEach((ilv, i) => {
      const u = transferU(aggregates.length + i);
      v.copy(endoCenter).add(ilv.offset);
      if (u <= 0) w.copy(v);
      else bezier(v, neckPoint(ilv.offset, w), ilv.dest, u, w);
      const digest = 1 - smooth((lt - T.ilvDigest[0] - i * 0.4) / (T.ilvDigest[1] - T.ilvDigest[0]));
      const visible = (u > 0 || endoState.visible) && digest > 0.01 && lt < T.ilvDigest[1] + 2;
      const r = ilv.r * digest * (u > 0 ? 1 : Math.min(1, endoState.scale * 1.2));
      ilvMesh.setMatrixAt(i, visible ? m.compose(w, q.identity(), s.setScalar(Math.max(0.001, r))) : m.makeScale(0, 0, 0));
    });
    ilvMesh.instanceMatrix.needsUpdate = true;

    // Pieces: binary splitting 1 → 2 → 4 → 8, then amino acids.
    const [s1, s2, s3, s4] = T.splits;
    const level = lt < s1 ? 0 : lt < s2 ? 1 : lt < s3 ? 2 : 3;
    const splitAt = [0, s1, s2, s3];
    const dissolve = smooth((lt - s4) / 0.5);
    aggregates.forEach((agg, a) => {
      const base = a * nodesPerTree;
      nodePos[base].copy(aggCenter[a]);
      for (let n = 1; n < nodesPerTree; n++) {
        const l = Math.floor(Math.log2(n + 1));
        const parent = Math.floor((n - 1) / 2);
        const sign = n % 2 === 1 ? 1 : -1;
        const rc = pieceRadius(agg.r, l);
        const sinceSplit = Math.max(0, lt - splitAt[l]);
        const d = rc * (0.35 + 0.8 * (1 - Math.exp(-sinceSplit / 0.35)) + 0.5 * smooth(sinceSplit / 2.5));
        nodePos[base + n].copy(nodePos[base + parent]).addScaledVector(pieceDirs[base + parent], sign * d);
      }
      for (let n = 0; n < nodesPerTree; n++) {
        const l = Math.floor(Math.log2(n + 1));
        const show = l === level && lt < s4 + 0.5 && (lt >= T.transferStart || endoState.visible);
        if (!show) {
          pieces.setMatrixAt(base + n, m.makeScale(0, 0, 0));
          continue;
        }
        const r = pieceRadius(agg.r, l) * (l === 3 ? 1 - dissolve : 1);
        q.copy(pieceRot[base + n]).multiply(tmpQuat.setFromAxisAngle(tmpAxis, lt * 0.3 * amp + n));
        pieces.setMatrixAt(base + n, m.compose(nodePos[base + n], q, s.setScalar(Math.max(0.001, r))));
      }
    });
    pieces.instanceMatrix.needsUpdate = true;

    // Hydrolase workers gather on the cargo, cut, then drift back.
    for (let k = 0; k < workerCount; k++) {
      const a = Math.floor(k / 4);
      const wl = k % 4;
      const l = Math.max(0, level);
      const node = a * nodesPerTree + (1 << l) - 1 + (wl % (1 << l));
      const r = pieceRadius(aggregates[a].r, l);
      tmpDir.copy(tetra[wl]);
      v.copy(nodePos[node]).addScaledVector(tmpDir, r + workerScale[k] * 0.9);
      const home = workerHomes[k];
      wander(k * 2.3 + 7, lt * 0.5, 3 * amp, w);
      if (lt < T.gatherStart) w.add(home);
      else if (lt < T.gatherEnd) w.lerpVectors(home, v, easeInOut((lt - T.gatherStart) / (T.gatherEnd - T.gatherStart)));
      else if (lt < T.returnStart) w.copy(v);
      else w.lerpVectors(v, home, easeInOut((lt - T.returnStart) / (T.returnEnd - T.returnStart)));
      workers.setMatrixAt(k, m.compose(w, workerRot[k], s.setScalar(workerScale[k])));
    }
    workers.instanceMatrix.needsUpdate = true;

    // Amino acids: from the last pieces to the transporters and out into the cytosol.
    beadsState.visible = false;
    for (let b = 0; b < beadCount; b++) {
      const info = beadInfo[b];
      const age = lt - s4;
      const p = beadPositions[b];
      if (age < 0 || age > info.delay + info.travel + 1.5) {
        beads.setMatrixAt(b, m.makeScale(0, 0, 0));
        continue;
      }
      const birth = v.copy(nodePos[info.tree * nodesPerTree + info.node]).add(info.offset);
      const dir = dirAt(TRANSPORTER_ANGLES[info.transporter], tmpDir);
      const mouth = w.copy(dir).multiplyScalar(R_L - 14);
      mouth.z = -2;
      let scale = 1;
      if (age < info.delay) {
        p.copy(birth);
        scale = smooth(age / 0.3);
      } else if (age < info.delay + info.travel) {
        const u = easeInOut((age - info.delay) / info.travel);
        p.lerpVectors(birth, mouth, u);
        wander(info.seed, lt * 1.3, 3 * Math.sin(u * Math.PI) * amp, s);
        p.add(s);
      } else {
        const u = (age - info.delay - info.travel) / 1.5;
        p.copy(dir).multiplyScalar(THREE.MathUtils.lerp(R_L - 14, R_L + 36, u));
        p.z = THREE.MathUtils.lerp(-2, 2, u);
        wander(info.seed, lt * 1.3, 4 * u * amp, s);
        p.addScaledVector(s, 1);
        scale = 1 - smooth((u - 0.6) / 0.4);
      }
      if (b === 0) beadsState.visible = age > 0.2 && age < info.delay + info.travel + 0.6;
      beads.setMatrixAt(b, m.compose(p, q.identity(), s.setScalar(Math.max(0.001, scale))));
    }
    beads.instanceMatrix.needsUpdate = true;

    // Protons wander in the lumen; pumps add new ones at the membrane.
    for (let i = 0; i < protonCount; i++) {
      wander(i + 0.37, t * (calm ? 0.15 : 0.35), 5 * amp, v).add(protonHomes[i]);
      lumenProtons.positions[i * 3] = v.x;
      lumenProtons.positions[i * 3 + 1] = v.y;
      lumenProtons.positions[i * 3 + 2] = v.z;
      lumenProtons.alphas[i] = 0.6;
    }
    lumenProtons.commit();
    PUMP_ANGLES.forEach((deg, i) => {
      const dir = dirAt(deg, tmpDir);
      for (let k = 0; k < 2; k++) {
        const slot = i * 2 + k;
        const period = 2.4;
        const age = ((t + i * 0.37 + k * period * 0.5) % period + period) % period;
        const u = age / period;
        v.copy(dir).multiplyScalar(R_L - 8 - 22 * smooth(u)).addScaledVector(pumpDrift[slot], smooth(u));
        v.z = Math.min(v.z, 1);
        pumped.positions[slot * 3] = v.x;
        pumped.positions[slot * 3 + 1] = v.y;
        pumped.positions[slot * 3 + 2] = v.z;
        pumped.alphas[slot] = Math.min(1, u / 0.12) * (1 - u);
      }
    });
    pumped.commit();
  };
  update(0, false);

  // ── Labels ──
  const hydroLabel = hydroPositions.reduce((best, p) => (p.distanceTo(new THREE.Vector3(70, -40, -20)) < best.distanceTo(new THREE.Vector3(70, -40, -20)) ? p : best));
  const endoAnchor = new THREE.Vector3();
  const labels: CloseupLabel[] = [
    { part: 'membrane', anchor: anchorOn(root, dirAt(137).multiplyScalar(R_L - 1).setZ(0.2)) },
    { part: 'lumen', anchor: anchorOn(root, new THREE.Vector3(55, 5, -80)) },
    { part: 'v-atpase', anchor: anchorOn(root, dirAt(234).multiplyScalar(R_L + 11).setZ(5)) },
    { part: 'hydrolase', anchor: anchorOn(root, hydroLabel.clone()) },
    { part: 'membrane-glycans', anchor: anchorOn(root, dirAt(292).multiplyScalar(R_L - 8).setZ(-2)) },
    { part: 'transporter', anchor: anchorOn(root, dirAt(326).multiplyScalar(R_L - 2).setZ(3.5)) },
    {
      textKey: 'structures.endosomes.parts.late-endosome.name',
      anchor: () => endoAnchor.set(endosome.position.x - 10, R_E * endoState.scale * 0.92, 2),
      visible: () => endoState.visible && endoState.scale > 0.6 && endosome.position.x > -300,
    },
    { textKey: 'closeupCaptions.aminoAcids', anchor: () => beadPositions[0], visible: () => beadsState.visible },
  ];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(-66, 0, -14),
        radius: 212,
        direction: new THREE.Vector3(0.06, 0.12, 1).normalize(),
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      const ct = new URLSearchParams(location.search).get('ct'); // TEMP-DEV
      if (ct) t = Number(ct); // TEMP-DEV
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      update(t, calm);
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      disposeScene(scene);
    },
  };
};

export default create;
