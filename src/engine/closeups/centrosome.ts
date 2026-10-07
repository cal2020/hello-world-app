import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { mergeGeometries, noisyEllipsoid } from '../core/geometry';
import { createCloseupScene, disposeScene } from './common';
import { addInstanceGlow, byQuality, instanced, instancedMaterial, moleculeMaterial, sparks, type Placement } from './kit';
import { mod, ramp } from './cytoskeletonParts';
import type { CloseupFactory } from './types';

/**
 * A pair of centrioles in a G1 cell (1 unit = 10 nm). Each centriole is a
 * 250 nm-wide barrel of nine microtubule triplets (complete A tubule plus
 * partial B and C tubules; C stops short, leaving distal doublets) tilted
 * like a pinwheel. The 500 nm mother carries nine distal and nine subdistal
 * appendages; the slightly shorter daughter lies at right angles beside the
 * mother's proximal end. Around them the pericentriolar material (a faint
 * cloud) holds γ-tubulin ring complexes, from which microtubules grow
 * outward with bright tips, now and then shrink back, and regrow (20 s loop).
 */

const LOOP = 20;
const TUBE_R = 1.25; // 25 nm microtubule
const TUBE_IN = 0.78;
const SPACING = 2.0; // A–B and B–C centre distance
const A_RADIUS = 8.3; // A-tubule centres: barrel ≈ 25.6 units (256 nm) across
const BLADE_TILT = THREE.MathUtils.degToRad(45); // triplet blade vs. the barrel's tangent
const MOTHER_LENGTH = 50;
const DAUGHTER_LENGTH = 44;

const CENTRIOLE = '#d9ccff';
const APPENDAGE = '#efe8ff';
const GTURC = '#ffb46b';
const MICROTUBULE = '#9bd4ff';
const TIP = '#f2fbff';

