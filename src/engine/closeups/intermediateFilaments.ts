import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { Simplex3 } from '../core/noise';
import { mergeGeometries, noisyEllipsoid } from '../core/geometry';
import { createCloseupScene, disposeScene, easeInOut } from './common';
import { addInstanceGlow, coiledCoilGeometry, instanced, instancedMaterial } from './kit';
import { mod, ramp } from './cytoskeletonParts';
import type { CloseupFactory } from './types';

/**
 * Rope-like assembly of an intermediate filament (vimentin, 1 unit = 1 nm),
 * left → right: a coiled-coil dimer forms from two 46 nm α-helical rods;
 * two dimers pair antiparallel and staggered into a ~62 nm tetramer; eight
 * tetramers gather into a ~16 nm-wide unit-length filament (ULF); a ULF
 * docks onto the end of the mature filament and the joint compacts to
 * ~10 nm; finally the 250 nm filament is pulled, stretches to 1.8× (and
 * thins) without breaking, and relaxes. One 22 s loop. The stages stay at
 * their true sizes and spacing, but the whole assembly line slides so the
 * stage being assembled sits in the middle of the view (the camera
 * "follows" the lesson); each stage resets while the view pans to it.
 */

const LOOP = 22;
const ROD = 46;
const COIL_PITCH = 14;
const SHADE_A = new THREE.Color('#e8dfa0');
const SHADE_B = new THREE.Color('#d4c27a');
const HEAD = new THREE.Color('#f6efc8');
const TAIL = new THREE.Color('#c4ad62');
/** Antiparallel stagger of the two dimers in a tetramer (N-terminal halves overlap). */
const STAGGER = 16;
/** Radius of the ring of eight tetramers in a ULF (≈16 nm wide overall). */
const ULF_RADIUS = 5.6;
/** Radius they compact to in the mature filament (≈10 nm wide). */
const COMPACT_RADIUS = 3.2;
const TETRAMER_HALF_WIDTH = 1.05;

// Stage centres along x.
const X_DIMER = -240;
const X_TETRAMER = -142;
const X_ULF = -36;
const UNIT = 62; // one ULF length in the filament
const X_FILAMENT = 38; // left end of the mature filament once the new ULF has docked
const FILAMENT_UNITS = 4;
const X_DOCK = X_FILAMENT + UNIT / 2; // where the newly arriving ULF joins
const FILAMENT_LENGTH = UNIT * FILAMENT_UNITS;
const PULL_FOCUS = X_FILAMENT + FILAMENT_LENGTH - 50; // the pulled end region, at rest
/** While pulled, the view follows the end at this fraction of its speed, so the end still visibly moves outward. */
const PULL_FOLLOW = 0.85;

/**
 * Where the view is centred (assembly-line x) over the loop: it holds on each
 * stage while it assembles and eases to the next one in between.
 */
const FOCUS: ReadonlyArray<readonly [number, number]> = [
  [0, PULL_FOCUS],
  [2.0, X_DIMER],
  [5.4, X_DIMER],
  [6.2, X_TETRAMER],
  [8.8, X_TETRAMER],
  [9.6, X_ULF],
  [12.8, X_ULF],
  [13.6, X_DOCK],
  [16.4, X_DOCK],
  [17.4, PULL_FOCUS],
  [LOOP, PULL_FOCUS],
];
const focusAt = (t: number) => {
  for (let i = 1; i < FOCUS.length; i++) {
    if (t <= FOCUS[i][0]) {
      const t0 = FOCUS[i - 1][0];
      const x0 = FOCUS[i - 1][1];
      return x0 + (FOCUS[i][1] - x0) * easeInOut((t - t0) / Math.max(1e-6, FOCUS[i][0] - t0));
    }
  }
  return PULL_FOCUS;
};
/** Labels show while their stage is within this distance of the view centre. */
const IN_VIEW = 75;

