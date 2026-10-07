import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import {
  addInstanceGlow,
  anchorOn,
  bandMaterial,
  bilayerStripGeometry,
  instanced,
  instancedMaterial,
  membraneMaterial,
  moleculeMaterial,
  ribosomeGeometries,
  singleStrand,
  type Placement,
} from './kit';
import { debugTime } from './membranesDebug';
import { BAND_CORE, BAND_HEAD, ballGeometry, cutawayMaterial, glowPoints, glycanTree, mergeParts, sstep } from './membranesParts';
import { createBud } from './roughErParts';
import type { CloseupFactory } from './types';

/**
 * Rough ER making a secreted protein (1 unit = 1 nm). A slab of ER membrane
 * cut at z = 0 (back half drawn), cytosol above, lumen below. A ribosome sits
 * on a translocon (cut open so the chain can be seen in its pore) and threads
 * a new chain into the lumen: the red signal sequence leads and is cut off,
 * a sugar tree is attached, the chaperone BiP binds and the chain folds; the
 * folded protein drifts to an exit site that buds a COPII-coated vesicle.
 * Loop 18 s; the chain grows ~2× faster than real translation (~5 amino
 * acids per second) and later steps are compressed far more.
 */
const MEMBRANE = 5;
const HALF_W = 120;
const DEPTH = 80;
const XT = -45; // translocon axis
const T_TOP = 4.6;
const T_BOTTOM = -6;
const T_NOTCH = 5.8;
const BUD_X = 36;
const BUD_R = 33; // vesicle mid-surface radius → ~70 nm vesicle
const BUD_FILLET = 8;
const BUD_REGION = 50;

const TEAL = '#22d3c5';
const SHEET = '#1aa89d';
const SHEET_GLOW = 0.06;
const LOOP = 18;
const SIGNAL = 8;
const BEADS = 58;
const BEAD_R = 0.5;
const STEP = 0.6;
const GLYCAN_AT = 22;
const GLYCAN_BEADS = 14;

// Timeline (s).
const T_CLEAVE = 3.4;
const T_GLYCAN = 4.4;
const T_BIP_IN = 5.6;
const T_BIP_BOUND = 6.4;
const T_FOLD = 6.8;
const T_FOLDED = 8.8;
const T_BIP_OFF = 9.6;
const T_DRIFT_END = 11.8;
const T_IN_BUD = 13.2;
const T_BUD_START = 5;
const DOME = 6; // the exit site starts each loop with a shallow coated dome
const T_BUD_HALF = 12.6;
const T_PINCH = 14.4;
const T_RELAXED = 15;
const T_GONE = 17.4;

/** Arc length of the chain's leading end along its path (nm) at loop time t. */
function extruded(t: number): number {
  if (t < 2) return 9.2 * t;
  if (t < 6) return 18.4 + 7.4 * (t - 2);
  if (t < 6.8) return 48 + 11.25 * (t - 6);
  return 57;
}