/** One triplet (A complete, B and C partial) in its own frame: A at the origin, the blade along +x, extruded along +z. */
function tripletGeometry(length: number, cLength: number, quality: QualityLevel): THREE.BufferGeometry {
  const curveSegments = quality === 'low' ? 7 : 11;
  const opts = (depth: number): THREE.ExtrudeGeometryOptions => ({ depth, bevelEnabled: false, curveSegments, steps: 1 });
  const a = new THREE.Shape();
  a.absarc(0, 0, TUBE_R, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, TUBE_IN, 0, Math.PI * 2, true);
  a.holes.push(hole);
  // A partial tubule: its wall stops where it meets the previous tubule's outer wall.
  const partial = (cx: number) => {
    const outer = Math.acos(-SPACING / (2 * TUBE_R));
    const inner = Math.acos(THREE.MathUtils.clamp((TUBE_R * TUBE_R - SPACING * SPACING - TUBE_IN * TUBE_IN) / (2 * SPACING * TUBE_IN), -1, 1));
    const s = new THREE.Shape();
    s.moveTo(cx + Math.cos(-outer) * TUBE_R, Math.sin(-outer) * TUBE_R);
    s.absarc(cx, 0, TUBE_R, -outer, outer, false);
    s.lineTo(cx + Math.cos(inner) * TUBE_IN, Math.sin(inner) * TUBE_IN);
    s.absarc(cx, 0, TUBE_IN, inner, -inner, true);
    s.closePath();
    return s;
  };
  const parts = [
    new THREE.ExtrudeGeometry(a, opts(length)),
    new THREE.ExtrudeGeometry(partial(SPACING), opts(length)),
    new THREE.ExtrudeGeometry(partial(SPACING * 2), opts(cLength)),
  ];
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

interface Centriole {
  group: THREE.Group;
  length: number;
  /** World point at axial position z (local units) and radial direction angle. */
  surface(z: number, towards: THREE.Vector3, radius: number, target: THREE.Vector3): THREE.Vector3;
}

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#100c22');
  const q = ctx.quality;
  const rng = new Rng('closeup:centrosome');
  const root = new THREE.Group();
  scene.add(root);

  // ── Frames: mother axis tipped toward the viewer; daughter at right angles ─
  const view = new THREE.Vector3(0.1, 0.32, 1).normalize();
  // The mother's distal end faces the viewer at ~35°: its pinwheel of triplets and ring of
  // appendages show end-on. The daughter lies across the view beside the mother's proximal end.
  const screenUp = new THREE.Vector3(0, 1, 0).addScaledVector(view, -view.y).normalize();
  const M = view.clone().multiplyScalar(Math.cos(0.61)).addScaledVector(screenUp, Math.sin(0.61)).normalize();
  const D = new THREE.Vector3(1, 0, -0.05);
  D.addScaledVector(M, -D.dot(M)).normalize();

  const centrioleMaterial = moleculeMaterial(CENTRIOLE, { roughness: 0.5, emissiveIntensity: 0.18 });
  const makeCentriole = (axis: THREE.Vector3, proximal: THREE.Vector3, length: number, cLength: number): Centriole => {
    const group = new THREE.Group();
    group.position.copy(proximal);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const placements: Placement[] = [];
    for (let k = 0; k < 9; k++) {
      const alpha = (k / 9) * Math.PI * 2;
      const radial = new THREE.Vector3(Math.cos(alpha), Math.sin(alpha), 0);
      const tangent = new THREE.Vector3(-Math.sin(alpha), Math.cos(alpha), 0);
      const blade = tangent.clone().multiplyScalar(Math.cos(BLADE_TILT)).addScaledVector(radial, Math.sin(BLADE_TILT));
      placements.push({
        position: radial.clone().multiplyScalar(A_RADIUS),
        quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(blade.y, blade.x)),
      });
    }
    group.add(instanced(tripletGeometry(length, cLength, q), centrioleMaterial, placements));
    root.add(group);
    const local = new THREE.Vector3();
    const inv = new THREE.Quaternion().copy(group.quaternion).invert();
    return {
      group,
      length,
      surface(z, towards, radius, target) {
        // Radial direction in the centriole's frame closest to `towards`.
        local.copy(towards).applyQuaternion(inv);
        local.z = 0;
        local.normalize().multiplyScalar(radius);
        local.z = z;
        return target.copy(local).applyQuaternion(group.quaternion).add(group.position);
      },
    };
  };
  const motherProximal = M.clone().multiplyScalar(-MOTHER_LENGTH / 2);
  const mother = makeCentriole(M, motherProximal, MOTHER_LENGTH, 40);
  const daughterProximal = motherProximal.clone().addScaledVector(M, 9).addScaledVector(D, 14.6);
  const daughter = makeCentriole(D, daughterProximal, DAUGHTER_LENGTH, 36);

  // ── Appendages on the mother's distal end: nine distal blades, nine subdistal knobs ─
  const bladeGeometry = new THREE.BoxGeometry(7.2, 0.55, 2.4);
  bladeGeometry.translate(3.6, 0, 0);
  const appendageMaterial = moleculeMaterial(APPENDAGE, { roughness: 0.55, emissiveIntensity: 0.2 });
  const blades: Placement[] = [];
  const stalks: Placement[] = [];
  const knobs: Placement[] = [];
  for (let k = 0; k < 9; k++) {
    const alpha = (k / 9) * Math.PI * 2 + 0.35;
    const radial = new THREE.Vector3(Math.cos(alpha), Math.sin(alpha), 0);
    // Distal appendage: a blade leaning distally, rooted on the outer tubules.
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), alpha);
    q1.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.38));
    q1.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.45));
    blades.push({ position: radial.clone().multiplyScalar(11.2).setZ(MOTHER_LENGTH - 1.6), quaternion: q1 });
    // Subdistal appendage: a shorter strut with a knob (where microtubules anchor).
    const q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), alpha + 0.2);
    stalks.push({ position: radial.clone().multiplyScalar(11.4).setZ(MOTHER_LENGTH - 11), quaternion: q2, scale: new THREE.Vector3(0.62, 0.9, 0.55) });
    const r2 = new THREE.Vector3(Math.cos(alpha + 0.2), Math.sin(alpha + 0.2), 0);
    knobs.push({ position: r2.multiplyScalar(16.4).setZ(MOTHER_LENGTH - 11), scale: 1.15 });
  }
  const knobGeometry = noisyEllipsoid(new THREE.Vector3(1.2, 1.1, 1.0), q === 'low' ? 1 : 2, new Simplex3('sda-knob'), 0.2, 1.5, 2);
  const appendageMeshes = [
    instanced(bladeGeometry, appendageMaterial, blades),
    instanced(bladeGeometry, appendageMaterial, stalks),
    instanced(knobGeometry, appendageMaterial, knobs),
  ];
  appendageMeshes.forEach((m) => mother.group.add(m));

  // ── Pericentriolar material: a faint lavender cloud, densest around the mother's proximal half ─
  const pcmCentre = new THREE.Vector3().addScaledVector(M, -8).addScaledVector(D, 3);
  const pcmCount = byQuality(q, { low: 3200, medium: 4600, high: 6000 });
  const pcm = sparks(pcmCount, '#8f7fff', 2.3, ctx.pointScale);
  const p = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const insideCentriole = (point: THREE.Vector3, c: Centriole, axis: THREE.Vector3, proximal: THREE.Vector3) => {
    rel.subVectors(point, proximal);
    const z = rel.dot(axis);
    if (z < -1.5 || z > c.length + 1.5) return false;
    return rel.addScaledVector(axis, -z).length() < 14;
  };
  let placed = 0;
  for (let i = 0; placed < pcmCount && i < pcmCount * 6; i++) {
    // Toroid-like shell around the mother's axis plus a softer halo.
    const along = rng.range(-26, 14);
    const angle = rng.range(0, Math.PI * 2);
    const radius = 13 + Math.abs(rng.gaussian()) * 8;
    const u = new THREE.Vector3(1, 0, 0).addScaledVector(M, -M.x).normalize();
    const w = new THREE.Vector3().crossVectors(M, u);
    p.copy(M).multiplyScalar(along).addScaledVector(u, Math.cos(angle) * radius).addScaledVector(w, Math.sin(angle) * radius);
    p.addScaledVector(rng.direction(rel), rng.range(0, 4));
    if (insideCentriole(p, mother, M, motherProximal) || insideCentriole(p, daughter, D, daughterProximal)) continue;
    pcm.positions[placed * 3] = p.x;
    pcm.positions[placed * 3 + 1] = p.y;
    pcm.positions[placed * 3 + 2] = p.z;
    pcm.alphas[placed] = rng.range(0.06, 0.2);
    placed++;
  }
  for (let i = placed; i < pcmCount; i++) pcm.alphas[i] = 0;
  pcm.commit();
  const pcmGroup = new THREE.Group();
  pcmGroup.add(pcm.points);
  root.add(pcmGroup);

  // ── γ-tubulin ring complexes and the microtubules they nucleate ───────
  const ringCount = byQuality(q, { low: 26, medium: 32, high: 38 });
  const mtCount = byQuality(q, { low: 16, medium: 20, high: 24 });
  interface Ring {
    position: THREE.Vector3;
    normal: THREE.Vector3;
  }
  const rings: Ring[] = [];
  const u0 = new THREE.Vector3(1, 0, 0).addScaledVector(M, -M.x).normalize();
  const w0 = new THREE.Vector3().crossVectors(M, u0);
  for (let i = 0; rings.length < ringCount && i < 2000; i++) {
    const along = rng.range(-24, 12);
    const angle = rng.range(0, Math.PI * 2);
    const radius = rng.range(15, 22);
    const outward = u0.clone().multiplyScalar(Math.cos(angle)).addScaledVector(w0, Math.sin(angle));
    const position = M.clone().multiplyScalar(along).addScaledVector(outward, radius);
    if (rings.some((r) => r.position.distanceTo(position) < 5)) continue;
    if (insideCentriole(position, daughter, D, daughterProximal)) continue;
    // Microtubules leave roughly outward (and somewhat along the mother's axis), never into the daughter.
    const normal = outward.clone().addScaledVector(M, rng.range(-0.4, 0.5)).addScaledVector(rng.direction(), 0.25).normalize();
    if (normal.dot(D) > 0.82) continue;
    rings.push({ position, normal });
  }
  const ringGeometry = new THREE.TorusGeometry(1.0, 0.36, q === 'low' ? 5 : 7, q === 'low' ? 12 : 16);
  const ringMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(ringMaterial, 0.45, 'gturc');
  const ringMesh = instanced(
    ringGeometry,
    ringMaterial,
    rings.map((r) => ({
      position: r.position,
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.normal),
      color: GTURC,
    })),
  );
  root.add(ringMesh);

  // Microtubules: the rings facing the viewer's half get one each (minus end capped by the ring).
  const order = rings
    // Prefer rings whose microtubule would run across the screen (not straight at or away from the viewer).
    .map((r, i) => ({ i, score: -Math.abs(r.normal.dot(view)) + rng.range(-0.35, 0.35) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, mtCount)
    .map((e) => e.i);
  // The labelled new microtubule: one growing down and to the left, into open space.
  const screenRight = new THREE.Vector3().crossVectors(screenUp, view).normalize();
  let newest = 0;
  order.forEach((ring, k) => {
    const score = (n: THREE.Vector3) => -n.dot(screenRight) * 0.7 - n.dot(screenUp) * 0.5 - Math.abs(n.dot(view)) * 0.6;
    if (score(rings[ring].normal) > score(rings[order[newest]].normal)) newest = k;
  });
  [order[0], order[newest]] = [order[newest], order[0]];
  interface Tube {
    ring: number;
    phase: number;
    speed: number;
    min: number;
    quaternion: THREE.Quaternion;
  }
  const tubes: Tube[] = order.map((ring, i) => ({
    ring,
    phase: i === 0 ? 0 : rng.range(0, LOOP),
    speed: rng.range(1.8, 2.8), // units/s (18–28 nm/s, illustrative)
    min: i === 0 || rng.chance(0.3) ? 0 : rng.range(3, 10),
    quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), rings[ring].normal),
  }));
  const tubeGeometry = new THREE.CylinderGeometry(TUBE_R, TUBE_R, 1, q === 'low' ? 10 : 14, 1, true);
  tubeGeometry.translate(0, 0.5, 0);
  const tubeMaterial = moleculeMaterial(MICROTUBULE, { roughness: 0.45, emissiveIntensity: 0.2, side: THREE.DoubleSide });
  const tubeMesh = instanced(tubeGeometry, tubeMaterial, tubes.map(() => ({ position: new THREE.Vector3() })));
  tubeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const tipGeometry = new THREE.CylinderGeometry(TUBE_R * 1.05, TUBE_R * 1.05, 2.2, q === 'low' ? 10 : 14);
  tipGeometry.translate(0, -1.1, 0);
  const tipMaterial = moleculeMaterial(TIP, { roughness: 0.3, emissiveIntensity: 0.65 });
  const tipMesh = instanced(tipGeometry, tipMaterial, tubes.map(() => ({ position: new THREE.Vector3() })));
  tipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(tubeMesh, tipMesh);

  // ── Per-frame ─────────────────────────────────────────────────────────
  const m4 = new THREE.Matrix4();
  const sv = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const lengths = new Float32Array(tubes.length);
  const growing = new Uint8Array(tubes.length);
  let newTubeVisible = false;
  const newTubeAnchor = new THREE.Vector3();

  /** Each microtubule grows for 15 s, then shrinks three times faster for 5 s (back to a stub, or right back to its ring and renucleates). */
  const update = (t: number, calm: boolean) => {
    for (let i = 0; i < tubes.length; i++) {
      const tube = tubes[i];
      const local = mod(t + tube.phase, LOOP);
      const grow = 15;
      const max = tube.min + tube.speed * grow;
      const isGrowing = local < grow;
      const length = isGrowing ? tube.min + tube.speed * local : max - (max - tube.min) * ((local - grow) / (LOOP - grow));
      lengths[i] = length;
      growing[i] = isGrowing ? 1 : 0;
      const base = rings[tube.ring].position;
      tubeMesh.setMatrixAt(i, length < 0.3 ? zero : m4.compose(base, tube.quaternion, sv.set(1, length, 1)));
      // Bright GTP tip while growing (fades in as the tube appears, gone while shrinking).
      const tip = isGrowing ? ramp(length, 0.5, 2.5) : 0;
      v1.copy(rings[tube.ring].normal).multiplyScalar(length).add(base);
      tipMesh.setMatrixAt(i, tip < 0.05 ? zero : m4.compose(v1, tube.quaternion, sv.set(1, Math.min(1, length / 2.2), 1)));
    }
    tubeMesh.instanceMatrix.needsUpdate = true;
    tipMesh.instanceMatrix.needsUpdate = true;
    // The labelled new microtubule (index 0 starts from its ring every loop).
    newTubeVisible = growing[0] === 1 && lengths[0] > 6;
    newTubeAnchor.copy(rings[tubes[0].ring].normal).multiplyScalar(Math.min(14, lengths[0] * 0.55)).add(rings[tubes[0].ring].position);
    // The PCM cloud shimmers very slowly.
    pcmGroup.setRotationFromAxisAngle(M, Math.sin(t * 0.05) * (calm ? 0.01 : 0.03));
  };

  // ── Labels ────────────────────────────────────────────────────────────
  const motherAnchor = mother.surface(30, view, 13, new THREE.Vector3());
  const daughterAnchor = daughter.surface(24, view, 13, new THREE.Vector3());
  // A triplet on the front of the mother's barrel, where all three tubules run (the C tubule stops short of the distal end).
  const tripletAnchor = mother.surface(34, view.clone().addScaledVector(D, -0.6), 12.4, new THREE.Vector3());
  const appendageAnchor = mother.surface(MOTHER_LENGTH - 1, screenUp.clone().negate().addScaledVector(D, -1), 17.5, new THREE.Vector3());
  const pcmAnchor = pcmCentre.clone().addScaledVector(D, -16).addScaledVector(view, 14).addScaledVector(M, -6);
  let frontRing = 0;
  rings.forEach((r, i) => {
    const score = r.position.clone().sub(pcmCentre).dot(view) - Math.abs(r.position.clone().sub(pcmCentre).dot(D)) * 0.4;
    const best = rings[frontRing].position.clone().sub(pcmCentre).dot(view) - Math.abs(rings[frontRing].position.clone().sub(pcmCentre).dot(D)) * 0.4;
    if (score > best && !order.slice(0, 1).includes(i)) frontRing = i;
  });
  const ringAnchor = rings[frontRing].position.clone().addScaledVector(view, 1.2);

  update(0, false);

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(16, 0, 0),
        radius: 65,
        direction: view.clone(),
        labels: [
          { part: 'mother-centriole', anchor: () => motherAnchor },
          { part: 'daughter-centriole', anchor: () => daughterAnchor },
          { part: 'triplets', anchor: () => tripletAnchor },
          { part: 'appendages', anchor: () => appendageAnchor },
          { part: 'pcm', anchor: () => pcmAnchor },
          { part: 'gamma-turc', anchor: () => ringAnchor },
          { textKey: 'closeupCaptions.newMicrotubule', anchor: () => newTubeAnchor, visible: () => newTubeVisible },
        ],
      },
    ],
    setView() {},
    update(_dt, time, calm) {
      update(time, calm);
    },
    dispose() {
      pcm.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
