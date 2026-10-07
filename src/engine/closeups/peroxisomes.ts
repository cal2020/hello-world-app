import * as THREE from 'three';
import { Rng } from '../core/random';
import { createCloseupScene, disposeScene, easeInOut, smooth } from './common';
import { addInstanceGlow, addJiggle, byQuality, createJiggle, instanced, instancedMaterial, proteinShapes, randomQuaternion, setSeeds, type Placement } from './kit';
import { addHoleClip, arcPoints, cutFaceMaterial, halos, membraneBands, membraneMaterial, paintedLumps, ribbonGeometry, wander, type HoleClip, type Lump } from './energyParts';
import type { CloseupFactory, CloseupLabel } from './types';

/**
 * Part of a peroxisome (1 unit = 1 nm), cut open: the curved floor of a
 * 400-nm organelle with the matrix above and the cytosol below. An oxidase
 * (blue) turns a substrate and O2 into a product and H2O2; catalase (green)
 * turns 2 H2O2 into 2 H2O and O2; a very-long-chain fatty acid enters through
 * ABCD1 and loses two-carbon pieces; PEX5 (yellow) delivers a new enzyme.
 * The loop lasts 20 s. Water, oxygen and peroxide are drawn about twice
 * their true size and marked with a soft glow.
 */

const LOOP = 20;
const R = 200; // peroxisome radius (400 nm)
const MEM = 6; // membrane thickness
const C = new THREE.Vector3(0, 160, 0); // sphere centre: the floor's lowest point is at y = −40
const THETA_MAX = THREE.MathUtils.degToRad(40);
const R_MID = R - MEM / 2;

const COLORS = {
  membrane: '#b5e853',
  membraneInner: '#7fa83f',
  oxidase: '#4d9dff',
  oxidase2: '#6aadff',
  catalase: '#4cd17a',
  catalase2: '#9be564',
  abcd1: '#5ccfc0',
  dock: '#c2b46a',
  pex5: '#ffe14d',
  newEnzyme: '#c7f59a',
  betaOx: '#7fbf8f',
  oxygenO: '#ff4a4a',
  peroxideO: '#f1e6ff',
  waterO: '#cfe7ff',
  hydrogen: '#ffffff',
  substrate: '#ffa94d',
  product: '#ffe2b8',
  chain: '#ffc44d',
};

/** y of the membrane mid-plane (or another shell radius) at x, z. */
const floorY = (x: number, z = 0, r = R_MID) => C.y - Math.sqrt(Math.max(0, r * r - x * x - z * z));

const T = {
  ox: [
    { approach: [0.4, 2.4], react: [2.4, 3.2], travel: [3.2, 5.0], away: [3.2, 6.6] },
    { approach: [5.2, 7.2], react: [7.2, 8.0], travel: [8.0, 9.8], away: [8.0, 11.4] },
  ],
  convert: 0.3,
  waterAway: 3.3,
  o2Away: [10.1, 13.6],
  fatty: { enter: [9.0, 12.0], cycles: [12.8, 14.2, 15.6, 17.0], leave: [18.0, 19.6] },
  pex: { approach: [11.0, 13.0], insert: [13.0, 14.0], release: [14.0, 15.6], back: [15.4, 18.0], fade: [17.4, 19.2], reload: [18.4, 19.6] },
};