/** Sphere-centre height of the bud (relative to the membrane mid-plane). */
function budHeight(t: number, pinch: number): number {
  if (t < 2) return -BUD_R + DOME * sstep(0, 2, t);
  if (t < T_BUD_START) return -BUD_R + DOME;
  if (t < T_BUD_HALF) return -BUD_R + DOME + (5 + BUD_R - DOME) * sstep(T_BUD_START, T_BUD_HALF, t);
  if (t < T_PINCH) return 5 + (pinch - 5) * sstep(T_BUD_HALF, T_PINCH, t);
  return pinch;
}

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#081a1f');
  const rng = new Rng('closeup:rough-er');
  const noise = new Simplex3('closeup:rough-er:motion');
  const quality = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);
  const cut = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const teal = new THREE.Color(TEAL);
  const bandHead = BAND_HEAD.clone().lerp(teal, 0.22);
  const bandCore = BAND_CORE.clone().lerp(teal, 0.4);

  // ── ER membrane: back half of a 240 × 80 nm slab, notched at the translocon and the exit site ─
  const sheetShape = new THREE.Shape();
  sheetShape.moveTo(-HALF_W, 0);
  sheetShape.lineTo(XT - T_NOTCH, 0);
  sheetShape.absarc(XT, 0, T_NOTCH, Math.PI, 0, true);
  // The static sheet tucks 1 nm under the animated exit-site patch (no hairline cracks at the seam).
  sheetShape.lineTo(BUD_X - BUD_REGION + 1, 0);
  sheetShape.absarc(BUD_X, 0, BUD_REGION - 1, Math.PI, 0, true);
  sheetShape.lineTo(HALF_W, 0);
  sheetShape.lineTo(HALF_W, DEPTH);
  sheetShape.lineTo(-HALF_W, DEPTH);
  sheetShape.lineTo(-HALF_W, 0);
  const sheetTop = new THREE.ShapeGeometry(sheetShape, 32);
  sheetTop.rotateX(-Math.PI / 2);
  const sheetBottom = sheetTop.clone();
  sheetTop.translate(0, MEMBRANE / 2, 0);
  sheetBottom.translate(0, -MEMBRANE / 2, 0);
  // Face the luminal side down: reverse the winding and the normals.
  const index = sheetBottom.index!;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, a);
  }
  const normals = sheetBottom.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i));
  const sheetMaterial = membraneMaterial(SHEET, { rim: 0.3 });
  sheetMaterial.emissiveIntensity = SHEET_GLOW;
  const sheet = new THREE.Mesh(mergeParts([sheetTop, sheetBottom]), sheetMaterial);
  root.add(sheet);
  const bands: THREE.BufferGeometry[] = [];
  const strip = (x0: number, x1: number) => {
    const g = bilayerStripGeometry(x1 - x0, MEMBRANE, bandHead, bandCore);
    g.translate((x0 + x1) / 2, 0, 0);
    bands.push(g);
  };
  strip(-HALF_W, XT - T_NOTCH);
  strip(XT + T_NOTCH, BUD_X - BUD_REGION);
  for (const side of [-1, 1]) {
    const g = bilayerStripGeometry(DEPTH, MEMBRANE, bandHead, bandCore);
    g.rotateY((side * Math.PI) / 2);
    g.translate(side * HALF_W, 0, -DEPTH / 2);
    bands.push(g);
  }
  const back = bilayerStripGeometry(2 * HALF_W, MEMBRANE, bandHead, bandCore);
  back.rotateY(Math.PI);
  back.translate(0, 0, -DEPTH);
  bands.push(back);
  root.add(new THREE.Mesh(mergeParts(bands), bandMaterial()));

  // ── Translocon (Sec61), cut open through its pore ───────────────────────
  const transloconMaterial = cutawayMaterial('#8f9bff', '#5f69c7', cut, { emissiveIntensity: 0.18 });
  const transloconShape = blobGeometry(1, 'sec61', 0.2, quality === 'high' ? 3 : 2);
  const transloconLobes: Placement[] = [0, 90, 180, 270].map((deg, i) => {
    const a = THREE.MathUtils.degToRad(deg);
    return {
      position: new THREE.Vector3(XT + Math.cos(a) * 3.2, -0.7, -Math.sin(a) * 3.2),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08 * (i - 1.5), a, 0.06 * i)),
      scale: new THREE.Vector3(2.6, 5.4, 2.8),
    };
  });
  const translocon = instanced(transloconShape, transloconMaterial, transloconLobes);
  root.add(translocon);

  // Background translocons with ribosomes: the "rough" in rough ER.
  const ribosomeShapes = ribosomeGeometries(quality, 'er-ribosome');
  const smallMaterial = moleculeMaterial('#f6d58c', { roughness: 0.5 });
  const largeMaterial = moleculeMaterial('#e3a83a', { roughness: 0.5 });
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const addRibosome = (x: number, z: number, spin: number) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(ribosomeShapes.small, smallMaterial), new THREE.Mesh(ribosomeShapes.large, largeMaterial));
    // Large subunit down on the membrane, its exit tunnel (kit frame +y) over the translocon pore.
    group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin).multiply(flip);
    group.position.set(x, T_TOP + 15.6, z + 1.5);
    root.add(group);
    return group;
  };
  const ribosome = addRibosome(XT, 0, 0);
  const backTranslocons: Placement[] = [];
  for (const [x, z, spin] of [
    [-96, -46, 0.7],
    [-10, -60, -0.5],
  ]) {
    addRibosome(x, z, spin);
    for (const deg of [0, 90, 180, 270]) {
      const a = THREE.MathUtils.degToRad(deg);
      backTranslocons.push({ position: new THREE.Vector3(x + Math.cos(a) * 3.2, -0.7, z - Math.sin(a) * 3.2), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a), scale: new THREE.Vector3(2.6, 5.4, 2.8) });
    }
  }
  root.add(instanced(transloconShape, transloconMaterial, backTranslocons));

  // mRNA being read by the main ribosome (through the cleft between its subunits).
  const mrnaY = T_TOP + 15.6 + 2.6;
  const mrnaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(XT - 46, mrnaY + 10, 8),
    new THREE.Vector3(XT - 16, mrnaY + 1.5, 2.5),
    new THREE.Vector3(XT, mrnaY, 1.5),
    new THREE.Vector3(XT + 16, mrnaY + 1.5, 0.5),
    new THREE.Vector3(XT + 44, mrnaY + 12, -10),
  ]);
  const mrna = singleStrand({ curve: mrnaCurve, quality, backboneColor: '#ff8fb0', baseColor: (i) => (i % 6 < 3 ? '#ffd1e4' : '#ffb07f') });
  root.add(mrna.group);

  // ── The new chain: N-terminal signal sequence (red) then the mature protein ─
  const chainPath = new THREE.CatmullRomCurve3(
    [
      [XT, T_TOP + 9.6, 1.5],
      [XT, T_TOP + 4.5, 0.6],
      [XT, T_TOP, 0],
      [XT, -1, 0],
      [XT, T_BOTTOM, 0],
      [XT + 1.2, -10, 0.8],
      [XT - 1, -14, 1.6],
      [XT + 2, -18, 1.2],
      [XT + 6.5, -20.5, 0.6],
      [XT + 10, -17.5, 1.8],
      [XT + 12.5, -21.5, 2.6],
      [XT + 10, -26, 2],
      [XT + 5, -28.5, 1.2],
      [XT, -26.5, 2],
      [XT - 4.5, -29.5, 2.6],
      [XT - 9, -27, 1.6],
      [XT - 13, -30, 2],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    'centripetal',
  );
  const pathLength = chainPath.getLength();
  // Arc length from the peptidyl-transferase centre to the luminal end of the pore.
  let sBottom = pathLength;
  for (let k = 0; k <= 400; k++) {
    if (chainPath.getPointAt(k / 400).y <= T_BOTTOM) {
      sBottom = (k / 400) * pathLength;
      break;
    }
  }
  const beadGeometry = ballGeometry(quality === 'high' ? 1 : 0);
  const chainMaterial = instancedMaterial({ roughness: 0.4 });
  addInstanceGlow(chainMaterial, 0.45, 'erChain');
  const chain = instanced(
    beadGeometry,
    chainMaterial,
    Array.from({ length: BEADS }, (_, i) => ({ position: new THREE.Vector3(), scale: BEAD_R, color: i < SIGNAL ? '#ff4d4d' : '#ffe08a' })),
  );
  root.add(chain);
  // Soft glow along the chain: at true scale (1 nm thick) it would be hard to follow.
  const chainGlow = glowPoints({ count: BEADS, color: '#ffe08a', size: 3, pointScale: ctx.pointScale, opacity: 0.42 });
  const signalGlow = glowPoints({ count: SIGNAL, color: '#ff4d4d', size: 3.4, pointScale: ctx.pointScale, opacity: 0.6 });
  root.add(chainGlow.points, signalGlow.points);

  // Sugar tree (14 residues, Glc3Man9GlcNAc2-like) attached to one asparagine.
  const glyRng = rng.fork('glycan');
  const glycanLocal = glycanTree(glyRng, GLYCAN_BEADS, 0.55);
  const glycanMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(glycanMaterial, 0.4, 'erGlycan');
  const glycan = instanced(
    beadGeometry,
    glycanMaterial,
    glycanLocal.map(() => ({ position: new THREE.Vector3(), scale: 0.36, color: new THREE.Color('#6ee77a').offsetHSL(0, 0, glyRng.range(-0.05, 0.05)) })),
  );
  root.add(glycan);
  const glycanGlow = glowPoints({ count: GLYCAN_BEADS, color: '#6ee77a', size: 2.4, pointScale: ctx.pointScale, opacity: 0.5 });
  root.add(glycanGlow.points);

  // Folded state: the mature chain packed into a small globule (golden-angle spiral in a ball).
  const mature = BEADS - SIGNAL;
  const foldedOffsets = Array.from({ length: mature }, (_, k) => {
    const f = (k + 0.5) / mature;
    const r = 2.7 * Math.cbrt(f);
    const yy = 1 - 2 * ((k * 0.618034) % 1);
    const a = k * 2.39996;
    const rr = Math.sqrt(1 - yy * yy);
    return new THREE.Vector3(Math.cos(a) * rr * r, yy * r, Math.sin(a) * rr * r);
  });

  // Enzymes on the luminal face next to the translocon, and the chaperone BiP.
  const spase = new THREE.Mesh(blobGeometry(2.6, 'signal-peptidase', 0.22, 2), moleculeMaterial('#c6b3e6', { emissiveIntensity: 0.15 }));
  spase.position.set(XT - 4.8, -6.6, -2.2);
  const ost = new THREE.Mesh(blobGeometry(4, 'ost', 0.22, 2), moleculeMaterial('#9ec8d6', { emissiveIntensity: 0.15 }));
  ost.position.set(XT + 7.4, -7.6, -3);
  root.add(spase, ost);
  const flashes = glowPoints({ count: 2, color: '#fff6c2', size: 12, pointScale: ctx.pointScale, opacity: 0.8 });
  flashes.positions.set([spase.position.x, spase.position.y, spase.position.z + 2.5, ost.position.x, ost.position.y, ost.position.z + 3]);
  root.add(flashes.points);
  const bipParts = [blobGeometry(2.4, 'bip-nbd', 0.22, 2), blobGeometry(1.8, 'bip-sbd', 0.24, 2)];
  bipParts[1].translate(2.6, -1.6, 0.6);
  const bipMaterial = moleculeMaterial('#ff8fd0', { emissiveIntensity: 0.25, transparent: true });
  const bip = new THREE.Mesh(mergeParts(bipParts), bipMaterial);
  root.add(bip);

  // ── Exit site: a COPII-coated bud that pinches off as a vesicle ─────────
  const bud = createBud({
    radius: BUD_R,
    fillet: BUD_FILLET,
    region: BUD_REGION,
    thickness: MEMBRANE,
    quality,
    color: SHEET,
    bandHead,
    bandCore,
    coatColor: '#ffcf7a',
    coatCap: '#c9973f',
    cut,
    emissive: SHEET_GLOW,
  });
  bud.group.position.set(BUD_X, 0, 0);
  root.add(bud.group);

  // Moving label anchors.
  const signalMark = new THREE.Object3D();
  const glycanMark = new THREE.Object3D();
  root.add(signalMark, glycanMark);
  const state = { signal: false, glycan: false, bip: false };

  const labels = [
    { part: 'bound-ribosome', anchor: anchorOn(ribosome, new THREE.Vector3(5, -11, 5)) },
    { part: 'translocon', anchor: anchorOn(root, new THREE.Vector3(XT + 4.2, -1.5, 0.3)) },
    { part: 'signal-peptide', anchor: anchorOn(signalMark, new THREE.Vector3()), visible: () => state.signal },
    { part: 'glycan', anchor: anchorOn(glycanMark, new THREE.Vector3()), visible: () => state.glycan },
    { textKey: 'closeupCaptions.chaperone', anchor: anchorOn(bip, new THREE.Vector3(0, 2.4, 1.5)), visible: () => state.bip },
    { part: 'exit-site', anchor: anchorOn(root, new THREE.Vector3(BUD_X + 30, 2.5, -14)) },
    { part: 'er-sheet', anchor: anchorOn(root, new THREE.Vector3(-82, 0, 0.3)) },
    { part: 'lumen', anchor: anchorOn(root, new THREE.Vector3(-70, -30, -10)) },
    { textKey: 'closeupCaptions.cytosol', anchor: anchorOn(root, new THREE.Vector3(-74, 42, -24)) },
  ];

  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _center = new THREE.Vector3();
  const _cargo = new THREE.Vector3();
  const _vesicle = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _out = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _beads = Array.from({ length: BEADS }, () => new THREE.Vector3());
  const signalTarget = new THREE.Vector3(XT - 7, -2.6, -1.5);
  const foldCenter = new THREE.Vector3(XT + 4, -21, 1.5);
  const budEntry = new THREE.Vector3(BUD_X - 3, -12, 1);

  /** Bead i on the extruded chain at time tt (leading end at arc s = extruded(tt)). */
  const onPath = (i: number, tt: number, wiggleAmp: number, target: THREE.Vector3) => {
    const s = extruded(tt) - i * STEP;
    const u = THREE.MathUtils.clamp(s / pathLength, 0, 1);
    chainPath.getPointAt(u, target);
    const past = Math.max(0, s - sBottom);
    if (past > 0) {
      const w = Math.min(1, past / 8) * wiggleAmp;
      target.x += noise.noise(i * 0.21, tt * 0.5, 1) * w;
      target.y += noise.noise(i * 0.21, tt * 0.5, 4) * w;
      target.z += noise.noise(i * 0.21, tt * 0.5, 8) * w;
    }
    return s >= 0;
  };

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(10, 20, -4),
        radius: 84,
        direction: new THREE.Vector3(0.1, 0.24, 1).normalize(),
        labels,
      },
    ],
    setView() {},
    update(_dt, rawTime, calm) {
      const t = debugTime(rawTime);
      const local = ((t % LOOP) + LOOP) % LOOP;
      const amp = calm ? 0.4 : 1;
      const wiggle = 1.2 * amp;

      // Cargo centre once folded: drift to the exit site, rise into the bud, leave with the vesicle.
      const pinch = bud.pinchHeight;
      const c = budHeight(local, pinch);
      const pinched = local >= T_PINCH;
      const vesicleU = sstep(T_PINCH, T_GONE, local);
      _vesicle.set(58 * vesicleU, pinch + 28 * vesicleU, -6 * vesicleU);
      if (local < T_FOLDED) _cargo.copy(foldCenter);
      else if (local < T_DRIFT_END) {
        const u = sstep(T_FOLDED, T_DRIFT_END, local);
        _cargo.copy(foldCenter).lerp(budEntry, u);
        _cargo.y += Math.sin(u * Math.PI) * 4;
      } else if (local < T_IN_BUD) {
        _tmp.set(BUD_X, c - 6, 0);
        _cargo.copy(budEntry).lerp(_tmp, sstep(T_DRIFT_END, T_IN_BUD, local));
      } else if (!pinched) _cargo.set(BUD_X, c - 6, 0);
      else _cargo.set(BUD_X + _vesicle.x, _vesicle.y - 6, _vesicle.z);
      const cargoAlpha = 1 - sstep(T_GONE - 0.8, T_GONE, local);

      // Chain beads.
      const fold = sstep(T_FOLD, T_FOLDED, local);
      _center.set(0, 0, 0);
      for (let i = 0; i < BEADS; i++) {
        const p = _beads[i];
        let visible: boolean;
        let alpha = 1;
        if (i < SIGNAL && local >= T_CLEAVE) {
          // Signal sequence: cut off, slips into the membrane and is degraded.
          onPath(i, T_CLEAVE, wiggle, p);
          const u = sstep(T_CLEAVE, T_CLEAVE + 1.2, local);
          p.lerp(signalTarget, u);
          alpha = 1 - sstep(T_CLEAVE + 0.5, T_CLEAVE + 1.2, local);
          visible = alpha > 0.01;
        } else {
          visible = onPath(i, Math.min(local, T_FOLD), wiggle, p);
          if (i >= SIGNAL && local >= T_FOLD) {
            _tmp.copy(foldedOffsets[i - SIGNAL]).add(_cargo);
            const k = THREE.MathUtils.clamp(fold * 1.25 - ((i - SIGNAL) / mature) * 0.25, 0, 1);
            p.lerp(_tmp, sstep(0, 1, k));
            if (local >= T_FOLDED) p.copy(_tmp);
          }
        }
        if (local >= T_GONE) visible = false;
        if (i >= SIGNAL) _center.add(p);
        _s.setScalar(visible ? BEAD_R * (i >= SIGNAL ? cargoAlpha : 1) : 0);
        chain.setMatrixAt(i, _m.compose(p, _q, _s));
        const glowAlpha = visible ? alpha * (i >= SIGNAL ? cargoAlpha : 1) : 0;
        if (i < SIGNAL) {
          signalGlow.positions[i * 3] = p.x;
          signalGlow.positions[i * 3 + 1] = p.y;
          signalGlow.positions[i * 3 + 2] = p.z;
          signalGlow.alphas[i] = glowAlpha;
          chainGlow.alphas[i] = 0;
        } else {
          chainGlow.alphas[i] = glowAlpha;
        }
        chainGlow.positions[i * 3] = p.x;
        chainGlow.positions[i * 3 + 1] = p.y;
        chainGlow.positions[i * 3 + 2] = p.z;
      }
      chain.instanceMatrix.needsUpdate = true;
      chainGlow.commit();
      signalGlow.commit();
      _center.multiplyScalar(1 / mature);
      signalMark.position.copy(_beads[3]);
      state.signal = local > 1.6 && local < T_CLEAVE + 0.9;

      // Sugar tree on the asparagine bead, pointing away from the protein.
      const glycanOn = local >= T_GLYCAN && local < T_GONE;
      const grow = sstep(T_GLYCAN, T_GLYCAN + 0.5, local);
      const anchor = _beads[GLYCAN_AT];
      _out.copy(anchor).sub(local >= T_FOLD ? _cargo : _center);
      if (_out.lengthSq() < 1e-4) _out.set(1, -1, 0.5);
      _q.setFromUnitVectors(_up, _out.normalize());
      for (let k = 0; k < GLYCAN_BEADS; k++) {
        _p.copy(glycanLocal[k]).multiplyScalar(grow).applyQuaternion(_q).add(anchor).addScaledVector(_out, 0.6);
        const on = glycanOn && k <= grow * (GLYCAN_BEADS - 1) + 0.5;
        _s.setScalar(on ? 0.36 * cargoAlpha : 0);
        glycan.setMatrixAt(k, _m.compose(_p, _q, _s));
        glycanGlow.positions[k * 3] = _p.x;
        glycanGlow.positions[k * 3 + 1] = _p.y;
        glycanGlow.positions[k * 3 + 2] = _p.z;
        glycanGlow.alphas[k] = on ? cargoAlpha : 0;
        if (k === GLYCAN_BEADS - 1) glycanMark.position.copy(_p);
      }
      glycan.instanceMatrix.needsUpdate = true;
      glycanGlow.commit();
      _q.identity();
      state.glycan = glycanOn && local < T_DRIFT_END;

      // Enzyme flashes: signal peptidase at the cut, oligosaccharyltransferase at glycosylation.
      const peak = calm ? 0.45 : 1;
      const f1 = Math.sin(Math.PI * sstep(T_CLEAVE - 0.15, T_CLEAVE + 0.55, local)) * peak;
      const f2 = Math.sin(Math.PI * sstep(T_GLYCAN - 0.15, T_GLYCAN + 0.55, local)) * peak;
      flashes.alphas[0] = f1;
      flashes.alphas[1] = f2;
      flashes.commit();
      (spase.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + f1 * 0.8;
      (ost.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + f2 * 0.8;

      // BiP: arrives, holds the chain while it folds, lets go.
      let bipAlpha = 0;
      const bipStart = _tmp.set(XT - 24, -38, 8);
      onPath(36, Math.min(local, T_FOLD), wiggle, _p);
      _p.lerp(_center, local >= T_FOLD ? fold : 0).add(_out.set(-3, -2.2, 2));
      if (local >= T_BIP_IN && local < T_BIP_BOUND) {
        bip.position.copy(bipStart).lerp(_p, sstep(T_BIP_IN, T_BIP_BOUND, local));
        bipAlpha = sstep(T_BIP_IN, T_BIP_IN + 0.3, local);
      } else if (local >= T_BIP_BOUND && local < T_FOLDED) {
        bip.position.copy(_p);
        bipAlpha = 1;
      } else if (local >= T_FOLDED && local < T_BIP_OFF) {
        const u = sstep(T_FOLDED, T_BIP_OFF, local);
        bip.position.copy(_p).lerp(_tmp.set(XT - 20, -42, 10), u);
        bipAlpha = 1 - u;
      }
      bip.rotation.set(local * 0.4, local * 0.25, 0);
      bip.visible = bipAlpha > 0.01;
      bipMaterial.opacity = bipAlpha;
      state.bip = local > T_BIP_IN + 0.2 && local < T_FOLDED + 0.3;

      // Exit site.
      const relax = pinched ? sstep(T_PINCH, T_RELAXED, local) : 0;
      _tmp.copy(_vesicle);
      bud.update(c, pinched, relax, _tmp, local >= T_GONE ? 0 : 1 - sstep(T_GONE - 0.8, T_GONE, local));
    },
    dispose() {
      mrna.dispose();
      chainGlow.dispose();
      signalGlow.dispose();
      glycanGlow.dispose();
      flashes.dispose();
      bud.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