/** Two strands' centre lines for a straight pair (apart or touching) with the kit coiled coil's sampling. */
function strandTubes(length: number, offset: number, strandRadius: number, radial: number): THREE.BufferGeometry {
  const samples = Math.max(16, Math.ceil(length / 0.8));
  const parts: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const points: THREE.Vector3[] = [];
    for (let s = 0; s <= samples; s++) points.push(new THREE.Vector3((s / samples) * length - length / 2, sign * offset, 0));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), samples * 2, strandRadius, radial, false));
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

/** The kit's coiled coil (two strands, merged) along x, centred, coloured one shade per strand. */
function coiledRod(radial: number): THREE.BufferGeometry {
  const curve = new THREE.LineCurve3(new THREE.Vector3(-ROD / 2, 0, 0), new THREE.Vector3(ROD / 2, 0, 0));
  const g = coiledCoilGeometry(curve, { coilRadius: 0.5, strandRadius: 0.5, pitch: COIL_PITCH, radialSegments: radial });
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) (i < count / 2 ? SHADE_A : SHADE_B).toArray(colors, i * 3);
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

function blob(radius: number, seed: string, color: THREE.Color, detail: number): THREE.BufferGeometry {
  const g = noisyEllipsoid(new THREE.Vector3(radius * 1.15, radius, radius * 0.95), detail, new Simplex3(seed), 0.25, 1.6, 2);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i++) color.toArray(colors, i * 3);
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

