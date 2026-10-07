import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { mergeGeometries, noisyEllipsoid } from '../core/geometry';
import { blobGeometry, createCloseupScene, disposeScene, easeInOut } from './common';
import {
  ACTIN,
  actinFilament,
  addInstanceGlow,
  bandMaterial,
  bilayerStripGeometry,
  instanced,
  instancedMaterial,
  membraneMaterial,
  type ActinFilament,
} from './kit';
import { ramp } from './cytoskeletonParts';
import type { CloseupFactory } from './types';

/**
 * Treadmilling and branching at the leading edge (1 unit = 1 nm). The
 * plasma membrane stays fixed across the top; below it a dendritic actin
 * network flows slowly downward (in the cell, the membrane moves forward
 * instead). Barbed ends just under the membrane add bright ATP-actin and
 * keep pace with it; the network ages to dull ADP-actin and loses subunits
 * from its pointed ends deeper down. Arp2/3 complexes start new filaments at
 * 70° on existing ones, so filaments lie at ±35° to the push direction.
 *
 * Four branching lineages make the network exactly periodic: in each, a
 * filament spawns one daughter 20 nm under the membrane and is later
 * capped, so the pattern repeats every 120 nm of advance (2 × 60 nm at
 * 6 nm/s: one 20 s loop).
 */

const SPEED = 6; // nm/s: network flow (= membrane advance)
const RISE_PER_BIRTH = 60; // nm of advance between births in one lineage
const TIP_GAP = 3; // growing barbed ends stay this close to the membrane
const FAST = 3; // a new branch grows 3× faster until it reaches the membrane
const ARRIVE = 7; // Arp2/3 arrives over this much advance before nucleating
const TILT = THREE.MathUtils.degToRad(35);
const COS = Math.cos(TILT);
const TAN = Math.tan(TILT);
const STEP_Y = ACTIN.rise * COS; // vertical rise per subunit
const Y_MEMBRANE = 150; // inner face of the plasma membrane
const MEMBRANE_WIDTH = 270;
const MEMBRANE_DEPTH = 140;
const SLOTS = 6; // filaments drawn per lineage (≥ lifetime / spacing, even)

const ATP = new THREE.Color('#fff0f0');
const ADP_PI = new THREE.Color('#ff9f9f');
const ADP = new THREE.Color('#b56b6b');

interface Lineage {
  x: number;
  z: number;
  /** Out-of-plane turn of this lineage's filaments (the 70° branch angle is kept). */
  phi: number;
  offset: number;
  /** Arp2/3 binds the mother this far under the membrane. */
  branchDepth: number;
  /** A filament is capped after this much advance. */
  capAt: number;
  /** Depth (below the membrane) where pointed ends come apart, for even/odd generations. */
  front: [number, number];
  /** Most subunits a filament of this lineage reaches. */
  maxSubunits: number;
}

const lineage = (x: number, z: number, phiDeg: number, offset: number, branchDepth: number, capAt: number, front: [number, number]): Lineage => ({
  x,
  z,
  phi: THREE.MathUtils.degToRad(phiDeg),
  offset,
  branchDepth,
  capAt,
  front,
  maxSubunits: Math.floor((branchDepth - TIP_GAP + capAt) / COS / ACTIN.rise),
});

const LINEAGES: Lineage[] = [
  lineage(-90, -16, 34, 0, 18, RISE_PER_BIRTH + 22, [204, 218]),
  lineage(-26, 20, -50, RISE_PER_BIRTH / 4, 27, RISE_PER_BIRTH + 10, [214, 198]),
  lineage(36, -24, 18, RISE_PER_BIRTH / 2, 21, RISE_PER_BIRTH + 30, [200, 222]),
  lineage(92, 10, -30, (3 * RISE_PER_BIRTH) / 4, 24, RISE_PER_BIRTH + 16, [220, 206]),
];

/** Filament length (nm) after `h` nm of advance since its branch was born. */
const lengthAt = (l: Lineage, h: number) => (h <= 0 ? 0 : Math.min(FAST * h, l.branchDepth - TIP_GAP + Math.min(h, l.capAt)) / COS);
/** Advance at which subunit i (0 = pointed end) was added. */
const addedAt = (l: Lineage, i: number) => {
  const need = (i + 1) * ACTIN.rise * COS;
  const fastLimit = (FAST * (l.branchDepth - TIP_GAP)) / (FAST - 1);
  return need <= fastLimit ? need / FAST : need - (l.branchDepth - TIP_GAP);
};

const colorForAge = (age: number, target: THREE.Color) => {
  if (age < 3) return target.copy(ATP).lerp(ADP_PI, ramp(age, 0.4, 3));
  return target.copy(ADP_PI).lerp(ADP, ramp(age, 3, 11));
};