function floorGeometry(r: number, rings: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * THETA_MAX;
    for (let j = 0; j <= segments; j++) {
      const phi = Math.PI + (j / segments) * Math.PI; // z ≤ 0: the back half
      const d = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), -Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      positions.push(C.x + d.x * r, C.y + d.y * r, C.z + d.z * r);
      normals.push(d.x, d.y, d.z);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  // Make front faces point outward (away from the centre).
  const p = (k: number) => new THREE.Vector3(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]);
  const [i0, i1, i2] = [indices[6 * segments], indices[6 * segments + 1], indices[6 * segments + 2]];
  const n = new THREE.Vector3().crossVectors(p(i1).sub(p(i0)), p(i2).sub(p(i0)));
  if (n.dot(p(i0).sub(C)) < 0) for (let k = 0; k < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#0c1a12');
  const rng = new Rng('closeup:peroxisomes');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);
  const disposables: { dispose(): void }[] = [];
  const detail = quality === 'low' ? 1 : 2;

  // ── Membrane: the curved floor of the organelle, cut at z = 0 ──
  const dockX = 58;
  const pore: HoleClip = { center: new THREE.Vector3(dockX, floorY(dockX) - 20, 0), axis: new THREE.Vector3(0, 1, 0), radius: { value: 0 } };
  const rings = byQuality(quality, { low: 20, medium: 26, high: 32 });
  const segments = byQuality(quality, { low: 40, medium: 56, high: 72 });
  const outerMaterial = membraneMaterial(COLORS.membrane, { side: THREE.FrontSide });
  const innerMaterial = membraneMaterial(COLORS.membraneInner, { side: THREE.BackSide, rim: 0.2 });
  addHoleClip(outerMaterial, pore, 'peroxOuter');
  addHoleClip(innerMaterial, pore, 'peroxInner');
  root.add(new THREE.Mesh(floorGeometry(R, rings, segments), outerMaterial), new THREE.Mesh(floorGeometry(R - MEM, rings, segments), innerMaterial));
  const arc = arcPoints(C.x, C.y, R_MID, -Math.PI / 2 - THETA_MAX, -Math.PI / 2 + THETA_MAX, byQuality(quality, { low: 80, medium: 110, high: 140 }));
  const edgeMaterial = cutFaceMaterial(0.25);
  addHoleClip(edgeMaterial, pore, 'peroxEdge');
  root.add(new THREE.Mesh(ribbonGeometry(arc, false, MEM, membraneBands('#f4f7d8', '#a3b04a'), 0.08), edgeMaterial));

  // Vertex-coloured, softly self-lit material for the featured proteins.
  const proteinMaterial = instancedMaterial({ vertexColors: true, roughness: 0.5 });
  addInstanceGlow(proteinMaterial, 0.22, 'peroxProteins');
  const protein = (seed: string, lumps: Lump[]) => {
    const mesh = new THREE.Mesh(paintedLumps(seed, lumps, detail + 1), proteinMaterial);
    root.add(mesh);
    return mesh;
  };

  // ── Oxidase (blue dimer, ~10 nm) and catalase (green tetramer, ~11 nm) ──
  const oxidase = protein('oxidase', [
    { at: [-2.5, 0, 0], r: [2.9, 3.4, 3.0], color: COLORS.oxidase },
    { at: [-3.4, 2.4, -0.9], r: 1.7, color: COLORS.oxidase },
    { at: [2.5, 0.1, 0], r: [2.9, 3.3, 3.0], color: COLORS.oxidase2 },
    { at: [3.3, -2.3, 0.8], r: 1.7, color: COLORS.oxidase2 },
  ]);
  oxidase.position.set(-24, 6, -9);
  const catalaseLumps: Lump[] = [];
  const tetra = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, -1, 1), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(1, -1, -1)];
  tetra.forEach((v, i) => {
    const c = v.clone().normalize().multiplyScalar(2.8);
    catalaseLumps.push({ at: [c.x, c.y, c.z], r: 3.05, color: i % 2 ? COLORS.catalase2 : COLORS.catalase });
    const d = v.clone().normalize().multiplyScalar(4.4);
    catalaseLumps.push({ at: [d.x, d.y + 0.6, d.z], r: 1.5, color: i % 2 ? COLORS.catalase2 : COLORS.catalase });
  });
  const catalase = protein('catalase', catalaseLumps);
  catalase.position.set(24, 3, -9);
  catalase.rotation.set(0.3, 0.5, 0.1);

  // ── ABCD1 transporter in the membrane, and the docking complex for PEX5 ──
  const abcdX = -42;
  const abcd = protein('abcd1', [
    { at: [-1.7, 0, 0], r: [2.1, 3.4, 2.3], color: COLORS.abcd1 },
    { at: [1.7, 0, 0], r: [2.1, 3.4, 2.3], color: COLORS.abcd1 },
    { at: [-1.9, -5.2, 0.2], r: 2.1, color: COLORS.abcd1 },
    { at: [1.9, -5.2, -0.2], r: 2.1, color: COLORS.abcd1 },
  ]);
  const abcdUp = new THREE.Vector3(-abcdX, C.y - floorY(abcdX), 0).normalize();
  abcd.position.set(abcdX, floorY(abcdX), 0.6);
  abcd.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), abcdUp);
  const dockUp = new THREE.Vector3(-dockX, C.y - floorY(dockX), 0).normalize();
  const dock = protein('dock', [
    { at: [-3.6, 0, 0], r: [1.9, 3.3, 2.2], color: COLORS.dock },
    { at: [3.6, 0, 0], r: [1.9, 3.3, 2.2], color: COLORS.dock },
    { at: [-3.4, -4.0, 0.6], r: 1.5, color: COLORS.dock },
    { at: [3.8, -3.8, -0.4], r: 1.4, color: COLORS.dock },
  ]);
  dock.position.set(dockX, floorY(dockX), 0.6);
  dock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dockUp);
  pore.center.set(dockX, floorY(dockX) - 20, 0);
  pore.axis.copy(dockUp);

  // ── PEX5 (yellow) carrying a newly made enzyme ──
  const pex5 = protein('pex5', [
    { at: [0, -3.4, 0], r: 1.8, color: COLORS.pex5 },
    { at: [0.9, -1.4, 0.3], r: 1.95, color: COLORS.pex5 },
    { at: [1.2, 0.8, 0], r: 2.0, color: COLORS.pex5 },
    { at: [0.8, 2.9, -0.3], r: 1.9, color: COLORS.pex5 },
    { at: [-0.2, 4.4, 0], r: 1.6, color: COLORS.pex5 },
  ]);
  const newEnzyme = protein('new-enzyme', [
    { at: [0, 0, 0], r: [2.5, 2.2, 2.3], color: COLORS.newEnzyme },
    { at: [1.6, 1.3, 0.4], r: 1.3, color: COLORS.newEnzyme },
  ]);
  // β-oxidation enzyme that clips the fatty acid (unlabelled).
  const betaOx = protein('beta-ox', [
    { at: [0, 0, 0], r: [3.0, 2.6, 2.8], color: COLORS.betaOx },
    { at: [2.6, 1.4, -0.5], r: 1.9, color: COLORS.betaOx },
    { at: [-2.2, 1.6, 0.4], r: 1.7, color: COLORS.betaOx },
  ]);
  betaOx.position.set(-27, -11, -8);

  // ── Crowded matrix: background enzymes (and more catalase) jiggling behind the stage ──
  const shapes = proteinShapes('perox-bg', 4, detail, 0.28);
  disposables.push(...shapes);
  const bgMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(bgMaterial, 0.12, 'peroxBg');
  addJiggle(bgMaterial, jiggle, new THREE.Vector3(0.5, 0.5, 0.5), 0.5, 'peroxBgJiggle');
  const bgColors = ['#5f8f63', '#6f9f6c', '#4f857c', '#7d9d62', '#5c7f97', '#6a9a84'].map((c) => new THREE.Color(c));
  const bgCount = byQuality(quality, { low: 90, medium: 130, high: 170 });
  const buckets: Placement[][] = shapes.map(() => []);
  const seedBuckets: number[][] = shapes.map(() => []);
  const featured = [oxidase.position, catalase.position, betaOx.position];
  for (let i = 0, placed = 0; i < bgCount * 6 && placed < bgCount; i++) {
    const p = new THREE.Vector3(rng.range(-95, 95), rng.range(-30, 75), rng.range(-85, -16));
    const r = rng.range(2.4, 5.2);
    if (p.y - r < floorY(p.x, p.z, R - MEM) + 2) continue;
    if (featured.some((f) => f.distanceTo(p) < r + 9)) continue;
    const k = placed % shapes.length;
    buckets[k].push({ position: p, quaternion: randomQuaternion(rng), scale: r, color: bgColors[rng.int(0, bgColors.length - 1)].clone().offsetHSL(0, -0.05, rng.range(-0.08, 0.02)) });
    seedBuckets[k].push(placed);
    placed++;
  }
  shapes.forEach((shape, k) => {
    if (!buckets[k].length) return;
    const mesh = instanced(shape, bgMaterial, buckets[k]);
    setSeeds(mesh, seedBuckets[k]);
    root.add(mesh);
  });

  // ── Small molecules (drawn ~2× enlarged) ──
  const atomShape = new THREE.IcosahedronGeometry(1, 1);
  disposables.push(atomShape);
  const atomMaterial = instancedMaterial({ roughness: 0.35 });
  addInstanceGlow(atomMaterial, 0.4, 'peroxAtoms');
  // Atoms: 0–3 oxygens (O_a0, O_b0, O_a1, O_b1), 4–7 hydrogens (H for molecule 0, then 1).
  const atoms = new THREE.InstancedMesh(atomShape, atomMaterial, 8);
  atoms.frustumCulled = false;
  const substrateMesh = new THREE.InstancedMesh(atomShape, atomMaterial, 8);
  substrateMesh.frustumCulled = false;
  const chainCount = 24;
  const chain = new THREE.InstancedMesh(atomShape, atomMaterial, chainCount);
  chain.frustumCulled = false;
  const chainColor = new THREE.Color(COLORS.chain);
  for (let i = 0; i < chainCount; i++) chain.setColorAt(i, chainColor);
  root.add(atoms, substrateMesh, chain);
  const glow = halos(16, ctx.pointScale);
  root.add(glow.points);
  disposables.push(glow);
  const setHalo = (i: number, color: THREE.ColorRepresentation, size: number) => {
    const c = new THREE.Color(color);
    glow.colors[i * 3] = c.r;
    glow.colors[i * 3 + 1] = c.g;
    glow.colors[i * 3 + 2] = c.b;
    glow.sizes[i] = size;
  };
  // Halo slots: 0–1 O2/H2O2 n, 2–3 water n, 4 O2 out, 5 bound O, 6–7 substrate n, 8–11 C2 pieces, 12–14 chain.
  setHalo(2, '#9fd4ff', 2.6);
  setHalo(3, '#9fd4ff', 2.6);
  setHalo(4, '#ff5a5a', 2.6);
  setHalo(5, '#ff5a5a', 1.6);
  setHalo(6, '#ffae5c', 2.8);
  setHalo(7, '#ffae5c', 2.8);
  for (let i = 8; i < 12; i++) setHalo(i, '#ffd36b', 1.8);
  for (let i = 12; i < 15; i++) setHalo(i, '#ffcf5a', 2.0);

  const colorO2 = new THREE.Color(COLORS.oxygenO);
  const colorPeroxide = new THREE.Color(COLORS.peroxideO);
  const colorWater = new THREE.Color(COLORS.waterO);
  const colorH = new THREE.Color(COLORS.hydrogen);
  const colorSubstrate = new THREE.Color(COLORS.substrate);
  const colorProduct = new THREE.Color(COLORS.product);
  const haloO2 = new THREE.Color('#ff5a5a');
  const haloPeroxide = new THREE.Color('#e2ccff');

  // Reaction geometry.
  const oxSite = oxidase.position.clone().add(new THREE.Vector3(0, 0.6, 4.4));
  const catSite = catalase.position.clone().add(new THREE.Vector3(0, 0.4, 5.6));
  const starts = [
    { substrate: new THREE.Vector3(-62, 26, -6), o2: new THREE.Vector3(-46, 44, -5), away: new THREE.Vector3(-60, -2, -6) },
    { substrate: new THREE.Vector3(-58, -10, -5), o2: new THREE.Vector3(-8, 40, -5), away: new THREE.Vector3(-52, 36, -7) },
  ];
  const substrateLocal = [new THREE.Vector3(-0.66, 0, 0), new THREE.Vector3(-0.2, 0.34, 0), new THREE.Vector3(0.26, 0, 0.1), new THREE.Vector3(0.7, 0.32, 0)];
  const waterAway = [new THREE.Vector3(14, 12, 2), new THREE.Vector3(18, -6, 3)];
  const o2AwayTarget = catSite.clone().add(new THREE.Vector3(12, 16, 1));

  // Fatty-acid path: cytosol → ABCD1 → matrix, ending at the β-oxidation enzyme.
  const fattyPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(abcdX + 2, floorY(abcdX) - 16, 2.5),
    new THREE.Vector3(abcdX + 0.5, floorY(abcdX) - 6, 1.5),
    new THREE.Vector3(abcdX + 0.6, floorY(abcdX) + 1, 1),
    new THREE.Vector3(abcdX + 4, floorY(abcdX) + 9, -1.5),
    new THREE.Vector3(betaOx.position.x - 4.5, betaOx.position.y - 1, betaOx.position.z + 4),
  ]);
  const fattySamples = 160;
  const fattyPoints = fattyPath.getSpacedPoints(fattySamples);
  const fattyLength = fattyPath.getLength();
  const bondRise = 0.127; // nm along the chain per carbon
  const pieceDrift = [new THREE.Vector3(-6, 9, 2), new THREE.Vector3(-9, 4, 3), new THREE.Vector3(-4, 11, 1), new THREE.Vector3(-10, 8, 2)];

  // PEX5 path.
  const pexStart = new THREE.Vector3(74, -88, 3);
  const pexDock = new THREE.Vector3(dockX, floorY(dockX), 1.2).addScaledVector(dockUp, -10);
  const pexInserted = new THREE.Vector3(dockX, floorY(dockX), 1.2).addScaledVector(dockUp, -1.5);
  const enzymeDestination = new THREE.Vector3(dockX - 9, floorY(dockX) + 20, -4);

  // Scratch.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  const center = new THREE.Vector3();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const molCenter = [new THREE.Vector3(), new THREE.Vector3()];
  const waterCenter = [new THREE.Vector3(), new THREE.Vector3()];
  const o2OutCenter = new THREE.Vector3();
  const substrateCenter = [new THREE.Vector3(), new THREE.Vector3()];
  const chainPos = Array.from({ length: chainCount }, () => new THREE.Vector3());
  const state = { peroxide: -1, water: -1, oxygen: -1, chainVisible: false };
  const hLocal = [new THREE.Vector3(-0.62, 0.36, 0.18), new THREE.Vector3(0.62, 0.36, -0.18)];
  const waterH = [new THREE.Vector3(-0.42, 0.32, 0), new THREE.Vector3(0.42, 0.32, 0)];

  const atomAt = (i: number, p: THREE.Vector3, radius: number, color: THREE.Color) => {
    atoms.setMatrixAt(i, m.compose(p, q.identity(), s.setScalar(radius)));
    atoms.setColorAt(i, color);
  };
  const bezier = (a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, target: THREE.Vector3) => {
    const k = 1 - u;
    return target.set(k * k * a.x + 2 * k * u * c.x + u * u * b.x, k * k * a.y + 2 * k * u * c.y + u * u * b.y, k * k * a.z + 2 * k * u * c.z + u * u * b.z);
  };
  const ctrl = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const rotated = new THREE.Vector3();
  const fattyPoint = (sArc: number, target: THREE.Vector3) => {
    const f = THREE.MathUtils.clamp(sArc / fattyLength, 0, 1) * fattySamples;
    const i = Math.min(fattySamples - 1, Math.floor(f));
    return target.lerpVectors(fattyPoints[i], fattyPoints[i + 1], f - i);
  };

  const update = (t: number, calm: boolean) => {
    const amp = calm ? 0.35 : 1;
    const lt = ((t % LOOP) + LOOP) % LOOP;
    state.peroxide = -1;
    state.water = -1;
    state.oxygen = -1;

    // ── Oxidase reactions and catalase ──
    for (let n = 0; n < 2; n++) {
      const ox = T.ox[n];
      const st = starts[n];
      const atomA = n * 2;
      const atomB = n * 2 + 1;
      const fadeIn = smooth((lt - ox.approach[0]) / 0.4);
      const tumble = lt * 0.9 * amp + n * 2;
      // Substrate → product.
      let substrateVisible = lt >= ox.approach[0] && lt < ox.away[1];
      let substrateScale = 1;
      if (lt < ox.approach[1]) {
        const u = easeInOut((lt - ox.approach[0]) / (ox.approach[1] - ox.approach[0]));
        substrateCenter[n].lerpVectors(st.substrate, v.copy(oxSite).add(w.set(-1.0, 0.4, 0.4)), u);
        substrateScale = fadeIn;
      } else if (lt < ox.react[1]) {
        substrateCenter[n].copy(oxSite).add(w.set(-1.0, 0.4, 0.4));
      } else {
        const u = smooth((lt - ox.away[0]) / (ox.away[1] - ox.away[0]));
        substrateCenter[n].lerpVectors(v.copy(oxSite).add(w.set(-1.0, 0.4, 0.4)), st.away, u);
        substrateScale = 1 - smooth((u - 0.7) / 0.3);
      }
      if (substrateScale < 0.02) substrateVisible = false;
      const reacted = smooth((lt - ox.react[0]) / (ox.react[1] - ox.react[0]));
      e.set(tumble * 0.7, tumble, 0.3);
      rot.setFromEuler(e);
      for (let b = 0; b < 4; b++) {
        rotated.copy(substrateLocal[b]).applyQuaternion(rot).multiplyScalar(substrateScale);
        v.copy(substrateCenter[n]).add(rotated);
        substrateMesh.setMatrixAt(n * 4 + b, substrateVisible ? m.compose(v, q.identity(), s.setScalar(0.34 * substrateScale)) : hidden);
        substrateMesh.setColorAt(n * 4 + b, w.set(0, 0, 0) && colorSubstrateMix(reacted, b));
      }
      glow.set(6 + n, substrateCenter[n], substrateVisible ? 0.55 * substrateScale : 0);

      // O2 → H2O2 at the oxidase; H2O2 → catalase.
      const mol = molCenter[n];
      const travelEnd = ox.travel[1];
      const converted = lt >= travelEnd + T.convert;
      let molVisible = lt >= ox.approach[0] && !converted;
      let scale = 1;
      if (lt < ox.approach[1]) {
        mol.lerpVectors(st.o2, v.copy(oxSite).add(w.set(1.1, -0.4, 0.5)), easeInOut((lt - ox.approach[0]) / (ox.approach[1] - ox.approach[0])));
        scale = fadeIn;
      } else if (lt < ox.react[1]) {
        mol.copy(oxSite).add(w.set(1.1, -0.4, 0.5));
      } else if (lt < travelEnd) {
        const u = easeInOut((lt - ox.travel[0]) / (ox.travel[1] - ox.travel[0]));
        ctrl.addVectors(oxSite, catSite).multiplyScalar(0.5).add(w.set(0, 11 - n * 4, 2));
        bezier(v.copy(oxSite).add(w.set(1.1, -0.4, 0.5)), ctrl, catSite, u, mol);
      } else {
        mol.copy(catSite);
      }
      if (lt < ox.approach[0]) molVisible = false;
      const isPeroxide = lt >= ox.react[0] + 0.4 && molVisible;
      if (isPeroxide && lt >= ox.react[1]) state.peroxide = n;
      if (molVisible && !isPeroxide) state.oxygen = n;
      e.set(tumble, tumble * 0.6, n);
      rot.setFromEuler(e);
      const peroxideMix = smooth((lt - ox.react[0] - 0.2) / 0.6);
      const oSpacing = THREE.MathUtils.lerp(0.31, 0.36, peroxideMix);
      // O atoms of this molecule while it is O2 / H2O2.
      if (molVisible) {
        for (const [index, sign] of [
          [atomA, -1],
          [atomB, 1],
        ] as const) {
          rotated.set(sign * oSpacing, 0, 0).applyQuaternion(rot).multiplyScalar(scale);
          v.copy(mol).add(rotated);
          atomAt(index, v, 0.36 * scale, w.copy(colorO2).lerp(colorPeroxide, peroxideMix) as THREE.Color as never);
        }
      }
      glow.set(n, mol, molVisible ? 0.6 * scale : 0);
      setHaloColor(n, peroxideMix);
      // Hydrogens: from the substrate onto the oxygens (making H2O2), later part of water.
      for (let h = 0; h < 2; h++) {
        const index = 4 + n * 2 + h;
        if (lt < ox.react[0] || (converted && lt > travelEnd + T.convert + T.waterAway)) {
          atoms.setMatrixAt(index, hidden);
          continue;
        }
        if (!converted) {
          rotated.copy(hLocal[h]).applyQuaternion(rot);
          v.copy(mol).add(rotated);
          if (lt < ox.react[1]) {
            rotated.copy(substrateLocal[h * 3]).applyQuaternion(rot);
            w.copy(substrateCenter[n]).add(rotated);
            v.lerpVectors(w, v, reacted);
          }
        } else {
          v.copy(waterCenter[n]).add(rotated.copy(waterH[h]).applyQuaternion(rot));
        }
        atomAt(index, v, 0.22, colorH);
      }
    }

    // Catalase: H2O2 #0 → water #0 (one O stays bound); H2O2 #1 + bound O → water #1 + O2.
    for (let n = 0; n < 2; n++) {
      const start = T.ox[n].travel[1] + T.convert;
      const age = lt - start;
      const atomA = n * 2;
      if (age < 0 || age > T.waterAway) {
        glow.set(2 + n, waterCenter[n], 0);
        if (age >= 0) atoms.setMatrixAt(atomA, hidden);
        continue;
      }
      state.water = n;
      const u = smooth(age / T.waterAway);
      wander(n * 3 + 1, lt, 1.2 * amp, w);
      waterCenter[n].copy(catSite).addScaledVector(waterAway[n], u).add(w.multiplyScalar(u));
      const fade = 1 - smooth((u - 0.75) / 0.25);
      atomAt(atomA, waterCenter[n], 0.36 * fade, colorWater);
      glow.set(2 + n, waterCenter[n], 0.6 * fade);
    }
    // The bound oxygen (compound I) and the O2 released at the end.
    const bindStart = T.ox[0].travel[1] + T.convert;
    const releaseStart = T.ox[1].travel[1] + T.convert;
    if (lt >= bindStart && lt < releaseStart) {
      atomAt(1, v.copy(catSite).add(w.set(0, 0, -0.6)), 0.36, colorO2);
      glow.set(5, v, 0.4);
    } else glow.set(5, catSite, 0);
    if (lt >= releaseStart && lt < T.o2Away[1]) {
      state.oxygen = 2;
      const u = smooth((lt - T.o2Away[0]) / (T.o2Away[1] - T.o2Away[0]));
      o2OutCenter.lerpVectors(catSite, o2AwayTarget, u);
      const fade = 1 - smooth((u - 0.75) / 0.25);
      e.set(lt, lt * 0.7, 0.4);
      rot.setFromEuler(e);
      for (const [index, sign] of [
        [1, -1],
        [3, 1],
      ] as const) {
        rotated.set(sign * 0.31, 0, 0).applyQuaternion(rot);
        atomAt(index, v.copy(o2OutCenter).add(rotated), 0.36 * fade, colorO2);
      }
      glow.set(4, o2OutCenter, 0.6 * fade);
    } else {
      glow.set(4, o2OutCenter, 0);
      if (lt >= T.o2Away[1] || lt < T.ox[1].react[0]) atoms.setMatrixAt(3, hidden);
      if (lt >= T.o2Away[1] || lt < T.ox[0].approach[0]) atoms.setMatrixAt(1, hidden);
    }
    // Nothing visible before the first approach.
    if (lt < T.ox[0].approach[0]) for (let i = 0; i < 4; i++) atoms.setMatrixAt(i, hidden);
    if (lt < T.ox[1].approach[0]) {
      atoms.setMatrixAt(2, hidden);
      atoms.setMatrixAt(3, hidden);
    }
    atoms.instanceMatrix.needsUpdate = true;
    if (atoms.instanceColor) atoms.instanceColor.needsUpdate = true;
    substrateMesh.instanceMatrix.needsUpdate = true;
    if (substrateMesh.instanceColor) substrateMesh.instanceColor.needsUpdate = true;

    // ── Very-long-chain fatty acid: in through ABCD1, then shortened two carbons at a time ──
    const fa = T.fatty;
    const enter = easeInOut((lt - fa.enter[0]) / (fa.enter[1] - fa.enter[0]));
    const chainVisible = lt >= fa.enter[0] && lt < fa.leave[1];
    state.chainVisible = chainVisible;
    const headArc = THREE.MathUtils.lerp(chainCount * bondRise + 0.5, fattyLength - 0.4, enter);
    let removed = 0;
    for (const c of fa.cycles) if (lt >= c) removed += 2;
    const leave = smooth((lt - fa.leave[0]) / (fa.leave[1] - fa.leave[0]));
    wander(7, lt * 0.8, 0.5 * amp * enter, w);
    for (let i = 0; i < chainCount; i++) {
      const p = chainPos[i];
      if (!chainVisible) {
        chain.setMatrixAt(i, hidden);
        continue;
      }
      const cycle = Math.floor(i / 2);
      const pieceStart = cycle < fa.cycles.length ? fa.cycles[cycle] : Infinity;
      if (i < removed && lt >= pieceStart) {
        // A two-carbon piece leaving.
        const age = lt - pieceStart;
        fattyPoint(headArc - (i % 2) * bondRise, v);
        p.copy(v).addScaledVector(pieceDrift[cycle], smooth(age / 2.2));
        p.y += (i % 2) * 0.1;
        const fade = 1 - smooth((age - 1.4) / 0.8);
        chain.setMatrixAt(i, fade > 0.02 ? m.compose(p, q.identity(), s.setScalar(0.18 * fade)) : hidden);
        if (i % 2 === 0) glow.set(8 + cycle, p, 0.6 * fade);
        continue;
      }
      // Remaining chain slides forward so its end stays at the enzyme.
      const shift = Math.min(removed, i - (i % 2)) - (lt < pieceStart ? 0 : 0);
      const slide = removed > 0 ? smooth((lt - fa.cycles[Math.max(0, removed / 2 - 1)]) / 0.5) : 1;
      const index = i - shift + (removed > 0 ? 2 * (1 - slide) : 0);
      fattyPoint(headArc - index * bondRise, p);
      p.x += ((i % 2) - 0.5) * 0.09;
      p.add(w);
      p.y += leave * 6;
      chain.setMatrixAt(i, m.compose(p, q.identity(), s.setScalar(0.18 * (1 - leave))));
    }
    for (let c = 0; c < fa.cycles.length; c++) if (!(lt >= fa.cycles[c] && lt < fa.cycles[c] + 2.2)) glow.set(8 + c, center, 0);
    const mid = Math.min(chainCount - 1, removed + 6);
    glow.set(12, chainPos[Math.min(chainCount - 1, removed + 2)], chainVisible ? 0.5 * (1 - leave) : 0);
    glow.set(13, chainPos[mid], chainVisible ? 0.5 * (1 - leave) : 0);
    glow.set(14, chainPos[chainCount - 3], chainVisible ? 0.5 * (1 - leave) : 0);
    chain.instanceMatrix.needsUpdate = true;

    // ── PEX5 import ──
    const px = T.pex;
    if (lt < px.approach[0] || lt >= px.back[1]) pex5.position.copy(pexStart);
    else if (lt < px.insert[0]) pex5.position.lerpVectors(pexStart, pexDock, easeInOut((lt - px.approach[0]) / (px.approach[1] - px.approach[0])));
    else if (lt < px.release[1]) pex5.position.lerpVectors(pexDock, pexInserted, smooth((lt - px.insert[0]) / (px.insert[1] - px.insert[0])) * (1 - smooth((lt - px.release[0] - 0.6) / 0.9)));
    else pex5.position.lerpVectors(pexDock, pexStart, easeInOut((lt - px.back[0]) / (px.back[1] - px.back[0])));
    wander(11, lt * 0.6, 0.8 * amp, w);
    pex5.position.add(w);
    pex5.quaternion.setFromUnitVectors(v.set(0, 1, 0), dockUp);
    pore.radius.value = lt >= px.insert[0] - 0.2 && lt < px.release[1] ? 4.6 * smooth((lt - px.insert[0] + 0.2) / 0.5) : 0;
    // The new enzyme rides on PEX5, is released into the matrix, then mingles with the others.
    const enzymeScale = lt < px.reload[0] && lt >= px.fade[1] ? 0 : lt >= px.reload[0] ? smooth((lt - px.reload[0]) / (px.reload[1] - px.reload[0])) : 1 - smooth((lt - px.fade[0]) / (px.fade[1] - px.fade[0]));
    if (lt < px.release[0] || lt >= px.reload[0]) newEnzyme.position.copy(pex5.position).addScaledVector(dockUp, 6.2);
    else {
      const u = easeInOut((lt - px.release[0]) / (px.release[1] - px.release[0]));
      v.copy(pexInserted).addScaledVector(dockUp, 6.2);
      newEnzyme.position.lerpVectors(v, enzymeDestination, u);
      wander(13, lt * 0.5, 1.5 * amp * u, w);
      newEnzyme.position.add(w);
    }
    newEnzyme.scale.setScalar(Math.max(0.001, enzymeScale));
    newEnzyme.visible = enzymeScale > 0.01;
    glow.commit();

    // Gentle thermal motion of the featured enzymes.
    wander(21, lt * 0.5, 0.25 * amp, w);
    oxidase.position.set(-24 + w.x, 6 + w.y, -9 + w.z);
    wander(23, lt * 0.5, 0.25 * amp, w);
    catalase.position.set(24 + w.x, 3 + w.y, -9 + w.z);
  };

  const colorSubstrateMix = (reacted: number, bead: number): THREE.Color => tmpColor.copy(colorSubstrate).lerp(colorProduct, reacted).offsetHSL(0, 0, bead * 0.01);
  const tmpColor = new THREE.Color();
  const setHaloColor = (i: number, mix: number) => {
    tmpColor.copy(haloO2).lerp(haloPeroxide, mix);
    glow.colors[i * 3] = tmpColor.r;
    glow.colors[i * 3 + 1] = tmpColor.g;
    glow.colors[i * 3 + 2] = tmpColor.b;
    glow.sizes[i] = 2.6;
  };
  update(0, false);

  // ── Labels ──
  const anchors = {
    membrane: new THREE.Vector3(-12, floorY(-12) + MEM / 2, 0.2),
    matrix: new THREE.Vector3(-62, 52, -40),
    catalase: new THREE.Vector3(),
    oxidase: new THREE.Vector3(),
    pex5: new THREE.Vector3(),
    fatty: new THREE.Vector3(),
    peroxide: new THREE.Vector3(),
    water: new THREE.Vector3(),
    oxygen: new THREE.Vector3(),
  };
  const now = () => ((time.value % LOOP) + LOOP) % LOOP;
  const labels: CloseupLabel[] = [
    { part: 'membrane', anchor: () => anchors.membrane },
    { part: 'matrix', anchor: () => anchors.matrix },
    { part: 'catalase', anchor: () => anchors.catalase.copy(catalase.position).add(v.set(2, 5.5, 2.5)) },
    { part: 'oxidase', anchor: () => anchors.oxidase.copy(oxidase.position).add(w.set(-3, 3.8, 2.5)) },
    { part: 'import-receptor', anchor: () => anchors.pex5.copy(pex5.position).add(v.set(2.2, -1, 1.5)) },
    { part: 'fatty-acid', anchor: () => anchors.fatty.copy(chainPos[Math.min(chainCount - 1, 14)]), visible: () => state.chainVisible && now() > T.fatty.enter[0] + 1.2 },
    { textKey: 'closeupCaptions.peroxide', anchor: () => anchors.peroxide.copy(molCenter[Math.max(0, state.peroxide)]), visible: () => state.peroxide >= 0 },
    { textKey: 'closeupCaptions.water', anchor: () => anchors.water.copy(waterCenter[Math.max(0, state.water)]), visible: () => state.water >= 0 },
    {
      textKey: 'closeupCaptions.oxygen',
      anchor: () => anchors.oxygen.copy(state.oxygen === 2 ? o2OutCenter : molCenter[Math.max(0, Math.min(1, state.oxygen))]),
      visible: () => state.oxygen >= 0,
    },
  ];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, -10, -12),
        radius: 70,
        direction: new THREE.Vector3(0, 0.16, 1).normalize(),
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
