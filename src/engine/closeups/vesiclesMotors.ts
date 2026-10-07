import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeGeometries, noisyEllipsoid } from '../core/geometry';
import { createCloseupScene, disposeScene, easeInOut } from './common';
import {
  addInstanceGlow,
  byQuality,
  coiledCoilGeometry,
  instanced,
  instancedMaterial,
  membraneMaterial,
  MICROTUBULE,
  moleculeMaterial,
  sparks,
  type Placement,
} from './kit';
import { DIMER_REPEAT, PF_ANGLE, TubulinPlacer, mod, ramp, segmentMatrix, tubulinGeometry } from './cytoskeletonParts';
import type { CloseupFactory } from './types';

/**
 * Kinesin walking (1 unit = 1 nm). A kinesin-1 dimer steps hand-over-hand
 * along the top protofilament of a microtubule (plus end to the right),
 * carrying an 80 nm vesicle on its 60 nm coiled-coil stalk. One 8 nm step
 * takes 0.5 s (≈10 ms in a cell, slowed 50×). The camera "follows" the
 * motor: the kinesin stays put and the lattice slides left one tubulin dimer
 * per step (the lattice repeats every dimer, so it wraps seamlessly). A
 * cytoplasmic dynein walks the other way under the far side of the same
 * microtubule, carrying its own vesicle toward the minus end.
 */

const STEP = DIMER_REPEAT; // 8.1 nm: one tubulin dimer
const STEP_TIME = 0.5; // s per step
const SWING_START = 0.34;
const SWING_END = 0.8;
const ATP_BIND = 0.3;
/** Kinesin's protofilament points this far from straight up toward the viewer. */
const PSI = THREE.MathUtils.degToRad(-7);
/** World x of the plus-end tip. */
const X_TIP = 84;
/** Head centre distance from the microtubule axis (12.5 nm tube radius + half a head). */
const HEAD_R = 14.5;
/** Neck junction above the head centres. */
const NECK_H = 3.4;
const STALK_LEN = 60;
const VESICLE_R = 40;
/** Dynein walks on protofilament 7 (straight under the tube), with steps every 0.6 s. */
const DYNEIN_PF = 7;
const DYNEIN_STEP_TIME = 0.6;
const DYNEIN_WRAP = 25 * STEP;
const DYNEIN_LEFT = -122;
const DYNEIN_CARGO_R = 18;

