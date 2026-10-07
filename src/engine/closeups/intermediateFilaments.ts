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
 * thins) without breaking, and relaxes. One 20 s loop; each stage resets
 * just before it assembles again.
 */

const LOOP = 20;
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
/** Where the pull cue sits (world x). */
const PULL_X = 226;

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

  // "Pull" cue: chevrons at the pulled end.
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
  const chevronColor = new THREE.Color();
  const stretchAt = (t: number) => {
    if (t < 15 || t > 19.2) return 1;
    // Out over 1.6 s, hold, back over 1.6 s.
    const out = easeInOut(ramp(t, 15, 16.6));
    const back = easeInOut(ramp(t, 17.6, 19.2));
    return 1 + 0.8 * out * (1 - back);
  };

  const update = (time: number, calm: boolean) => {
    const t = mod(time, LOOP);
    const amp = calm ? 0.3 : 1;

    // Stage 1 — reset [0, 0.8]; approach [0.8, 2.4]; coil [2.4, 4.0].
    const s1 = resetScale(t, 0, 0.8);
    const approach = t < 0.4 ? 1 : easeInOut(ramp(t, 0.8, 2.4));
    const coil = t < 0.4 ? 1 : easeInOut(ramp(t, 2.4, 4.0));
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

    // Stage 2 — reset [4.0, 4.8]; the two dimers approach antiparallel and slide into register [4.8, 7.2].
    const s2 = resetScale(t, 4.0, 4.8);
    const pairUp = t < 4.4 ? 1 : easeInOut(ramp(t, 4.8, 6.4));
    const slideIn = t < 4.4 ? 1 : easeInOut(ramp(t, 5.8, 7.2));
    v2.set(X_TETRAMER, noise.noise(time * 0.3, 5, 0) * 0.6 * amp, 0);
    placeTetramer(0, v2, qFrame.identity(), 17 * (1 - pairUp), 14 * (1 - slideIn), s2);

    // Stage 3 — reset [7.2, 8.0]; eight tetramers gather into a ULF one after another [8.0, 11.0].
    const s3 = resetScale(t, 7.2, 8.0);
    for (let k = 0; k < 8; k++) {
      const arrive = t < 7.6 ? 1 : easeInOut(ramp(t, 8.0 + k * 0.28, 9.0 + k * 0.28));
      ringFrame(k, qb);
      v2.set(0, Math.cos(ulfAngle(k)), Math.sin(ulfAngle(k))).multiplyScalar(ULF_RADIUS);
      v2.lerp(ulfFrom[k], 1 - arrive);
      v2.x += X_ULF;
      qa.setFromAxisAngle(ulfTurnAxis[k], (1 - arrive) * 1.2);
      qb.premultiply(qa);
      placeTetramer(TETRAMER_DIMERS + k * 2, v2, qb, 0, 0, s3);
    }

    // Stage 4 — reset [11.0, 11.8]: the unit joined last loop dissolves into the filament
    // record while a new ULF appears; dock [11.8, 13.4]; compact [13.4, 14.6].
    const joinedScale = t < 11.0 ? 1 : t < 11.4 ? 1 - ramp(t, 11.0, 11.4) : ramp(t, 14.0, 14.6);
    ropeJoined.scale.set(1, Math.max(1e-3, joinedScale), Math.max(1e-3, joinedScale));
    ropeJoined.visible = joinedScale > 0.01;
    const appear = ramp(t, 11.4, 11.8);
    const dock = easeInOut(ramp(t, 11.8, 13.4));
    const compact = easeInOut(ramp(t, 13.4, 14.4));
    const dissolve = 1 - ramp(t, 14.0, 14.6);
    const ulfScale = t < 11.4 || t > 14.6 ? 0 : appear * dissolve;
    const radius = THREE.MathUtils.lerp(ULF_RADIUS, COMPACT_RADIUS, compact);
    for (let k = 0; k < 8; k++) {
      ringFrame(k, qb);
      v2.set(0, Math.cos(ulfAngle(k)), Math.sin(ulfAngle(k))).multiplyScalar(radius);
      v2.x += X_FILAMENT + UNIT / 2 - 18 * (1 - dock);
      v2.y += 34 * (1 - dock);
      placeTetramer(TETRAMER_DIMERS + ULF_DIMERS + k * 2, v2, qb, 0, 0, ulfScale);
    }
    dimers.instanceMatrix.needsUpdate = true;

    // The arrow before the stage being assembled lights up.
    const active = t >= 4 && t < 7.2 ? 0 : t >= 7.2 && t < 11 ? 1 : t >= 11 && t < 14.6 ? 2 : -1;
    for (let i = 0; i < 3; i++) steps.setColorAt(i, stepColor.copy(STEP_BASE).lerp(STEP_LIT, i === active ? 1 : 0));
    if (steps.instanceColor) steps.instanceColor.needsUpdate = true;

    // The pull: stretch up to 1.8× (thinning to keep volume), hold, relax.
    const stretch = stretchAt(t);
    pulling = t >= 15 && t <= 19.2;
    filament.scale.set(stretch, 1 / Math.sqrt(stretch), 1 / Math.sqrt(stretch));
    // Chevrons above the filament's right part point the way it is pulled.
    for (let i = 0; i < 3; i++) {
      const on = pulling ? ramp(t, 15, 15.4) * (1 - ramp(t, 18.8, 19.2)) : 0;
      const pulse = calm ? 0.7 : 0.35 + 0.65 * Math.pow(Math.max(0, Math.cos(Math.PI * 2 * (time * 0.9 - i * 0.18))), 3);
      v1.set(PULL_X + i * 12, 15, 0);
      chevrons.setMatrixAt(i, on < 0.02 ? zero : m4.compose(v1, qa.identity(), sv.setScalar(on)));
      chevrons.setColorAt(i, chevronColor.copy(HEAD).multiplyScalar(pulse));
    }
    chevrons.instanceMatrix.needsUpdate = true;
    if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;
  };

  update(0, false);

  const dimerAnchor = new THREE.Vector3(X_DIMER - 6, 0.8, 1.2);
  const tetramerAnchor = new THREE.Vector3(X_TETRAMER + 4, 1.5, 1.6);
  const ulfAnchor = new THREE.Vector3(X_ULF - 8, 2, 7.4);
  const filamentAnchor = new THREE.Vector3(UNIT * 1.6, 0.8, 4.6);
  const filamentWorld = new THREE.Vector3();
  const pullAnchor = new THREE.Vector3(PULL_X + 12, 16, 0.5);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(16, 0, 0),
        radius: 280,
        direction: new THREE.Vector3(0, 0.3, 1).normalize(),
        labels: [
          { textKey: 'closeupCaptions.pull', anchor: () => pullAnchor, visible: () => pulling },
          { part: 'dimer', anchor: () => dimerAnchor },
          { part: 'tetramer', anchor: () => tetramerAnchor },
          { part: 'ulf', anchor: () => ulfAnchor },
          {
            part: 'filament',
            anchor: () => {
              filament.updateWorldMatrix(true, false);
              return filament.localToWorld(filamentWorld.copy(filamentAnchor));
            },
          },
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
