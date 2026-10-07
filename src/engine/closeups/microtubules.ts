import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { createCloseupScene, disposeScene, easeInOut } from './common';
import { addInstanceGlow, byQuality, instanced, instancedMaterial, MICROTUBULE, type Placement } from './kit';
import { DIMER_REPEAT, PF_ANGLE, TubulinPlacer, mod, ramp, tubulinGeometry } from './cytoskeletonParts';
import type { CloseupFactory } from './types';

/**
 * Dynamic instability (1 unit = 1 nm). The plus end of a 13-protofilament
 * microtubule, axis vertical, plus end up; the minus end continues below
 * the frame. A 24 s loop, every position a pure function of time:
 * RESCUE/GROWING — free GTP-tubulin dimers attach one by one to the
 * protofilament tips (bright GTP cap, older dimers dim to GDP);
 * CATASTROPHE — the cap is lost and the protofilaments curl outward;
 * SHRINKING — curled oligomers break off and drift away, about three times
 * faster than the tube grew; then rescue and growth again.
 */

const LOOP = 24;
/** Dimers added (and later lost) per protofilament in one loop. */
const ADDED = 8;
/** Growth window (s after the rescue). */
const GROW_END = 16.6;
const CAP_LOSS_START = 16.8;
const CAP_LOSS_END = 18.2;
/** Shrinking: each protofilament's "zipper" runs down between these times (± a little). */
const SHRINK_START = 18.0;
const SHRINK_END = 23.5;
const FLIGHT = 1.0;
/** Outward curl per monomer of a peeling protofilament (≈22° per dimer). */
const CURL = THREE.MathUtils.degToRad(11);
/** Gentle outward flare of the newest dimers at a growing tip. */
const FLARE = THREE.MathUtils.degToRad(2.2);
/** Bottom of the drawn lattice (world y); the tube continues below the frame. */
const Y0 = -222;
/** Dimers per protofilament at the shortest point of the loop. */
const BASE = 27;
const FRAGMENT_LIFE = 2.6;

const ALPHA_GDP = new THREE.Color('#dcecff');
const BETA_GDP = new THREE.Color('#5b8fd9');
const ALPHA_GTP = new THREE.Color('#fff8dc');
const BETA_GTP = new THREE.Color('#ffe27c');

interface Fragment {
  /** Added-dimer range [lo, hi) (0 = first dimer added after the rescue). */
  lo: number;
  hi: number;
  release: number;
  /** Zipper position at release (dimers above the base). */
  zipper: number;
  spin: number;
}

interface PfPlan {
  base: number;
  attach: number[];
  start: number;
  end: number;
  fragments: Fragment[];
}