const ALPHA = '#dcecff';
const BETA = '#6f9fe0';
const HEAD_COLORS = ['#ffb86b', '#ffa04a'];
const LINKER_DIM = new THREE.Color('#b99a62');
const LINKER_BRIGHT = new THREE.Color('#fff2a8');
const DYNEIN = '#a58bff';

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0d1024');
  const rng = new Rng('closeup:vesicles-motors');
  const noise = new Simplex3('closeup:vesicles-motors:drift');
  const q = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);

  // ── Frames ────────────────────────────────────────────────────────────
  const X = new THREE.Vector3(1, 0, 0);
  /** Radial (outward) direction of protofilament pf in the world. */
  const radialOf = (pf: number, target = new THREE.Vector3()) => {
    const a = PSI - pf * PF_ANGLE;
    return target.set(0, Math.cos(a), Math.sin(a));
  };
  const up = radialOf(0); // kinesin's "up"
  const side = new THREE.Vector3().crossVectors(X, up).normalize(); // toward the viewer
  const dyneinOut = radialOf(DYNEIN_PF);
  const dyneinFace = new THREE.Vector3().crossVectors(X, dyneinOut).normalize();

  // ── Microtubule (kit lattice: 13 protofilaments, 25 nm, α pale / β darker) ─
  const leftDimers = byQuality(q, { low: 20, medium: 26, high: 26 });
  const x0 = -STEP - STEP * leftDimers; // lattice origin (minus side) in world x
  const yClip = X_TIP - x0; // plus-end tip in lattice coordinates
  const dimersPerPf = Math.ceil((yClip + 15) / STEP);
  const monomersPerPf = dimersPerPf * 2;
  const pfCount = MICROTUBULE.protofilaments;
  const instanceCount = pfCount * monomersPerPf;
  const placer = new TubulinPlacer();
  const baseY = new Float32Array(instanceCount);
  const baseX = new Float32Array(instanceCount);
  const baseZ = new Float32Array(instanceCount);
  const baseQ = new Float32Array(instanceCount * 4);
  const pfOf = new Uint8Array(instanceCount);
  const tipJitter = Array.from({ length: pfCount }, () => rng.range(-5, 2.5));
  const tmpM = new THREE.Matrix4();
  const tmpP = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const latticePlacements: Placement[] = [];
  for (let pf = 0; pf < pfCount; pf++) {
    const shade = rng.range(-0.025, 0.025);
    for (let m = 0; m < monomersPerPf; m++) {
      const i = pf * monomersPerPf + m;
      placer.matrix(pf, m, 0, Infinity, 1, tmpM);
      tmpM.decompose(tmpP, tmpQ, tmpS);
      baseX[i] = tmpP.x;
      baseY[i] = tmpP.y;
      baseZ[i] = tmpP.z;
      tmpQ.toArray(baseQ, i * 4);
      pfOf[i] = pf;
      latticePlacements.push({ position: tmpP.clone(), quaternion: tmpQ.clone(), color: new THREE.Color(m % 2 === 0 ? ALPHA : BETA).offsetHSL(0, 0, shade) });
    }
  }
  const tubulin = tubulinGeometry(q, 'kinesin-tubulin');
  const tubulinMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(tubulinMaterial, 0.15, 'kinTubulin');
  const lattice = instanced(tubulin, tubulinMaterial, latticePlacements);
  lattice.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const mt = new THREE.Group();
  mt.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up, X, new THREE.Vector3(0, Math.sin(PSI), -Math.cos(PSI))));
  mt.position.set(x0, 0, 0);
  mt.add(lattice);
  root.add(mt);

  const setLattice = (offset: number) => {
    for (let i = 0; i < instanceCount; i++) {
      const y = baseY[i] - offset;
      // Plus end: monomers appear at the (ragged) tip as the lattice slides in;
      // minus side: they shrink away far off to the left.
      const scale = ramp(y, yClip + tipJitter[pfOf[i]], yClip + tipJitter[pfOf[i]] - 4.6) * ramp(y, 1.5, 9);
      if (scale < 0.02) {
        lattice.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
        continue;
      }
      tmpP.set(baseX[i], y, baseZ[i]);
      tmpQ.fromArray(baseQ, i * 4);
      tmpS.setScalar(scale);
      lattice.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
    }
    lattice.instanceMatrix.needsUpdate = true;
  };

  // ── Kinesin ───────────────────────────────────────────────────────────
  // Rear head's site at the start of a step sits at x = −4.05 (a dimer centre of protofilament 0).
  const xRear = -STEP / 2;
  const headGeometry = noisyEllipsoid(new THREE.Vector3(3.5, 2.05, 2.05), q === 'low' ? 2 : 3, new Simplex3('kinesin-head'), 0.13, 1.2, 3);
  const headMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(headMaterial, 0.22, 'kinHead');
  const heads = instanced(headGeometry, headMaterial, HEAD_COLORS.map((color) => ({ position: new THREE.Vector3(), color })));
  root.add(heads);

  // Thin strands (neck linkers here; dynein stalks and tails below) share a unit segment.
  const segmentGeometry = new THREE.CapsuleGeometry(0.5, 1, 3, 8);
  segmentGeometry.scale(1, 0.5, 1);
  const linkerMaterial = instancedMaterial({ roughness: 0.4 });
  addInstanceGlow(linkerMaterial, 0.6, 'kinLinker');
  const linkers = instanced(
    segmentGeometry,
    linkerMaterial,
    Array.from({ length: 4 }, () => ({ position: new THREE.Vector3(), color: LINKER_DIM })),
  );
  root.add(linkers);

  // Coiled-coil stalk (kit), built hanging down from its top at the vesicle and turned each frame to meet the neck.
  const stalkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.9, -14, 0.4),
    new THREE.Vector3(-0.7, -29, -0.5),
    new THREE.Vector3(0.8, -44, 0.3),
    new THREE.Vector3(0, -STALK_LEN, 0),
  ]);
  const stalkGeometry = coiledCoilGeometry(stalkCurve, { coilRadius: 0.55, strandRadius: 0.55, pitch: 14, radialSegments: q === 'low' ? 5 : 6 });
  const stalkMaterial = moleculeMaterial('#ffd59a', { roughness: 0.45, emissiveIntensity: 0.2 });
  const stalk = new THREE.Mesh(stalkGeometry, stalkMaterial);
  const stalkPivot = new THREE.Group();
  stalkPivot.add(stalk);
  root.add(stalkPivot);

  // Neck junction knob + the two light chains gripping the vesicle.
  const knobGeometry = noisyEllipsoid(new THREE.Vector3(1, 1, 1), 2, new Simplex3('kinesin-knob'), 0.2, 1.5, 2);
  const kinesinBits = instanced(knobGeometry, moleculeMaterial('#ffd59a', { roughness: 0.5 }), [
    { position: new THREE.Vector3(), scale: 1.2 },
  ]);
  root.add(kinesinBits);

  // ── Vesicle (80 nm, pink, translucent, slightly lumpy) ────────────────
  const vesicle = new THREE.Group();
  const vesicleHome = new THREE.Vector3(-3, HEAD_R + NECK_H + STALK_LEN + VESICLE_R + 3, 0);
  vesicle.position.copy(vesicleHome);
  root.add(vesicle);
  const lumpySphere = (radius: number, seed: string, amplitude: number, segments: number) => {
    const g = new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.66));
    const n = new Simplex3(seed);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const d = n.fbm(v.x * 0.05, v.y * 0.05, v.z * 0.05, 3) * amplitude;
      v.multiplyScalar(1 + d / v.length());
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    // Weld the seam so the translucent membrane shades without a visible line.
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const welded = mergeVertices(g);
    g.dispose();
    welded.computeVertexNormals();
    return welded;
  };
  const sphereSegments = byQuality(q, { low: 44, medium: 56, high: 72 });
  const vesicleInner = new THREE.Mesh(
    lumpySphere(VESICLE_R - 4, 'vesicle', 1.6, sphereSegments),
    membraneMaterial('#c94a72', { opacity: 0.42, side: THREE.BackSide, rim: 0.25 }),
  );
  vesicleInner.renderOrder = 1;
  const vesicleOuter = new THREE.Mesh(lumpySphere(VESICLE_R, 'vesicle', 1.6, sphereSegments), membraneMaterial('#ff6f91', { opacity: 0.5, rim: 0.8 }));
  vesicleOuter.renderOrder = 2;
  vesicle.add(vesicleInner, vesicleOuter);
  // Cargo proteins inside, seen through the membrane.
  const cargoShapes = noisyEllipsoid(new THREE.Vector3(1, 1, 1), 1, new Simplex3('vesicle-cargo'), 0.25, 1.5, 2);
  const cargoPlacements: Placement[] = [];
  const cargoCount = byQuality(q, { low: 14, medium: 20, high: 26 });
  for (let i = 0; i < cargoCount; i++) {
    const p = rng.inBall().multiplyScalar(VESICLE_R - 12);
    cargoPlacements.push({
      position: p,
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 6), rng.range(0, 6), 0)),
      scale: new THREE.Vector3(rng.range(2.5, 4.5), rng.range(2.2, 3.6), rng.range(2.2, 3.6)),
      color: new THREE.Color(rng.pick(['#ffe2d2', '#ffd0dc', '#f6c6ff', '#ffe9b8'])),
    });
  }
  const cargoMaterial = instancedMaterial({ roughness: 0.6 });
  addInstanceGlow(cargoMaterial, 0.2, 'kinCargo');
  vesicle.add(instanced(cargoShapes, cargoMaterial, cargoPlacements));
  // Light chains (part of kinesin-1) holding the vesicle membrane.
  const lightChainMaterial = moleculeMaterial('#ffc983', { roughness: 0.5 });
  const lightChains = instanced(knobGeometry, lightChainMaterial, [
    { position: new THREE.Vector3(-3.2, -VESICLE_R - 1.4, 1.2), scale: new THREE.Vector3(2.6, 2.0, 2.0) },
    { position: new THREE.Vector3(3.0, -VESICLE_R - 1.2, -0.8), scale: new THREE.Vector3(2.4, 2.0, 2.0) },
  ]);
  vesicle.add(lightChains);
  const stalkTopLocal = new THREE.Vector3(0, -VESICLE_R - 3, 0);

  // ── ATP sparks: [0] arriving ATP, [1] bound nucleotide, [2] ADP + Pi leaving ─
  const atp = sparks(3, '#fff3b0', 2.8, ctx.pointScale);
  atp.points.renderOrder = 5;
  root.add(atp.points);

  // ── "Toward the plus end" cue: three chevrons above the tube near the tip ─
  const chevronParts: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const arm = new THREE.BoxGeometry(5.2, 1.1, 0.6);
    arm.translate(-2.3, 0, 0);
    arm.rotateZ(sign * THREE.MathUtils.degToRad(40));
    arm.deleteAttribute('uv');
    chevronParts.push(arm);
  }
  const chevronGeometry = mergeGeometries(chevronParts)!;
  chevronParts.forEach((g) => g.dispose());
  const chevronMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const chevrons = instanced(
    chevronGeometry,
    chevronMaterial,
    [44, 55, 66].map((x) => ({ position: new THREE.Vector3(x, 21, 7), color: '#9fd8ff' })),
  );
  root.add(chevrons);
  const chevronColor = new THREE.Color();
  const chevronBase = new THREE.Color('#9fd8ff');

  // ── Dynein (purple) under the far side, walking toward the minus end ──
  const dynein = new THREE.Group();
  root.add(dynein);
  const ringParts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    // Six AAA+ domains packed into a ring ≈ 13–14 nm across, with a small central pore.
    const blob = noisyEllipsoid(new THREE.Vector3(2.75, 2.7, 2.3), 1, new Simplex3(`dynein-aaa${k}`), 0.14, 1.4, 2);
    blob.rotateZ(a);
    blob.translate(Math.cos(a) * 4.1, Math.sin(a) * 4.1, 0);
    ringParts.push(blob);
  }
  const linkerBar = new THREE.CapsuleGeometry(0.9, 8, 2, 6);
  linkerBar.rotateZ(Math.PI / 2 + 0.5);
  linkerBar.translate(0, 0, 2.1);
  linkerBar.deleteAttribute('uv');
  ringParts.push(linkerBar);
  const ringGeometry = mergeGeometries(ringParts)!;
  ringParts.forEach((g) => g.dispose());
  const dyneinMaterial = instancedMaterial({ roughness: 0.5, transparent: true });
  addInstanceGlow(dyneinMaterial, 0.22, 'dynein');
  const dyneinColor = new THREE.Color(DYNEIN);
  const rings = instanced(ringGeometry, dyneinMaterial, [
    { position: new THREE.Vector3(), color: dyneinColor },
    { position: new THREE.Vector3(), color: dyneinColor.clone().offsetHSL(0, 0, -0.04) },
  ]);
  // Segments: 2 stalks, 2 tails, 1 adaptor (dynactin side) to the cargo.
  const dyneinSegments = instanced(
    segmentGeometry,
    dyneinMaterial,
    Array.from({ length: 5 }, (_, i) => ({ position: new THREE.Vector3(), color: i < 2 ? '#c7b6ff' : '#9479f0' })),
  );
  // Blobs: 2 microtubule-binding domains, the tail junction and the dynactin/adaptor body.
  const dyneinBlobs = instanced(
    knobGeometry,
    dyneinMaterial,
    Array.from({ length: 4 }, (_, i) => ({ position: new THREE.Vector3(), color: i < 2 ? '#d2c4ff' : '#8a6fe6' })),
  );
  const dyneinCargo = new THREE.Group();
  const dyneinCargoInner = new THREE.Mesh(
    lumpySphere(DYNEIN_CARGO_R - 3.5, 'dynein-cargo', 1.1, byQuality(q, { low: 30, medium: 40, high: 48 })),
    membraneMaterial('#a8577e', { opacity: 0.3, side: THREE.BackSide, rim: 0.2 }),
  );
  dyneinCargoInner.renderOrder = 1;
  const dyneinCargoOuter = new THREE.Mesh(
    lumpySphere(DYNEIN_CARGO_R, 'dynein-cargo', 1.1, byQuality(q, { low: 30, medium: 40, high: 48 })),
    membraneMaterial('#e5739b', { opacity: 0.4, rim: 0.7 }),
  );
  dyneinCargoOuter.renderOrder = 2;
  dyneinCargo.add(dyneinCargoInner, dyneinCargoOuter);
  dynein.add(rings, dyneinSegments, dyneinBlobs, dyneinCargo);
  const cargoMaterials = [dyneinCargoInner.material, dyneinCargoOuter.material] as THREE.MeshStandardMaterial[];
  const cargoOpacity = cargoMaterials.map((m) => m.opacity);

  // ── Per-frame scratch ─────────────────────────────────────────────────
  const headPos = [new THREE.Vector3(), new THREE.Vector3()];
  const neck = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const baseHeadQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, up, side));
  const arcDir = up.clone().multiplyScalar(0.78).addScaledVector(side, 0.62).normalize();
  const arcAxis = new THREE.Vector3().crossVectors(X, arcDir).normalize();

  // Faint trail of the swing: a semicircle over the bound head, revealed as the rear head travels it.
  const TRAIL_SEGMENTS = 40;
  const TRAIL_RADIAL = 5;
  const trailPoints: THREE.Vector3[] = [];
  for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
    const theta = (Math.PI * i) / TRAIL_SEGMENTS;
    trailPoints.push(new THREE.Vector3().addScaledVector(X, -STEP * Math.cos(theta)).addScaledVector(arcDir, STEP * Math.sin(theta)));
  }
  const trailGeometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trailPoints), TRAIL_SEGMENTS, 0.32, TRAIL_RADIAL, false);
  const trailMaterial = new THREE.MeshBasicMaterial({ color: '#ffd08a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const trail = new THREE.Mesh(trailGeometry, trailMaterial);
  trail.renderOrder = 4;
  root.add(trail);
  const downY = new THREE.Vector3(0, -1, 0);
  const stalkTop = new THREE.Vector3();
  const linkerColor = new THREE.Color();
  const pocket = (h: number, target: THREE.Vector3) => target.copy(headPos[h]).addScaledVector(up, 1.1).addScaledVector(side, 1.7);
  const ringBasis = new THREE.Matrix4();
  const ringX = new THREE.Vector3();
  const ringY = new THREE.Vector3();
  const ringCentres = [new THREE.Vector3(), new THREE.Vector3()];
  const mtbd = [new THREE.Vector3(), new THREE.Vector3()];
  const junction = new THREE.Vector3();
  const cargoCentre = new THREE.Vector3();
  let dyneinAlpha = 0;
  let clock = 0;

  /** Lattice slide (fraction of one dimer) during a step: half steady, half with the swing. */
  const slideOf = (u: number) => 0.5 * u + 0.5 * ramp(u, ATP_BIND, SWING_END);

  const setHead = (h: number, position: THREE.Vector3, quaternion: THREE.Quaternion) => {
    headPos[h].copy(position);
    heads.setMatrixAt(h, tmpM.compose(position, quaternion, one));
  };

  // ── Label anchors (no allocation per call) ────────────────────────────
  const anchors = {
    heads: new THREE.Vector3(),
    linker: new THREE.Vector3(),
    stalk: new THREE.Vector3(),
    kinesin: new THREE.Vector3(),
    vesicle: new THREE.Vector3(),
    dynein: new THREE.Vector3(),
  };
  const atpAnchor = new THREE.Vector3(STEP / 2 - STEP * slideOf(ATP_BIND), 0, 0).addScaledVector(up, HEAD_R + 1.1).addScaledVector(side, 1.7);
  const trackAnchor = new THREE.Vector3(-46, -2.5, 12.3);
  const plusAnchor = new THREE.Vector3(X_TIP - 6, 3, 11.8);

  const update = (t: number, calm: boolean) => {
    clock = t;
    const amp = calm ? 0.3 : 1;
    const k = Math.floor(t / STEP_TIME);
    const u = t / STEP_TIME - k;
    const slide = slideOf(u);
    const offset = slide * STEP;
    const neckAdvance = ramp(u, ATP_BIND, SWING_END);
    setLattice(offset);

    // Heads: the bound (front) head rides the lattice; the rear head swings over it to the site 16 nm ahead.
    const swinging = mod(k, 2);
    const bound = 1 - swinging;
    v1.set(xRear + STEP - offset, 0, 0).addScaledVector(up, HEAD_R); // bound head
    setHead(bound, v1, baseHeadQuat);
    const lift = ramp(u, 0.2, SWING_START) * (1 - ramp(u, SWING_END, 0.88)) * 0.9;
    if (u < SWING_START) {
      v2.copy(v1).addScaledVector(X, -STEP).addScaledVector(up, lift);
      setHead(swinging, v2, baseHeadQuat);
    } else if (u > SWING_END) {
      v2.copy(v1).addScaledVector(X, STEP).addScaledVector(up, lift);
      setHead(swinging, v2, baseHeadQuat);
    } else {
      const s = easeInOut((u - SWING_START) / (SWING_END - SWING_START));
      const theta = Math.PI * s;
      v2.copy(v1)
        .addScaledVector(X, -STEP * Math.cos(theta))
        .addScaledVector(arcDir, STEP * Math.sin(theta))
        .addScaledVector(up, lift);
      qa.setFromAxisAngle(arcAxis, -0.55 * Math.sin(theta)).multiply(baseHeadQuat);
      setHead(swinging, v2, qa);
    }
    heads.instanceMatrix.needsUpdate = true;

    // Swing trail: drawn up to the swinging head, then fading after it lands.
    const swing = easeInOut((u - SWING_START) / (SWING_END - SWING_START));
    trail.position.copy(headPos[bound]);
    trailGeometry.setDrawRange(0, Math.round(swing * TRAIL_SEGMENTS) * TRAIL_RADIAL * 6);
    trailMaterial.opacity = u < SWING_START ? 0 : (calm ? 0.4 : 0.7) * (1 - ramp(u, SWING_END, 0.98));

    // Neck junction: between the heads, carried forward 8 nm as the front linker docks.
    neck.set(STEP * (neckAdvance - slide), 0, 0).addScaledVector(up, HEAD_R + NECK_H);
    kinesinBits.setMatrixAt(0, tmpM.compose(neck, qa.identity(), tmpS.setScalar(1.15)));
    kinesinBits.instanceMatrix.needsUpdate = true;

    // Neck linkers. Docking "zips" a linker forward along its head's top as the neck is pulled ahead
    // (bright when docked): the front head's docks after ATP binds; the rear head's lets go as it detaches.
    const release = 1 - ramp(u, 0.22, SWING_START + 0.04);
    for (let h = 0; h < 2; h++) {
      const origin = v1.copy(headPos[h]).addScaledVector(up, 1.9).addScaledVector(X, -1.4);
      const ahead = neck.x - headPos[h].x;
      let along = THREE.MathUtils.clamp((ahead + 0.6) / 4.6, 0, 1);
      const zipped = v2.copy(origin).addScaledVector(X, 4.6 * along).addScaledVector(up, 0.15 * along);
      const loose = v3.copy(origin).lerp(neck, 0.5).addScaledVector(up, 0.5);
      if (h === swinging) {
        loose.lerp(zipped, release);
        along *= release;
      } else {
        loose.copy(zipped);
      }
      linkers.setMatrixAt(h * 2, segmentMatrix(origin, loose, 1.15, tmpM));
      linkers.setMatrixAt(h * 2 + 1, segmentMatrix(loose, neck, 1.15, tmpM));
      linkerColor.copy(LINKER_DIM).lerp(LINKER_BRIGHT, along);
      linkers.setColorAt(h * 2, linkerColor);
      linkers.setColorAt(h * 2 + 1, linkerColor);
    }
    linkers.instanceMatrix.needsUpdate = true;
    if (linkers.instanceColor) linkers.instanceColor.needsUpdate = true;

    // Vesicle drifts a little (thermal motion); the stalk turns to join it to the neck.
    vesicle.position.set(
      vesicleHome.x + noise.noise(t * 0.35, 0, 0) * 0.8 * amp,
      vesicleHome.y + noise.noise(t * 0.35, 3, 0) * 0.6 * amp,
      vesicleHome.z + noise.noise(t * 0.35, 6, 0) * 0.8 * amp,
    );
    vesicle.rotation.set(noise.noise(t * 0.2, 9, 0) * 0.05 * amp, t * 0.02, noise.noise(t * 0.2, 12, 0) * 0.05 * amp);
    stalkTop.copy(vesicle.position).add(stalkTopLocal);
    stalkPivot.position.copy(stalkTop);
    v1.subVectors(neck, stalkTop);
    const length = v1.length();
    stalkPivot.quaternion.setFromUnitVectors(downY, v1.multiplyScalar(1 / length));
    stalkPivot.scale.set(1, length / STALK_LEN, 1);

    // ATP: arrives at the front head, binds (spark), is split while that head trails, and leaves as ADP + Pi.
    pocket(bound, v1);
    const arrive = easeInOut((u - 0.16) / (ATP_BIND - 0.16));
    v2.copy(v1).addScaledVector(up, 6 * (1 - arrive)).addScaledVector(side, 5 * (1 - arrive)).addScaledVector(X, 2.5 * (1 - arrive));
    v2.toArray(atp.positions, 0);
    atp.alphas[0] = u >= 0.16 && u < ATP_BIND ? ramp(u, 0.16, 0.21) * 0.9 : 0;
    if (u >= ATP_BIND) {
      v1.toArray(atp.positions, 3);
      const flash = calm ? 0 : 0.9 * (1 - ramp(u, ATP_BIND, ATP_BIND + 0.12));
      atp.alphas[1] = 0.85 + flash;
    } else {
      pocket(swinging, v3);
      v3.toArray(atp.positions, 3);
      atp.alphas[1] = u < 0.18 ? 0.55 : 0;
    }
    if (u >= 0.18 && u < 0.62) {
      const away = (u - 0.18) / 0.44;
      pocket(swinging, v3);
      // Leaving products drift up and back from where the trailing head released them.
      v3.addScaledVector(up, 3 + away * 9).addScaledVector(side, -away * 4).addScaledVector(X, -away * 6);
      v3.toArray(atp.positions, 6);
      atp.alphas[2] = 0.5 * (1 - away);
    } else {
      atp.alphas[2] = 0;
    }
    atp.commit();

    // Chevrons pointing to the plus end: a light running toward the tip.
    for (let i = 0; i < 3; i++) {
      const pulse = calm ? 0.65 : 0.3 + 0.7 * Math.pow(Math.max(0, Math.cos(Math.PI * 2 * (t * 0.7 - i * 0.16))), 4);
      chevrons.setColorAt(i, chevronColor.copy(chevronBase).multiplyScalar(pulse));
    }
    if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;

    updateDynein(t, k, slide, amp);

    // Label anchors.
    // Both heads: their midpoint on the front faces moves smoothly (a moving head would jump 16 nm per step).
    anchors.heads.addVectors(headPos[0], headPos[1]).multiplyScalar(0.5).addScaledVector(side, 2.1).addScaledVector(up, -0.7);
    anchors.linker.copy(neck).addScaledVector(up, -1.3).addScaledVector(side, 0.7);
    stalk.updateWorldMatrix(true, false);
    stalk.localToWorld(anchors.stalk.copy(stalkCurve.points[2]));
    stalk.localToWorld(anchors.kinesin.copy(stalkCurve.points[1]));
    anchors.vesicle.set(-0.62, 0.32, 0.72).normalize().multiplyScalar(VESICLE_R).add(vesicle.position);
  };

  const updateDynein = (t: number, kinesinStep: number, slide: number, amp: number) => {
    const qd = Math.floor(t / DYNEIN_STEP_TIME);
    const v = t / DYNEIN_STEP_TIME - qd;
    const e = easeInOut((v - 0.45) / 0.4);
    // Sites (in dimers, toward the minus end = decreasing): heads alternate 16 nm steps.
    const leadDone = -2 * Math.floor((qd + 1) / 2);
    const trailDone = 2 - 2 * Math.floor(qd / 2);
    const leadMoving = mod(qd, 2) === 0;
    const lead = leadMoving ? leadDone - 2 * e : leadDone;
    const trail = leadMoving ? trailDone : trailDone - 2 * e;
    const lift = Math.sin(Math.PI * e) * 3.5;
    const latticeTravel = STEP * (kinesinStep + slide);
    // Dimer centre `leftDimers + s` of the dynein's protofilament (which is staggered along the axis).
    const siteX = (s: number) => x0 + DYNEIN_PF * (MICROTUBULE.helixRise / pfCount) + STEP * (leftDimers + s) + STEP / 2 - latticeTravel;
    // Keep the motor on screen: wrap by a whole number of dimers while it is faded out.
    const raw = siteX((lead + trail) / 2);
    const wrapped = DYNEIN_LEFT + mod(raw - DYNEIN_LEFT, DYNEIN_WRAP);
    const shift = wrapped - raw;
    dyneinAlpha = ramp(wrapped, DYNEIN_LEFT, DYNEIN_LEFT + 30) * ramp(wrapped, DYNEIN_LEFT + DYNEIN_WRAP, DYNEIN_LEFT + DYNEIN_WRAP - 28);
    dynein.visible = dyneinAlpha > 0.01;
    if (!dynein.visible) return;
    dyneinMaterial.opacity = dyneinAlpha;
    for (let i = 0; i < cargoMaterials.length; i++) cargoMaterials[i].opacity = cargoOpacity[i] * dyneinAlpha;

    const stalkDir = v3.copy(dyneinOut).multiplyScalar(Math.cos(0.68)).addScaledVector(X, Math.sin(0.68)).normalize();
    const sites = [lead, trail];
    const lifts = [leadMoving ? lift : 0, leadMoving ? 0 : lift];
    for (let h = 0; h < 2; h++) {
      mtbd[h].set(siteX(sites[h]) + shift, 0, 0).addScaledVector(dyneinOut, 13.6 + lifts[h]);
      v1.copy(mtbd[h]).addScaledVector(stalkDir, 15.5); // stalk meets the ring
      ringCentres[h].copy(v1).addScaledVector(stalkDir, 6.2);
      dyneinSegments.setMatrixAt(h, segmentMatrix(mtbd[h], v1, 1.15, tmpM));
      dyneinBlobs.setMatrixAt(h, tmpM.compose(mtbd[h], qa.identity(), tmpS.set(1.9, 1.6, 1.6)));
      ringY.copy(stalkDir).negate();
      ringX.crossVectors(ringY, dyneinFace).normalize();
      ringBasis.makeBasis(ringX, ringY, dyneinFace);
      qa.setFromRotationMatrix(ringBasis);
      rings.setMatrixAt(h, tmpM.compose(ringCentres[h], qa, one));
    }
    junction.copy(ringCentres[0]).add(ringCentres[1]).multiplyScalar(0.5).addScaledVector(dyneinOut, 9).addScaledVector(X, 8).addScaledVector(dyneinFace, 7);
    junction.y += noise.noise(t * 0.4, 20, 0) * 0.6 * amp;
    for (let h = 0; h < 2; h++) dyneinSegments.setMatrixAt(2 + h, segmentMatrix(ringCentres[h], junction, 1.6, tmpM));
    dyneinBlobs.setMatrixAt(2, tmpM.compose(junction, qa.identity(), tmpS.setScalar(2.6)));
    v1.copy(dyneinOut).multiplyScalar(0.35).addScaledVector(X, 0.55).addScaledVector(dyneinFace, 0.75).normalize();
    v2.copy(junction).addScaledVector(v1, 7); // dynactin / adaptor body
    dyneinBlobs.setMatrixAt(3, tmpM.compose(v2, qa.setFromUnitVectors(X, v1), tmpS.set(5.5, 2.6, 2.6)));
    dyneinSegments.setMatrixAt(4, segmentMatrix(junction, v2, 1.8, tmpM));
    cargoCentre.copy(v2).addScaledVector(v1, DYNEIN_CARGO_R + 4.5);
    dyneinCargo.position.copy(cargoCentre);
    rings.instanceMatrix.needsUpdate = true;
    dyneinSegments.instanceMatrix.needsUpdate = true;
    dyneinBlobs.instanceMatrix.needsUpdate = true;
    anchors.dynein.copy(ringCentres[0]).addScaledVector(dyneinFace, -2.5);
  };

  update(0, false);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(14, 70, 0),
        radius: 98, // Room for the whole vesicle above the kinesin, below the top bar.
        direction: new THREE.Vector3(0.12, 0.3, 1).normalize(),
        labels: [
          { part: 'kinesin', anchor: () => anchors.kinesin },
          { part: 'motor-heads', anchor: () => anchors.heads },
          { part: 'neck-linker', anchor: () => anchors.linker },
          { textKey: 'closeupCaptions.atp', anchor: () => atpAnchor, visible: () => mod(clock, 4) < 1.7 },
          { part: 'stalk', anchor: () => anchors.stalk },
          { part: 'vesicle', anchor: () => anchors.vesicle },
          { part: 'track', anchor: () => trackAnchor },
          { part: 'plus-end', anchor: () => plusAnchor },
          { part: 'dynein', anchor: () => anchors.dynein, visible: () => dyneinAlpha > 0.6 },
        ],
      },
    ],
    setView() {},
    update(_dt, time, calm) {
      update(time, calm);
    },
    dispose() {
      atp.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
