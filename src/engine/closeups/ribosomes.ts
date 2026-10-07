import * as THREE from 'three';
import { Rng } from '../core/random';
import { createCloseupScene, disposeScene, smooth } from './common';
import {
  addInstanceGlow,
  addJiggle,
  anchorOn,
  createJiggle,
  instancedMaterial,
  moleculeMaterial,
  singleStrand,
  setSeeds,
  sparks,
  trnaGeometry,
} from './kit';
import {
  ACCEPTOR_LOCAL,
  ANTICODON_LOCAL,
  CODON,
  FRAME,
  largeSubunitGeometry,
  sitePoses,
  smallSubunitGeometry,
  TRNA_SCALE,
  type TrnaPose,
} from './ribosomesParts';
import { hash01 } from './nucleolusParts';
import { fineCurve } from './telomeresParts';
import type { CloseupFactory } from './types';

/**
 * Translation (1 unit = 1 nm, slowdown 10): an 80S ribosome ~30 nm across.
 * One elongation cycle takes 2 s (real ≈ 0.2 s): an aminoacyl-tRNA arrives
 * in the A site with its anticodon on the codon, the growing chain is
 * transferred from the P-site tRNA onto its amino acid (peptide bond), then
 * the mRNA advances one codon and the tRNAs shift A → P → E; the empty
 * E-site tRNA drifts away. The chain runs from the P-site tRNA up the exit
 * tunnel and out of the large subunit, loosely folding; residues older than
 * ~60 merge into a folded blob.
 */

const CYCLE = 2;
/** Cycle phases (fractions of CYCLE). */
const PH = {
  arriveEnd: 0.34,
  bondStart: 0.44,
  bondEnd: 0.6,
  moveStart: 0.62,
  moveEnd: 0.9,
  leaveEnd: 0.42,
};
const VISIBLE_RESIDUES = 60;
const BEAD_RADIUS = 0.5;
const BEAD_SPACING = 0.74;

/** Amino-acid classes: bead colour (saturated) and tRNA body colour (pastel). */
const AA_CLASSES = [
  { bead: '#f2b33d', trna: '#ffd27f' }, // hydrophobic
  { bead: '#4d86ff', trna: '#9cc0ff' }, // positively charged
  { bead: '#ff5252', trna: '#ff9c94' }, // negatively charged
  { bead: '#3fcf86', trna: '#93e8bb' }, // polar
  { bead: '#c4b2ff', trna: '#ddd2ff' }, // glycine / proline
].map((c) => ({ bead: new THREE.Color(c.bead), trna: new THREE.Color(c.trna) }));
const CLASS_WEIGHTS = [0.4, 0.15, 0.15, 0.22, 0.08];
const CODON_COLORS = ['#ff86c0', '#7fdcff', '#c3f07a', '#ffc46b'].map((c) => new THREE.Color(c));

function aaClass(residue: number): number {
  let x = hash01(((residue % 211) + 211) % 211, 3);
  for (let i = 0; i < CLASS_WEIGHTS.length; i++) {
    if (x < CLASS_WEIGHTS[i]) return i;
    x -= CLASS_WEIGHTS[i];
  }
  return 0;
}