/** Zipper (dimers above the base still in the tube wall): peels fast after the catastrophe, slows to a stop at the rescue. */
const zipperAt = (plan: PfPlan, tau: number) => {
  const x = THREE.MathUtils.clamp((tau - plan.start) / (plan.end - plan.start), 0, 1);
  return ADDED * Math.pow(1 - x, 1.6);
};

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0b1226');
  const rng = new Rng('closeup:microtubules');
  const noise = new Simplex3('closeup:microtubules:drift');
  const q = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);
  const pfCount = MICROTUBULE.protofilaments;
  const placer = new TubulinPlacer();

  // ── Plans: attach times, zipper timing, fragments (deterministic) ──────
  const patterns = [
    [3, 3, 2],
    [2, 3, 3],
    [3, 2, 3],
  ];
  const plans: PfPlan[] = [];
  for (let p = 0; p < pfCount; p++) {
    const base = BASE + (rng.chance(0.45) ? 1 : 0);
    const attach: number[] = [];
    const spacing = GROW_END / ADDED;
    const phase = rng.range(0, 0.5);
    for (let j = 0; j < ADDED; j++) attach.push(Math.max(FLIGHT + 0.25, (j + 0.25 + phase + rng.range(-0.22, 0.22)) * spacing));
    const start = SHRINK_START + rng.range(0, 0.7);
    const end = SHRINK_END - rng.range(0, 0.45);
    const plan: PfPlan = { base, attach, start, end, fragments: [] };
    const sizes = patterns[rng.int(0, patterns.length - 1)];
    let hi = ADDED;
    sizes.forEach((size, f) => {
      const lo = hi - size;
      // A curled piece breaks off once the peel has gone ~1.2 dimers past it (the last one when the zipper stops).
      const threshold = f === sizes.length - 1 ? 0.02 : lo - 1.2;
      let a = plan.start;
      let b = plan.end;
      for (let i = 0; i < 40; i++) {
        const mid = (a + b) / 2;
        if (zipperAt(plan, mid) > threshold) a = mid;
        else b = mid;
      }
      plan.fragments.push({ lo, hi, release: b, zipper: zipperAt(plan, b), spin: rng.range(0.5, 1.1) * (rng.chance(0.5) ? 1 : -1) });
      hi = lo;
    });
    plans.push(plan);
  }

  // ── Instances: lattice + fragment pool + free dimers, one mesh ────────
  const perPf = 2 * (BASE + 1 + ADDED);
  const latticeCount = pfCount * perPf;
  const fragmentSlots = pfCount * 3 * 3 * 2; // 3 fragments × ≤3 dimers × 2 monomers
  const freeCount = byQuality(q, { low: 34, medium: 46, high: 58 });
  const total = latticeCount + fragmentSlots + freeCount * 2;
  const geometry = tubulinGeometry(q, 'mt-tubulin');
  const material = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(material, 0.24, 'mtTubulin');
  const placements: Placement[] = Array.from({ length: total }, () => ({ position: new THREE.Vector3(), color: ALPHA_GDP }));
  const mesh = instanced(geometry, material, placements);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const tube = new THREE.Group();
  tube.position.y = Y0;
  tube.add(mesh);
  root.add(tube);

  const m4 = new THREE.Matrix4();
  const m4b = new THREE.Matrix4();
  const m4c = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const col = new THREE.Color();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const axisV = new THREE.Vector3();

  const colorFor = (beta: boolean, gtp: number) =>
    beta ? col.copy(BETA_GDP).lerp(BETA_GTP, gtp) : col.copy(ALPHA_GDP).lerp(ALPHA_GTP, gtp * 0.7);

  // Static lower lattice (never changes): fade out toward the bottom edge.
  const dynamicFrom = 2 * (BASE - 1);
  for (let p = 0; p < pfCount; p++) {
    for (let m = 0; m < perPf; m++) {
      const i = p * perPf + m;
      if (m >= dynamicFrom) continue;
      placer.position(p, m, 0, Infinity, v1);
      const scale = ramp(v1.y, 0, 26);
      mesh.setMatrixAt(i, scale < 0.02 ? zero : placer.matrix(p, m, 0, Infinity, scale, m4));
      mesh.setColorAt(i, colorFor(m % 2 === 1, 0));
    }
  }

  // Free dimers diffusing around the tube (GTP-tubulin, faintly bright).
  interface Free {
    home: THREE.Vector3;
    seed: number;
    turn: THREE.Quaternion;
    axis: THREE.Vector3;
  }
  const free: Free[] = [];
  for (let i = 0; i < freeCount; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(26, 95);
    free.push({
      home: new THREE.Vector3(Math.cos(a) * r, rng.range(-165, 165), Math.sin(a) * r),
      seed: i * 3.7,
      turn: new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6))),
      axis: rng.direction(),
    });
  }
  // The labelled free dimer: one in front, left of the tube, at mid height.
  let freeLabel = 0;
  let bestScore = -Infinity;
  free.forEach((f, i) => {
    const score = f.home.z * 0.6 - Math.abs(f.home.x + 45) - Math.abs(f.home.y + 25) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      freeLabel = i;
    }
  });
  const freeBase = latticeCount + fragmentSlots;
  for (let i = 0; i < freeCount; i++) {
    mesh.setColorAt(freeBase + i * 2, colorFor(false, 0.3));
    mesh.setColorAt(freeBase + i * 2 + 1, colorFor(true, 0.3));
  }
  const freePos = free.map(() => new THREE.Vector3());

  // ── Per-frame state ───────────────────────────────────────────────────
  let tau = 0;
  let tipY = 0;
  const radial = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const drift = new THREE.Vector3();

  /** Monomer m of protofilament p as it sits in (or curls off) the lattice right now. */
  const latticeMatrix = (p: number, m: number, curlFrom: number, curl: number, scale: number, target: THREE.Matrix4) =>
    placer.matrix(p, m, curl, curlFrom, scale, target);

  const updateTube = (t: number, calm: boolean) => {
    tau = mod(t, LOOP);
    const growing = tau < GROW_END;
    const capFactor = 1 - ramp(tau, CAP_LOSS_START, CAP_LOSS_END);
    let tipSum = 0;
    for (let p = 0; p < pfCount; p++) {
      const plan = plans[p];
      const angle = p * PF_ANGLE;
      radial.set(Math.cos(angle), 0, Math.sin(angle));
      tangent.set(-Math.sin(angle), 0, Math.cos(angle));
      // How many added dimers are attached, how far the peel has gone, which pieces have left.
      let attached = 0;
      for (let j = 0; j < ADDED; j++) if (tau >= plan.attach[j]) attached++;
      if (!growing) attached = ADDED;
      const zipper = growing ? ADDED : zipperAt(plan, tau);
      let present = attached;
      for (let f = 0; f < plan.fragments.length; f++) if (tau >= plan.fragments[f].release) present = Math.min(present, plan.fragments[f].lo);
      const top = plan.base + present;
      tipSum += Math.min(top, plan.base + zipper);
      const peeling = !growing && zipper < ADDED - 1e-3;
      const curlFrom = peeling ? 2 * (plan.base + zipper) - 1 : 2 * top - 4;
      const curl = peeling ? CURL * ramp(tau, plan.start, plan.start + 0.6) : growing ? FLARE : 0;
      for (let m = dynamicFrom; m < perPf; m++) {
        const i = p * perPf + m;
        const d = Math.floor(m / 2) - plan.base; // added-dimer index (negative = old lattice)
        const beta = m % 2 === 1;
        if (d < 0) {
          mesh.setMatrixAt(i, latticeMatrix(p, m, curlFrom, curl, 1, m4));
          mesh.setColorAt(i, colorFor(beta, 0));
          continue;
        }
        if (d >= ADDED) {
          mesh.setMatrixAt(i, zero);
          continue;
        }
        const attachAt = plan.attach[d];
        if (d < present) {
          mesh.setMatrixAt(i, latticeMatrix(p, m, curlFrom, curl, 1, m4));
          const age = tau - attachAt;
          const gtp = (1 - ramp(age, 4, 9.5)) * capFactor;
          mesh.setColorAt(i, colorFor(beta, gtp));
        } else if (growing && tau >= attachAt - FLIGHT && tau < attachAt) {
          // A free dimer arriving at this protofilament's tip.
          const k = easeInOut((tau - attachAt + FLIGHT) / FLIGHT);
          latticeMatrix(p, m, curlFrom, curl, 1, m4b);
          v1.setFromMatrixPosition(m4b);
          const away = 1 - k;
          v2.copy(v1).addScaledVector(radial, 16 * away).addScaledVector(tangent, 7 * away * (p % 2 ? 1 : -1));
          v2.y += 12 * away;
          qa.setFromRotationMatrix(m4b);
          sv.setScalar(ramp(k, 0, 0.3) * (0.85 + 0.15 * k));
          mesh.setMatrixAt(i, m4.compose(v2, qa, sv));
          mesh.setColorAt(i, colorFor(beta, 1));
        } else {
          mesh.setMatrixAt(i, zero);
        }
      }
      updateFragments(p, plan, calm);
    }
    tipY = Y0 + (tipSum / pfCount) * DIMER_REPEAT;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  /** Curled pieces that broke off: rigid drift outward and up, turning, fading. */
  const updateFragments = (p: number, plan: PfPlan, calm: boolean) => {
    const slot0 = latticeCount + p * 18;
    for (let fi = 0; fi < plan.fragments.length; fi++) {
      const f = plan.fragments[fi];
      let age = tau - f.release;
      if (age < 0) age += LOOP;
      const alive = age >= 0 && age < FRAGMENT_LIFE;
      const curlFrom = 2 * (plan.base + f.zipper) - 1;
      let n = 0;
      if (alive) {
        // Centroid of the piece at the moment it broke off.
        centroid.set(0, 0, 0);
        for (let d = f.lo; d < f.hi; d++) {
          for (let b = 0; b < 2; b++) {
            placer.position(p, 2 * (plan.base + d) + b, CURL, curlFrom, v3);
            centroid.add(v3);
            n++;
          }
        }
        centroid.multiplyScalar(1 / n);
        const speed = calm ? 0.6 : 1;
        const s = age * speed;
        drift.copy(radial).multiplyScalar(5 + 11 * s).add(v3.set(0, 4 + 9 * s, 0));
        axisV.copy(tangent);
        qa.setFromAxisAngle(axisV, -f.spin * s * 0.9);
        m4c.makeRotationFromQuaternion(qa);
      }
      const fade = alive ? 1 - ramp(age, FRAGMENT_LIFE * 0.55, FRAGMENT_LIFE) : 0;
      for (let k = 0; k < 6; k++) {
        const i = slot0 + fi * 6 + k;
        const d = f.lo + (k >> 1);
        if (!alive || d >= f.hi || fade < 0.02) {
          mesh.setMatrixAt(i, zero);
          continue;
        }
        const m = 2 * (plan.base + d) + (k & 1);
        placer.matrix(p, m, CURL, curlFrom, fade, m4b);
        // Rotate about the piece's centroid, then carry it away.
        m4b.setPosition(v1.setFromMatrixPosition(m4b).sub(centroid));
        m4.multiplyMatrices(m4c, m4b);
        v2.setFromMatrixPosition(m4).add(centroid).add(drift);
        m4.setPosition(v2);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, colorFor(k % 2 === 1, 0));
      }
    }
  };

  const qb = new THREE.Quaternion();
  const updateFree = (t: number, calm: boolean) => {
    const wander = calm ? 0.4 : 1;
    sv.setScalar(1);
    for (let i = 0; i < free.length; i++) {
      const f = free[i];
      const s = t * 0.07 * wander;
      const pos = freePos[i].set(
        f.home.x + noise.noise(f.seed, s, 0) * 16,
        f.home.y + noise.noise(f.seed, s, 7) * 16,
        f.home.z + noise.noise(f.seed, s, 13) * 16,
      );
      // Stay clear of the tube.
      const r = Math.hypot(pos.x, pos.z);
      if (r < 24) {
        const k = 24 / Math.max(r, 1e-3);
        pos.x *= k;
        pos.z *= k;
      }
      // Slow tumbling about the dimer's own axis.
      qa.copy(f.turn).multiply(qb.setFromAxisAngle(f.axis, t * 0.2 * wander + f.seed));
      // Dimer: α below β along the dimer's own axis.
      v1.set(0, 2.05, 0).applyQuaternion(qa);
      mesh.setMatrixAt(freeBase + i * 2, m4.compose(v3.copy(pos).sub(v1).sub(tube.position), qa, sv));
      mesh.setMatrixAt(freeBase + i * 2 + 1, m4.compose(v3.copy(pos).add(v1).sub(tube.position), qa, sv));
    }
  };

  const update = (t: number, calm: boolean) => {
    updateTube(t, calm);
    updateFree(t, calm);
    mesh.instanceMatrix.needsUpdate = true;
  };

  // ── Labels ────────────────────────────────────────────────────────────
  const view = new THREE.Vector3(0.24, 0.26, 1).normalize();
  const front = new THREE.Vector3(view.x, 0, view.z).normalize();
  const tipAnchor = new THREE.Vector3();
  const capAnchor = new THREE.Vector3();
  const captionAnchor = new THREE.Vector3();
  const pfAnchor = front.clone().multiplyScalar(12.4).setY(-72);
  const minusAnchor = front.clone().multiplyScalar(12.4).setY(-128);
  const freeAnchor = new THREE.Vector3();
  const phase = () => (tau < 3.2 || tau >= SHRINK_END ? 'rescue' : tau < GROW_END ? 'growing' : tau < SHRINK_START + 1.2 ? 'catastrophe' : 'shrinking');

  update(0, false);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, 8, 0),
        radius: 110,
        direction: view.clone(),
        labels: [
          { textKey: 'closeupCaptions.growing', anchor: () => captionAnchor, visible: () => phase() === 'growing' },
          { textKey: 'closeupCaptions.catastrophe', anchor: () => captionAnchor, visible: () => phase() === 'catastrophe' },
          { textKey: 'closeupCaptions.shrinking', anchor: () => captionAnchor, visible: () => phase() === 'shrinking' },
          { textKey: 'closeupCaptions.rescue', anchor: () => captionAnchor, visible: () => phase() === 'rescue' },
          { part: 'plus-end', anchor: () => tipAnchor },
          { part: 'gtp-cap', anchor: () => capAnchor, visible: () => tau > 2.4 && tau < CAP_LOSS_START },
          { part: 'protofilament', anchor: () => pfAnchor },
          { part: 'tubulin-dimer', anchor: () => freeAnchor },
          { part: 'minus-end', anchor: () => minusAnchor },
        ],
      },
    ],
    setView() {},
    update(_dt, time, calm) {
      update(time, calm);
      tipAnchor.copy(front).multiplyScalar(11).setY(tipY + 2);
      capAnchor.copy(front).multiplyScalar(12.6).setY(tipY - 13);
      captionAnchor.set(-30, tipY + 12, 6);
      freeAnchor.copy(freePos[freeLabel]);
    },
    dispose() {
      disposeScene(scene);
    },
  };
};

export default create;