interface Slot {
  lineage: Lineage;
  index: number;
  parity: 0 | 1;
  dir: THREE.Vector3;
  filament: ActinFilament;
  /** Current generation state (updated per frame). */
  h: number;
  active: boolean;
  from: number;
  count: number;
  base: THREE.Vector3;
}

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#140d1c');
  const q = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);

  // ── Filament slots (kit actin filaments along straight lines) ─────────
  const slots: Slot[] = [];
  LINEAGES.forEach((lineage, li) => {
    for (let k = 0; k < SLOTS; k++) {
      const parity = (k % 2) as 0 | 1;
      const sign = parity === 0 ? 1 : -1;
      const dir = new THREE.Vector3(sign * Math.sin(TILT) * Math.cos(lineage.phi), COS, sign * Math.sin(TILT) * Math.sin(lineage.phi)).normalize();
      const curve = new THREE.LineCurve3(new THREE.Vector3(), dir.clone().multiplyScalar((lineage.maxSubunits + 0.01) * ACTIN.rise));
      const filament = actinFilament({ curve, quality: q, color: '#ff9f9f', seed: `leading-edge-${li}-${k}` });
      filament.setVisibleRange(0, 0);
      root.add(filament.mesh);
      slots.push({ lineage, index: k, parity, dir, filament, h: 0, active: false, from: 0, count: 0, base: new THREE.Vector3() });
    }
  });

  // ── Arp2/3 complexes (one per slot: the branch that started it) ───────
  const arpGeometry = noisyEllipsoid(new THREE.Vector3(5.6, 4.6, 4.9), q === 'low' ? 2 : 3, new Simplex3('arp23'), 0.2, 1.3, 3);
  const arpMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(arpMaterial, 0.22, 'arp23');
  const arps = instanced(
    arpGeometry,
    arpMaterial,
    slots.map(() => ({ position: new THREE.Vector3(), color: '#ff9e3d' })),
  );
  arps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(arps);

  // ── Free subunits: one arriving at each growing barbed end, one leaving each pointed end ─
  const subunitGeometry = blobGeometry(1, 'leading-edge-free', 0.16, q === 'high' ? 2 : 1);
  subunitGeometry.scale(1, 0.75, 0.9);
  const freeMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(freeMaterial, 0.2, 'actinFree');
  const freeSubunits = instanced(
    subunitGeometry,
    freeMaterial,
    Array.from({ length: slots.length * 2 }, (_, i) => ({ position: new THREE.Vector3(), color: i % 2 === 0 ? ATP : ADP })),
  );
  freeSubunits.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(freeSubunits);

  // ── Plasma membrane: a slab across the top with banded cut edges ──────
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(MEMBRANE_WIDTH, 5, MEMBRANE_DEPTH, 1, 1, 1),
    membraneMaterial('#8aa6ff', { opacity: 1, rim: 0.35 }),
  );
  slab.position.set(0, Y_MEMBRANE + 2.5, 0);
  root.add(slab);
  const strips: THREE.BufferGeometry[] = [];
  for (const [w, x, z, ry] of [
    [MEMBRANE_WIDTH, 0, MEMBRANE_DEPTH / 2 + 0.06, 0],
    [MEMBRANE_WIDTH, 0, -MEMBRANE_DEPTH / 2 - 0.06, Math.PI],
    [MEMBRANE_DEPTH, MEMBRANE_WIDTH / 2 + 0.06, 0, Math.PI / 2],
    [MEMBRANE_DEPTH, -MEMBRANE_WIDTH / 2 - 0.06, 0, -Math.PI / 2],
  ] as const) {
    const g = bilayerStripGeometry(w, 5.1);
    g.rotateY(ry);
    g.translate(x, Y_MEMBRANE + 2.5, z);
    strips.push(g);
  }
  const edge = new THREE.Mesh(mergeGeometries(strips)!, bandMaterial());
  strips.forEach((g) => g.dispose());
  root.add(edge);

  // ── Per-frame state ───────────────────────────────────────────────────
  const m4 = new THREE.Matrix4();
  const qa = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const col = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const side = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  let advance = 0;

  /** Advance since the current generation of slot k of a lineage was born (slots are reused every 8 generations). */
  const ageOf = (lineage: Lineage, k: number, H: number) => {
    const n = k + SLOTS * Math.floor((H - lineage.offset + ARRIVE - k * RISE_PER_BIRTH) / (SLOTS * RISE_PER_BIRTH));
    return H - (lineage.offset + n * RISE_PER_BIRTH);
  };

  const updateNetwork = (t: number, calm: boolean) => {
    advance = SPEED * t;
    for (let si = 0; si < slots.length; si++) {
      const slot = slots[si];
      const { lineage, parity, filament } = slot;
      const h = ageOf(lineage, slot.index, advance);
      const front = lineage.front[parity];
      const half = 0.5 * RISE_PER_BIRTH * TAN;
      const sign = parity === 0 ? -1 : 1;
      // Branch point (pointed end) of this generation: it was born 20 nm under the membrane and has flowed down since.
      const depth = lineage.branchDepth;
      slot.base.set(lineage.x + sign * half * Math.cos(lineage.phi), Y_MEMBRANE - depth - h, lineage.z + sign * half * Math.sin(lineage.phi));
      filament.mesh.position.copy(slot.base);
      const count = Math.min(lineage.maxSubunits, Math.floor(lengthAt(lineage, h) / ACTIN.rise + 1e-6));
      const from = THREE.MathUtils.clamp(Math.ceil((depth + h - front) / STEP_Y - 0.5), 0, count);
      slot.h = h;
      slot.count = count;
      slot.from = from;
      slot.active = count > from;
      filament.setVisibleRange(from, count);
      // Age colours: bright ATP-actin at the barbed end, dull ADP-actin further back.
      for (let i = from; i < count; i++) filament.setColor(i, colorForAge((h - addedAt(lineage, i)) / SPEED, col));

      // Arp2/3: arrives from the membrane side, holds the branch, lets go deep in the network.
      const debranch = front - 6 - depth;
      let arpScale: number;
      v1.copy(slot.base).addScaledVector(slot.dir, 2.2);
      if (h < 0) {
        const k = easeInOut((h + ARRIVE) / ARRIVE);
        arpScale = ramp(k, 0, 0.35);
        v1.y += 16 * (1 - k);
        v1.z += 8 * (1 - k);
      } else if (h < debranch) {
        arpScale = 1;
      } else {
        const a = (h - debranch) / SPEED;
        arpScale = 1 - ramp(a, 0.4, 1.6);
        v1.y -= 5 * a;
        v1.x += 2 * a * (parity === 0 ? 1 : -1);
      }
      qa.setFromAxisAngle(slot.dir, si * 1.3);
      arps.setMatrixAt(si, arpScale < 0.02 ? zero : m4.compose(v1, qa, sv.setScalar(arpScale)));

      // An ATP-actin arriving at the barbed end while it grows.
      const next = count;
      if (h >= 0 && h < lineage.capAt && next < lineage.maxSubunits) {
        const at = addedAt(lineage, next);
        const prev = next > 0 ? addedAt(lineage, next - 1) : 0;
        const window = Math.max(0.5, 0.65 * (at - prev));
        const k = (h - (at - window)) / window;
        if (k > 0 && k < 1) {
          const e = easeInOut(k);
          v2.copy(filament.positions[next]).add(slot.base);
          side.set(-slot.dir.y, slot.dir.x, 0.35).normalize();
          v2.addScaledVector(side, 9 * (1 - e) * (si % 2 ? 1 : -1)).addScaledVector(slot.dir, -2 * (1 - e));
          tilt.setFromAxisAngle(side, (1 - e) * 2);
          freeSubunits.setMatrixAt(si * 2, m4.compose(v2, tilt, sv.setScalar(ACTIN.subunitRadius * ramp(k, 0, 0.3))));
        } else {
          freeSubunits.setMatrixAt(si * 2, zero);
        }
      } else {
        freeSubunits.setMatrixAt(si * 2, zero);
      }

      // The last ADP-actin to come off the pointed end, drifting away.
      if (from > 0 && from <= count + 1) {
        const j = from - 1;
        const removedAt = front - depth + (j + 0.5) * STEP_Y;
        const a = (h - removedAt) / SPEED;
        if (a >= 0 && a < 1.6) {
          const fall = calm ? 0.6 : 1;
          v2.copy(filament.positions[j]).add(slot.base);
          v2.y -= 7 * a * fall;
          v2.x += 3 * a * fall * (parity === 0 ? -1 : 1);
          v2.z += 2.5 * a * fall;
          tilt.setFromAxisAngle(slot.dir, a * 1.5);
          freeSubunits.setMatrixAt(si * 2 + 1, m4.compose(v2, tilt, sv.setScalar(ACTIN.subunitRadius * (1 - ramp(a, 0.9, 1.6)))));
        } else {
          freeSubunits.setMatrixAt(si * 2 + 1, zero);
        }
      } else {
        freeSubunits.setMatrixAt(si * 2 + 1, zero);
      }
    }
    arps.instanceMatrix.needsUpdate = true;
    freeSubunits.instanceMatrix.needsUpdate = true;
  };

  // ── Labels: follow one lineage's filaments, hopping to the next generation every 10 s ─
  const anchors = {
    barbed: new THREE.Vector3(),
    pointed: new THREE.Vector3(),
    arp: new THREE.Vector3(),
    filament: new THREE.Vector3(),
    subunit: new THREE.Vector3(),
  };
  let subunitVisible = false;
  /** The active slot of a lineage whose age lies in [lo, hi) (optionally of one parity), or −1. */
  const pick = (lineage: Lineage, lo: number, hi: number, parity = -1) => {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.lineage === lineage && s.active && s.h >= lo && s.h < hi && (parity < 0 || s.parity === parity)) return i;
    }
    return -1;
  };
  const updateAnchors = () => {
    const growing = pick(LINEAGES[0], 12, 12 + RISE_PER_BIRTH);
    if (growing >= 0) {
      const s = slots[growing];
      anchors.barbed.copy(s.filament.positions[s.count - 1]).add(s.base).z += 3;
    }
    // Pointed end: a filament that is losing subunits (its age is past the depth where they come apart).
    let shedding = -1;
    for (let i = 0; i < slots.length && shedding < 0; i++) if (slots[i].lineage === LINEAGES[3] && slots[i].active && slots[i].from > 0 && slots[i].parity === 0) shedding = i;
    for (let i = 0; i < slots.length && shedding < 0; i++) if (slots[i].lineage === LINEAGES[3] && slots[i].active && slots[i].from > 0) shedding = i;
    subunitVisible = false;
    if (shedding >= 0) {
      const s = slots[shedding];
      anchors.pointed.copy(s.filament.positions[s.from]).add(s.base).z += 3;
      freeSubunits.getMatrixAt(shedding * 2 + 1, m4);
      v1.setFromMatrixScale(m4);
      if (v1.x > 0.5) {
        anchors.subunit.setFromMatrixPosition(m4);
        subunitVisible = true;
      }
    }
    const branched = pick(LINEAGES[1], 4, 4 + RISE_PER_BIRTH);
    if (branched >= 0) {
      arps.getMatrixAt(branched, m4);
      anchors.arp.setFromMatrixPosition(m4).z += 4;
    }
    const middle = pick(LINEAGES[0], 50, 50 + 2 * RISE_PER_BIRTH, 1);
    if (middle >= 0) {
      const s = slots[middle];
      anchors.filament.copy(s.filament.positions[Math.max(s.from, Math.floor((s.from + s.count) / 2))]).add(s.base).z += 3;
    }
  };

  const cortexAnchor = new THREE.Vector3(-118, 40, 24);
  const membraneAnchor = new THREE.Vector3(-96, Y_MEMBRANE + 2.5, MEMBRANE_DEPTH / 2);
  const DEBUG = new URLSearchParams(window.location.search);
  const DEBUG_T = Number(DEBUG.get('cut') ?? 'NaN');
  const DEBUG_R = Number(DEBUG.get('cur') ?? 'NaN');
  const DEBUG_C = (DEBUG.get('cuc') ?? '').split(',').map(Number);
  const update = (t: number, calm: boolean) => {
    updateNetwork(t, calm);
    updateAnchors();
  };
  update(0, false);

  return {
    scene,
    views: [
      {
        target: DEBUG_C.length === 3 ? new THREE.Vector3(DEBUG_C[0], DEBUG_C[1], DEBUG_C[2]) : new THREE.Vector3(0, 62, 0),
        radius: Number.isFinite(DEBUG_R) ? DEBUG_R : 140,
        direction: new THREE.Vector3(0.05, 0.24, 1).normalize(),
        labels: [
          { part: 'barbed-end', anchor: () => anchors.barbed },
          { part: 'arp23', anchor: () => anchors.arp },
          { part: 'pointed-end', anchor: () => anchors.pointed },
          { part: 'filament', anchor: () => anchors.filament },
          { part: 'subunit', anchor: () => anchors.subunit, visible: () => subunitVisible },
          { part: 'cortex', anchor: () => cortexAnchor },
          { textKey: 'structures.plasma-membrane.name', anchor: () => membraneAnchor },
        ],
      },
    ],
    setView() {},
    update(_dt, time, calm) {
      const dbg = window as unknown as { __cut?: number };
      update(dbg.__cut ?? (Number.isFinite(DEBUG_T) ? DEBUG_T : time), calm);
    },
    dispose() {
      slots.forEach((s) => s.filament.dispose());
      disposeScene(scene);
    },
  };
};

export default create;