function codonColor(codon: number): THREE.Color {
  return CODON_COLORS[((codon % 4) + 4) % 4];
}

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#151024');
  const rng = new Rng('closeup:ribosomes');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);

  // ── Ribosome ────────────────────────────────────────────────────────────
  const small = new THREE.Mesh(smallSubunitGeometry(quality), moleculeMaterial('#f6d58c', { roughness: 0.55 }));
  root.add(small);
  // Large subunit cut away at the front (z > CUT) so the tRNAs in the intersubunit
  // space show: the back half stays (outer surface, and a darker inside surface
  // seen through the cut).
  const CUT = 1.2;
  const keepBack = [new THREE.Plane(new THREE.Vector3(0, 0, -1), CUT)];
  const largeGeometry = largeSubunitGeometry(quality);
  const largeOuter = new THREE.Mesh(largeGeometry, moleculeMaterial('#e3a83a', { roughness: 0.55, clippingPlanes: keepBack }));
  const largeInner = new THREE.Mesh(
    largeGeometry,
    moleculeMaterial('#a8701e', { roughness: 0.7, emissiveIntensity: 0.22, side: THREE.BackSide, clippingPlanes: keepBack }),
  );
  root.add(largeOuter, largeInner);

  // Exit tunnel: a faint channel from the PTC to the exit.
  const poses = sitePoses();
  // Where the chain is held: the P-site tRNA's acceptor end (the tRNA is drawn at TRNA_SCALE).
  const ptc = ACCEPTOR_LOCAL.clone().multiplyScalar(TRNA_SCALE).applyQuaternion(poses.P.quaternion).add(poses.P.position);
  const tunnelCurve = fineCurve([
    ptc.clone(),
    new THREE.Vector3(0.3, 10.1, -2.0),
    new THREE.Vector3(0.2, 12.5, -3.6),
    new THREE.Vector3(-0.2, 14.5, -5.0),
    FRAME.exit.clone(),
    FRAME.exit.clone().add(new THREE.Vector3(-0.25, 1.0, -0.6)),
  ]);
  const tunnel = new THREE.Mesh(
    new THREE.TubeGeometry(tunnelCurve, 40, 1.05, 10, false),
    new THREE.MeshStandardMaterial({ color: '#7a4a10', emissive: '#7a4a10', emissiveIntensity: 0.3, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
  );
  tunnel.renderOrder = 1;
  root.add(tunnel);

  // ── mRNA: a fixed backbone; the nucleotides slide along it codon by codon ─
  const mrnaCurve = fineCurve([
    new THREE.Vector3(-62, -9, 8),
    new THREE.Vector3(-34, -4.5, 4.5),
    new THREE.Vector3(-14, FRAME.mrnaY - 0.2, FRAME.mrnaZ + 0.4),
    new THREE.Vector3(-6, FRAME.mrnaY, FRAME.mrnaZ),
    new THREE.Vector3(6, FRAME.mrnaY, FRAME.mrnaZ),
    new THREE.Vector3(15, FRAME.mrnaY - 0.3, FRAME.mrnaZ + 0.6),
    new THREE.Vector3(34, -6, 5),
    new THREE.Vector3(62, -10, 9),
  ]);
  const mrnaLength = mrnaCurve.getLength();
  const slotCount = Math.round(mrnaLength / FRAME.nt / 12) * 12;
  const nt = mrnaLength / slotCount;
  const mrna = singleStrand({
    curve: mrnaCurve,
    quality,
    spacing: nt,
    backboneColor: '#ff7fb3',
    backboneRadius: 0.32,
    baseLength: 0.95,
    baseColor: (i) => codonColor(Math.floor(i / 3)),
  });
  root.add(mrna.group);
  // Arc length of the A-site codon centre on the curve.
  let sA = 0;
  {
    const lengths = mrnaCurve.getLengths(2000);
    let best = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const p = mrnaCurve.getPoint(i / 2000);
      const d = Math.abs(p.x - CODON);
      if (d < best) {
        best = d;
        sA = lengths[i];
      }
    }
  }

  // ── tRNAs (pool of four: arriving/A, P, E, leaving) ───────────────────
  const trnaShape = trnaGeometry(quality);
  const trnas = Array.from({ length: 4 }, () => {
    const mesh = new THREE.Mesh(trnaShape, moleculeMaterial('#ffd27f', { roughness: 0.45, emissiveIntensity: 0.2 }));
    mesh.visible = false;
    root.add(mesh);
    return mesh;
  });
  const capGeometry = new THREE.SphereGeometry(1.45, 12, 10);
  const capMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(capMaterial, 0.3, 'anticodons');
  const caps = new THREE.InstancedMesh(capGeometry, capMaterial, 4);
  caps.frustumCulled = false;
  root.add(caps);

  // Arrival and departure paths.
  const arriveFrom: TrnaPose = {
    position: poses.A.position.clone().add(new THREE.Vector3(17, 11, 15)),
    quaternion: poses.A.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, -1.1, 0.6))),
  };
  const leaveTo: TrnaPose = {
    position: poses.E.position.clone().add(new THREE.Vector3(-17, 9, 14)),
    quaternion: poses.E.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.9, 0.5))),
  };

  // ── Polypeptide: residue beads along a fixed path (tunnel, then a loose coil) ─
  const pathPoints = [ptc.clone(), ...tunnelCurve.getSpacedPoints(16).slice(1, 15)];
  {
    // Outside the exit: a seeded, persistent random walk that coils loosely up and back.
    let p = FRAME.exit.clone();
    let d = new THREE.Vector3(-0.15, 0.75, -0.65).normalize();
    pathPoints.push(p.clone());
    const pull = new THREE.Vector3(-11, 27, -10);
    for (let i = 0; i < 46; i++) {
      const jitter = rng.direction().multiplyScalar(0.55);
      const toward = pull.clone().sub(p).normalize().multiplyScalar(0.18);
      d = d.clone().add(jitter).add(toward).normalize();
      p = p.clone().addScaledVector(d, 1.0);
      pathPoints.push(p.clone());
    }
  }
  const chainPath = fineCurve(pathPoints, 0.02);
  const chainLength = chainPath.getLength();
  const tunnelSlots = Math.round(tunnelCurve.getLength() / BEAD_SPACING);
  const maxSlots = Math.min(VISIBLE_RESIDUES + 2, Math.floor(chainLength / BEAD_SPACING) - 1);
  const slotPoint = (slot: number, target: THREE.Vector3) => chainPath.getPointAt(THREE.MathUtils.clamp((slot * BEAD_SPACING) / chainLength, 0, 1), target);
  // Folded blob of older residues at the end of the visible chain.
  const blobCenter = slotPoint(maxSlots, new THREE.Vector3()).add(new THREE.Vector3(-1.2, 1.4, -0.8));
  const beadGeometry = new THREE.IcosahedronGeometry(1, quality === 'low' ? 1 : 2);
  const beadMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(beadMaterial, 0.22, 'residues');
  const blobCount = 18;
  const beads = new THREE.InstancedMesh(beadGeometry, beadMaterial, VISIBLE_RESIDUES + 8 + blobCount);
  beads.frustumCulled = false;
  root.add(beads);
  const blobMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(blobMaterial, 0.2, 'foldedBlob');
  addJiggle(blobMaterial, jiggle, new THREE.Vector3(0.12, 0.12, 0.12), 0.6, 'blobJiggle');
  const blob = new THREE.InstancedMesh(beadGeometry.clone(), blobMaterial, blobCount);
  blob.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    for (let i = 0; i < blobCount; i++) {
      const p = rng.inBall().multiplyScalar(2.0).add(blobCenter);
      m.makeScale(BEAD_RADIUS * 1.15, BEAD_RADIUS * 1.15, BEAD_RADIUS * 1.15).setPosition(p);
      blob.setMatrixAt(i, m);
      blob.setColorAt(i, AA_CLASSES[aaClass(1000 + i)].bead.clone().multiplyScalar(0.85));
    }
    setSeeds(
      blob,
      Array.from({ length: blobCount }, (_, i) => i + 1),
    );
  }
  root.add(blob);
  // Peptide bond: a short link and a soft flash at the PTC.
  const bond = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1, 8, 1, true).translate(0, 0.5, 0), moleculeMaterial('#fff3c4', { emissiveIntensity: 0.8 }));
  bond.visible = false;
  root.add(bond);
  const flash = sparks(1, '#fff2b0', 7, ctx.pointScale);
  root.add(flash.points);

  // ── Animation ───────────────────────────────────────────────────────────
  const m4 = new THREE.Matrix4();
  const qa = new THREE.Quaternion();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const scaleV = new THREE.Vector3();
  const trnaArriving = new THREE.Vector3();
  const tiltQ = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);

  const lerpPose = (a: TrnaPose, b: TrnaPose, t: number, target: THREE.Object3D) => {
    target.position.lerpVectors(a.position, b.position, t);
    target.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t);
  };
  /** Translocation progress within the current cycle (0 before, 1 after). */
  const moveProgress = (phase: number) => smooth((phase - PH.moveStart) / (PH.moveEnd - PH.moveStart));

  const update = (t: number, calm: boolean) => {
    const c = Math.floor(t / CYCLE);
    const phase = t / CYCLE - c;
    const move = moveProgress(phase);

    // mRNA: nucleotide slots slide along the backbone, one codon per cycle.
    const shift = 3 * (c + move);
    for (let j = 0; j < slotCount; j++) {
      let s = sA + (j - 1 - shift) * nt;
      s = ((s % mrnaLength) + mrnaLength) % mrnaLength;
      const u = s / mrnaLength;
      mrnaCurve.getPointAt(u, pa);
      const edge = Math.min(u, 1 - u);
      const sc = THREE.MathUtils.smoothstep(edge, 0.01, 0.06);
      tiltQ.setFromAxisAngle(xAxis, ((j % 3) - 1) * 0.28);
      qa.copy(tiltQ);
      scaleV.set(sc, 0.95 * sc, sc);
      mrna.bases.setMatrixAt(j, m4.compose(pa, qa, scaleV));
    }
    mrna.bases.instanceMatrix.needsUpdate = true;

    // tRNAs: residue n is brought by tRNA n in cycle n.
    for (let k = 0; k < 4; k++) trnas[k].visible = false;
    caps.count = 0;
    for (let n = c - 2; n <= c; n++) {
      const mesh = trnas[((n % 4) + 4) % 4];
      const age = c - n;
      let scale = 1;
      if (age === 0) {
        if (phase < PH.arriveEnd) {
          const a = smooth(phase / PH.arriveEnd);
          lerpPose(arriveFrom, poses.A, a, mesh);
          scale = 0.35 + 0.65 * Math.min(1, phase / (PH.arriveEnd * 0.5));
          trnaArriving.copy(mesh.position);
        } else {
          lerpPose(poses.A, poses.P, move, mesh);
          trnaArriving.copy(mesh.position);
        }
      } else if (age === 1) {
        lerpPose(poses.P, poses.E, move, mesh);
      } else {
        if (phase >= PH.leaveEnd) continue;
        const a = smooth(phase / PH.leaveEnd);
        lerpPose(poses.E, leaveTo, a, mesh);
        scale = 1 - smooth((phase / PH.leaveEnd - 0.55) / 0.45);
      }
      mesh.visible = scale > 0.01;
      mesh.scale.setScalar(scale * TRNA_SCALE);
      const cls = AA_CLASSES[aaClass(n)];
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.copy(cls.trna);
      material.emissive.copy(cls.trna);
      // Anticodon loop coloured like the codon it pairs with.
      mesh.updateMatrix();
      tmp.copy(ANTICODON_LOCAL).applyMatrix4(mesh.matrix);
      const capScale = scale * TRNA_SCALE;
      caps.setMatrixAt(caps.count, m4.makeScale(capScale, capScale, capScale).setPosition(tmp));
      caps.setColorAt(caps.count, codonColor(n));
      caps.count++;
    }
    caps.instanceMatrix.needsUpdate = true;
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;

    // Residues: n = c rides on the arriving tRNA; older ones are on the chain path.
    let count = 0;
    const bondT = smooth((phase - PH.bondStart) / (PH.bondEnd - PH.bondStart));
    const wob = calm ? 0.35 : 1;
    for (let n = c; n >= c - VISIBLE_RESIDUES - 2; n--) {
      let radius = BEAD_RADIUS;
      if (n === c) {
        // Amino acid on the arriving tRNA's acceptor end.
        const mesh = trnas[((n % 4) + 4) % 4];
        mesh.updateMatrix();
        pa.copy(ACCEPTOR_LOCAL).applyMatrix4(mesh.matrix);
        radius *= mesh.scale.x / TRNA_SCALE;
      } else {
        const slot = c - n - 1 + move;
        if (slot > maxSlots) break;
        slotPoint(slot, pa);
        // Loose, floppy chain outside the tunnel.
        const out = THREE.MathUtils.clamp((slot - tunnelSlots) / 6, 0, 1) * wob;
        if (out > 0) {
          pa.x += 0.3 * out * Math.sin(t * 1.1 + n * 1.7);
          pa.y += 0.3 * out * Math.sin(t * 0.9 + n * 2.3);
          pa.z += 0.3 * out * Math.sin(t * 1.3 + n * 0.9);
        }
        // Oldest residues shrink into the folded blob.
        const fade = THREE.MathUtils.clamp((slot - (maxSlots - 3)) / 3, 0, 1);
        if (fade > 0) {
          pa.lerp(blobCenter, fade * 0.8);
          radius *= 1 - fade;
        }
      }
      beads.setMatrixAt(count, m4.compose(pa, qa.identity(), scaleV.setScalar(radius)));
      beads.setColorAt(count, AA_CLASSES[aaClass(n)].bead);
      count++;
      if (n === c) pb.copy(pa);
      if (n === c - 1) tmp.copy(pa);
    }
    beads.count = count;
    beads.instanceMatrix.needsUpdate = true;
    if (beads.instanceColor) beads.instanceColor.needsUpdate = true;

    // Peptide bond between the new residue (pb) and the chain's last residue (tmp).
    const bondVisible = phase > PH.bondStart && c > 0;
    bond.visible = bondVisible;
    if (bondVisible) {
      pa.subVectors(pb, tmp);
      const len = pa.length();
      bond.position.copy(tmp);
      bond.quaternion.setFromUnitVectors(up, pa.divideScalar(Math.max(1e-6, len)));
      bond.scale.set(1, len * bondT, 1);
    }
    const flashA = phase > PH.bondStart && phase < PH.bondEnd + 0.08 ? Math.sin(Math.PI * THREE.MathUtils.clamp((phase - PH.bondStart) / (PH.bondEnd + 0.08 - PH.bondStart), 0, 1)) : 0;
    flash.positions[0] = (pb.x + tmp.x) / 2;
    flash.positions[1] = (pb.y + tmp.y) / 2;
    flash.positions[2] = (pb.z + tmp.z) / 2;
    flash.alphas[0] = flashA * (calm ? 0.45 : 0.9);
    flash.commit();
  };
  update(0, false);

  // ── Labels ──────────────────────────────────────────────────────────────
  const largeAnchor = new THREE.Vector3(-10, 13.4, 1);
  const smallAnchor = new THREE.Vector3(5, -10.3, 7.4);
  const mrnaAnchor = mrnaCurve.getPointAt(0.66).add(new THREE.Vector3(0, 0.8, 0.6));
  // Chain label on the part of the coil farthest from the exit (clear of the exit label).
  const polypeptideAnchor = new THREE.Vector3();
  let farthest = -1;
  for (let slot = tunnelSlots + 8; slot < maxSlots - 6; slot++) {
    const p = slotPoint(slot, new THREE.Vector3());
    const d = p.distanceTo(FRAME.exit);
    if (d > farthest) {
      farthest = d;
      polypeptideAnchor.copy(p);
    }
  }
  // Exit-tunnel label on the channel itself, seen through the cut-away front.
  const exitAnchor = tunnelCurve.getPointAt(0.5).add(new THREE.Vector3(1.0, 0, 0.6));

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, 3.5, 0),
        radius: 30,
        direction: new THREE.Vector3(0.32, 0.2, 1).normalize(),
        labels: [
          { part: 'large-subunit', anchor: anchorOn(root, largeAnchor) },
          { part: 'small-subunit', anchor: anchorOn(root, smallAnchor) },
          { part: 'mrna', anchor: anchorOn(root, mrnaAnchor) },
          { part: 'trna', anchor: () => trnaArriving },
          { part: 'polypeptide', anchor: anchorOn(root, polypeptideAnchor) },
          { part: 'exit-tunnel', anchor: anchorOn(root, exitAnchor) },
        ],
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      update(t, calm);
    },
    dispose() {
      mrna.dispose();
      flash.dispose();
      beadGeometry.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