/** A complete dimer: coiled-coil rod plus the two N-terminal heads (left) and C-terminal tails (right). */
function dimerGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const radial = quality === 'low' ? 4 : 6;
  const detail = quality === 'high' ? 2 : 1;
  const rod = coiledRod(radial);
  rod.deleteAttribute('uv');
  const parts = [rod];
  for (const [x, y, r, color, seed] of [
    [-ROD / 2 - 1.7, 0.75, 1.5, HEAD, 'h0'],
    [-ROD / 2 - 1.4, -0.85, 1.4, HEAD, 'h1'],
    [ROD / 2 + 1.4, 0.6, 1.2, TAIL, 't0'],
    [ROD / 2 + 1.2, -0.7, 1.15, TAIL, 't1'],
  ] as const) {
    const b = blob(r, `if-${seed}`, color, detail);
    b.translate(x, y, 0);
    parts.push(b);
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

/**
 * The mature filament: four protofibrils wound around each other (long
 * pitch), each of two intertwined strands — a fibrous rope ≈10 nm wide.
 * The helix phase depends on x only, so separately built pieces line up.
 */
function ropeGeometry(x0: number, x1: number, quality: QualityLevel): THREE.BufferGeometry {
  const radial = quality === 'low' ? 5 : 7;
  const perNm = quality === 'high' ? 1.4 : 0.9;
  const segments = Math.max(8, Math.ceil((x1 - x0) * perNm));
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < 2; j++) {
      const points: THREE.Vector3[] = [];
      for (let s = 0; s <= segments; s++) {
        const x = x0 + ((x1 - x0) * s) / segments;
        const a = (x / 96) * Math.PI * 2 + (k * Math.PI) / 2;
        const b = (x / 26) * Math.PI * 2 + j * Math.PI + k;
        points.push(new THREE.Vector3(x, Math.cos(a) * 2.75 + Math.cos(b) * 1.0, Math.sin(a) * 2.75 + Math.sin(b) * 1.0));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, 1.15, radial, false);
      tube.deleteAttribute('uv');
      const colors = new Float32Array(tube.attributes.position.count * 3);
      for (let i = 0; i < tube.attributes.position.count; i++) (j === 0 ? SHADE_A : SHADE_B).toArray(colors, i * 3);
      tube.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      parts.push(tube);
    }
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#141422');
  const q = ctx.quality;
  const noise = new Simplex3('closeup:intermediate-filaments');
  const root = new THREE.Group();
  scene.add(root);

  const vertexMaterial = (glow: number, key: string) => {
    const m = instancedMaterial({ vertexColors: true, roughness: 0.5 });
    addInstanceGlow(m, glow, key);
    return m;
  };

  // ── Stage 1: two monomers coil into a dimer (morph: apart → side by side → coiled coil) ─
  const radial = q === 'low' ? 4 : 6;
  const pair = strandTubes(ROD, 7, 0.5, radial);
  pair.deleteAttribute('uv');
  const together = strandTubes(ROD, 0.55, 0.5, radial);
  const coiled = coiledRod(radial);
  pair.morphAttributes.position = [together.attributes.position, coiled.attributes.position];
  pair.morphAttributes.normal = [together.attributes.normal, coiled.attributes.normal];
  pair.setAttribute('color', coiled.attributes.color);
  const monomerMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: '#3a3418' });
  const monomers = new THREE.Mesh(pair, monomerMaterial);
  monomers.morphTargetInfluences = [0, 0];
  monomers.position.set(X_DIMER, 0, 0);
  root.add(monomers);
  // Head and tail domains of the two monomers (they follow the rods).
  const endMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(endMaterial, 0.2, 'ifEnds');
  const endShape = noisyEllipsoid(new THREE.Vector3(1.6, 1.35, 1.3), q === 'high' ? 2 : 1, new Simplex3('if-end'), 0.25, 1.6, 2);
  const ends = instanced(
    endShape,
    endMaterial,
    [HEAD, HEAD, TAIL, TAIL].map((color) => ({ position: new THREE.Vector3(), color })),
  );
  root.add(ends);

  // ── Dimers for stages 2–4 (instanced) ─────────────────────────────────
  const dimer = dimerGeometry(q);
  const dimerMaterial = vertexMaterial(0.2, 'ifDimer');
  const TETRAMER_DIMERS = 2;
  const ULF_DIMERS = 16;
  const dimerCount = TETRAMER_DIMERS + ULF_DIMERS * 2;
  const dimers = instanced(
    dimer,
    dimerMaterial,
    Array.from({ length: dimerCount }, () => ({ position: new THREE.Vector3(), color: '#ffffff' })),
  );
  dimers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(dimers);

  // ── Stage 4: mature filament (rope) = main part + the most recently joined unit ─
  const filament = new THREE.Group();
  filament.position.set(X_FILAMENT, 0, 0);
  root.add(filament);
  const ropeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: '#2e2a12' });
  const ropeMain = new THREE.Mesh(ropeGeometry(UNIT, UNIT * FILAMENT_UNITS, q), ropeMaterial);
  const ropeJoined = new THREE.Mesh(ropeGeometry(0, UNIT + 0.5, q), ropeMaterial);
  filament.add(ropeMain, ropeJoined);

  // "Pull" cue: chevrons above the filament's right part, shown while it is pulled.
  const chevronParts: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const arm = new THREE.BoxGeometry(9, 2, 1);
    arm.translate(-4, 0, 0);
    arm.rotateZ(sign * THREE.MathUtils.degToRad(40));
    arm.deleteAttribute('uv');
    chevronParts.push(arm);
  }
  const chevronGeometry = mergeGeometries(chevronParts)!;
  chevronParts.forEach((g) => g.dispose());
  const chevrons = instanced(
    chevronGeometry,
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    [0, 1, 2].map(() => ({ position: new THREE.Vector3(), color: '#ffe9a0' })),
  );
  root.add(chevrons);

  // Faint step arrows between the stages (dimer → tetramer → ULF → filament).
  const steps = instanced(
    chevronGeometry,
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    [(X_DIMER + ROD / 2 + X_TETRAMER - 31) / 2 + 4, (X_TETRAMER + 31 + X_ULF - 31) / 2 + 4, (X_ULF + 31 + X_FILAMENT) / 2 + 4].map((x) => ({
      position: new THREE.Vector3(x, 0, 0),
      scale: 0.75,
      color: '#5d5a3c',
    })),
  );
  root.add(steps);
  const stepColor = new THREE.Color();
  const STEP_BASE = new THREE.Color('#5d5a3c');
  const STEP_LIT = new THREE.Color('#d9cf8c');

  // ── Layout helpers ────────────────────────────────────────────────────
  const m4 = new THREE.Matrix4();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const qFrame = new THREE.Quaternion();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const flip = new THREE.Quaternion().setFromAxisAngle(Z, Math.PI);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  /** Place the two dimers of a tetramer: frame maps local x → axis, y → side by side, z → outward. */
  const placeTetramer = (first: number, centre: THREE.Vector3, frame: THREE.Quaternion, spread: number, slide: number, scale: number) => {
    for (let k = 0; k < 2; k++) {
      const sign = k === 0 ? 1 : -1;
      // Dimer A points +x (heads left), dimer B antiparallel, the pair staggered by 16 nm.
      v1.set(-sign * (STAGGER / 2 + slide), sign * (TETRAMER_HALF_WIDTH + spread), 0).applyQuaternion(frame).add(centre);
      qa.copy(frame);
      if (k === 1) qa.multiply(flip);
      dimers.setMatrixAt(first + k, scale < 0.02 ? zero : m4.compose(v1, qa, sv.setScalar(scale)));
    }
  };

  /** Fade-out-then-in reset: 1 → 0 over the first half, 0 → 1 over the second. */
  // Label anchors in the world (the assembly line moves under the camera).
  const dimerAnchor = new THREE.Vector3();
  const tetramerAnchor = new THREE.Vector3();
  const ulfAnchor = new THREE.Vector3();
  const filamentAnchor = new THREE.Vector3();
  const pullAnchor = new THREE.Vector3();
  let ulfInView = false;
  const updateAnchors = (end: number) => {
    const dx = -focus;
    dimerAnchor.set(X_DIMER - 6 + dx, 0.8 + monomers.position.y, 1.2);
    tetramerAnchor.set(X_TETRAMER + 4 + dx, 1.5, 1.6);
    // The ULF label follows the new ULF while it docks, otherwise the one just assembled.
    const docking = ulfScale > 0.5 && Math.abs(X_DOCK - focus) < IN_VIEW;
    if (docking) ulfAnchor.set(dockCentre.x - 8 + dx, dockCentre.y + 2, 7);
    else ulfAnchor.set(X_ULF - 8 + dx, 2, 7.4);
    ulfInView = docking || (s3 > 0.5 && Math.abs(X_ULF - focus) < IN_VIEW);
    // A point on the filament's surface a little left of the view centre (on the older part while a ULF docks).
    const x = THREE.MathUtils.clamp(Math.max(focus - 35, X_FILAMENT + UNIT + 10), X_FILAMENT + 4, end - 6);
    const thin = 1 / Math.sqrt(stretch);
    filamentAnchor.set(x + dx, 0.8 * thin, 4.6 * thin);
    pullAnchor.set(end - 28 + dx, 16.5, 0.5);
  };

  const resetScale = (t: number, a: number, b: number) => {
    if (t < a || t >= b) return 1;
    const mid = (a + b) / 2;
    return t < mid ? 1 - ramp(t, a, mid) : ramp(t, mid, b);
  };

  // Stage 3 scatter: where each of the eight tetramers comes from.
  const ulfFrom = Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * Math.PI * 2 + 0.4;
    return new THREE.Vector3(((k * 37) % 9) * 3 - 12, Math.cos(a) * (26 + (k % 3) * 6), Math.sin(a) * (20 + (k % 2) * 8));
  });
  const ulfTurnAxis = ulfFrom.map((v) => v.clone().normalize());
  const ulfAngle = (k: number) => (k / 8) * Math.PI * 2 + Math.PI / 8;
  const ringFrame = (k: number, target: THREE.Quaternion) => target.setFromAxisAngle(X, ulfAngle(k) - Math.PI / 2);

  let pulling = false;
  /** True during the quick return sweep from the pulled end back to the dimer (stage labels stay hidden). */
  let sweeping = false;
  let focus = PULL_FOCUS;
  let stretch = 1;
  let s1 = 1;
  let s3 = 1;
  let ulfScale = 0;
  const dockCentre = new THREE.Vector3();
  const chevronColor = new THREE.Color();
  const stretchAt = (t: number) => {
    if (t < 17.4 || t > 21.0) return 1;
    // Out over 1.4 s, hold, back over 1.4 s.
    const out = easeInOut(ramp(t, 17.4, 18.8));
    const back = easeInOut(ramp(t, 19.6, 21.0));
    return 1 + 0.8 * out * (1 - back);
  };

  const update = (time: number, calm: boolean) => {
    const t = mod(time, LOOP);
    const amp = calm ? 0.3 : 1;

    // Stage 1 — reset [0, 0.8] (off screen, while the view returns); approach [2.0, 3.4]; coil [3.4, 5.0].
    s1 = resetScale(t, 0, 0.8);
    const approach = t < 0.4 ? 1 : easeInOut(ramp(t, 2.0, 3.4));
    const coil = t < 0.4 ? 1 : easeInOut(ramp(t, 3.4, 5.0));
    monomers.morphTargetInfluences![0] = approach * (1 - coil);
    monomers.morphTargetInfluences![1] = coil;
    monomers.scale.setScalar(Math.max(1e-3, s1));
    monomers.position.y = noise.noise(time * 0.3, 1, 0) * 0.6 * amp;
    const gap = THREE.MathUtils.lerp(7, THREE.MathUtils.lerp(0.55, 0.7, coil), approach);
    for (let k = 0; k < 4; k++) {
      const head = k < 2;
      const sign = k % 2 === 0 ? 1 : -1;
      v1.set(X_DIMER + (head ? -ROD / 2 - 1.6 : ROD / 2 + 1.3) * s1, monomers.position.y + sign * gap * s1, 0);
      ends.setMatrixAt(k, s1 < 0.02 ? zero : m4.compose(v1, qa.identity(), sv.setScalar(s1 * (head ? 1 : 0.85))));
    }
    ends.instanceMatrix.needsUpdate = true;

    // Stage 2 — reset [5.4, 6.2] during the pan; the two dimers approach antiparallel and slide into register [6.2, 8.4].
    const s2 = resetScale(t, 5.4, 6.2);
    const pairUp = t < 5.8 ? 1 : easeInOut(ramp(t, 6.2, 7.4));
    const slideIn = t < 5.8 ? 1 : easeInOut(ramp(t, 7.0, 8.4));
    v2.set(X_TETRAMER, noise.noise(time * 0.3, 5, 0) * 0.6 * amp, 0);
    placeTetramer(0, v2, qFrame.identity(), 17 * (1 - pairUp), 14 * (1 - slideIn), s2);

    // Stage 3 — reset [8.8, 9.6] during the pan; eight tetramers gather into a ULF one after another [9.6, 12.4].
    s3 = resetScale(t, 8.8, 9.6);
    for (let k = 0; k < 8; k++) {
      const arrive = t < 9.2 ? 1 : easeInOut(ramp(t, 9.6 + k * 0.25, 10.6 + k * 0.25));
      ringFrame(k, qb);
      v2.set(0, Math.cos(ulfAngle(k)), Math.sin(ulfAngle(k))).multiplyScalar(ULF_RADIUS);
      v2.lerp(ulfFrom[k], 1 - arrive);
      v2.x += X_ULF;
      qa.setFromAxisAngle(ulfTurnAxis[k], (1 - arrive) * 1.2);
      qb.premultiply(qa);
      placeTetramer(TETRAMER_DIMERS + k * 2, v2, qb, 0, 0, s3);
    }

    // Stage 4 — reset [12.8, 13.6] during the pan: the unit that joined in the previous loop fades
    // out while a new ULF appears; dock [13.6, 15.0]; compact [15.0, 16.0] as the joined rope unit fades in.
    const joinedScale = t < 12.8 ? 1 : t < 13.2 ? 1 - ramp(t, 12.8, 13.2) : ramp(t, 15.6, 16.2);
    ropeJoined.scale.set(1, Math.max(1e-3, joinedScale), Math.max(1e-3, joinedScale));
    ropeJoined.visible = joinedScale > 0.01;
    const appear = ramp(t, 13.2, 13.6);
    const dock = easeInOut(ramp(t, 13.6, 15.0));
    const compact = easeInOut(ramp(t, 15.0, 16.0));
    const dissolve = 1 - ramp(t, 15.6, 16.2);
    ulfScale = t < 13.2 || t > 16.2 ? 0 : appear * dissolve;
    const radius = THREE.MathUtils.lerp(ULF_RADIUS, COMPACT_RADIUS, compact);
    dockCentre.set(X_DOCK - 18 * (1 - dock), 34 * (1 - dock), 0);
    for (let k = 0; k < 8; k++) {
      ringFrame(k, qb);
      v2.set(0, Math.cos(ulfAngle(k)), Math.sin(ulfAngle(k))).multiplyScalar(radius).add(dockCentre);
      placeTetramer(TETRAMER_DIMERS + ULF_DIMERS + k * 2, v2, qb, 0, 0, ulfScale);
    }
    dimers.instanceMatrix.needsUpdate = true;

    // The arrow before the stage being assembled lights up.
    const active = t >= 5.4 && t < 8.8 ? 0 : t >= 8.8 && t < 12.8 ? 1 : t >= 12.8 && t < 16.4 ? 2 : -1;
    for (let i = 0; i < 3; i++) steps.setColorAt(i, stepColor.copy(STEP_BASE).lerp(STEP_LIT, i === active ? 1 : 0));
    if (steps.instanceColor) steps.instanceColor.needsUpdate = true;

    // The pull: stretch up to 1.8× (thinning to keep volume), hold, relax.
    stretch = stretchAt(t);
    pulling = t >= 17.4 && t <= 21.2;
    filament.scale.set(stretch, 1 / Math.sqrt(stretch), 1 / Math.sqrt(stretch));
    const end = X_FILAMENT + FILAMENT_LENGTH * stretch;
    // Chevrons above the pulled end point the way it is pulled.
    for (let i = 0; i < 3; i++) {
      const on = pulling ? ramp(t, 17.4, 17.8) * (1 - ramp(t, 20.8, 21.2)) : 0;
      const pulse = calm ? 0.7 : 0.35 + 0.65 * Math.pow(Math.max(0, Math.cos(Math.PI * 2 * (time * 0.9 - i * 0.18))), 3);
      v1.set(end - 40 + i * 12, 15, 0);
      chevrons.setMatrixAt(i, on < 0.02 ? zero : m4.compose(v1, qa.identity(), sv.setScalar(on)));
      chevrons.setColorAt(i, chevronColor.copy(HEAD).multiplyScalar(pulse));
    }
    chevrons.instanceMatrix.needsUpdate = true;
    if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;

    // Follow the lesson: slide the assembly line so the active stage (or, while pulling,
    // the pulled end, which still visibly moves outward) sits in the middle of the view.
    focus = focusAt(t) + PULL_FOLLOW * FILAMENT_LENGTH * (stretch - 1);
    sweeping = t < 1.7;
    root.position.x = -focus;
    updateAnchors(end);
  };

  update(0, false);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, 0, 0),
        radius: 90,
        direction: new THREE.Vector3(0, 0.3, 1).normalize(),
        posterTime: 14.5, // Opens on a unit-length filament joining the filament end.
        labels: [
          { textKey: 'closeupCaptions.pull', anchor: () => pullAnchor, visible: () => pulling },
          { part: 'dimer', anchor: () => dimerAnchor, visible: () => !sweeping && s1 > 0.5 && Math.abs(X_DIMER - focus) < IN_VIEW },
          { part: 'tetramer', anchor: () => tetramerAnchor, visible: () => !sweeping && Math.abs(X_TETRAMER - focus) < IN_VIEW },
          { part: 'ulf', anchor: () => ulfAnchor, visible: () => !sweeping && ulfInView },
          { part: 'filament', anchor: () => filamentAnchor, visible: () => !sweeping && focus > X_FILAMENT - 20 },
        ],
      },
    ],
    setView() {},
    update(_dt, time, calm) {
      update(time, calm);
    },
    dispose() {
      together.dispose();
      coiled.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
