import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import { actinFilament, addInstanceGlow, addJiggle, anchorOn, createJiggle, instanced, instancedMaterial, moleculeMaterial, setSeeds, type Placement } from './kit';
import { ballGeometry, bezier, glowPoints, glycanTree, mergeParts, pulse, sstep } from './membranesParts';
import { CHOLESTEROL_LENGTH, LIPID_JIGGLE, cholesterolGeometry, lipidLattice, phospholipidMeshes, type LipidSite } from './plasmaMembraneParts';
import type { CloseupFactory } from './types';

/**
 * A 40 nm square patch of plasma membrane (1 unit = 1 nm), outer leaflet up
 * (+y = outside the cell, −y = cytosol). Individual phospholipids and
 * cholesterol in both leaflets, an ion channel letting bursts of ions into
 * the cell, a single-pass receptor, the sugar coat (glycocalyx) and an actin
 * filament of the cortex underneath.
 */
const PATCH = 40;
const HALF = PATCH / 2;
const SPACING = 0.9;
const THICKNESS = 4; // head-group plane to head-group plane
const HEAD_R = 0.42;
const HEAD_Y = THICKNESS / 2;

const CHANNEL = new THREE.Vector3(-9, 0, 16.4);
const CHANNEL_RING = 2.3; // subunit centres from the pore axis
const CHANNEL_SUBUNITS = 5;
const RECEPTOR = new THREE.Vector3(8.5, 0, 18.4);

const ION_PERIOD = 4; // one burst every 4 s
const BURST = 7;
const AMBIENT_OUT = 10;
const AMBIENT_IN = 4;
const ION_START = 0.2; // s into the period
const ION_GAP = 0.2; // s between ions (single file)
const ION_APPROACH = 0.8;
const ION_TRANSIT = 0.75;
const ION_EXIT = 0.95;

const GATE_OPEN = ION_START + ION_APPROACH - 0.25;
const GATE_CLOSE = ION_START + (BURST - 1) * ION_GAP + ION_APPROACH + ION_TRANSIT + 0.15;

const GLYCAN_BEAD = 0.42; // radius (≈0.8 nm sugar residues)
const GLYCAN_STEP = 0.72;

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0b1226');
  const rng = new Rng('closeup:plasma-membrane');
  const noise = new Simplex3('closeup:plasma-membrane:motion');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);
  const quality = ctx.quality;

  // ── Lipids: phospholipids and cholesterol share one lattice ─────────────
  const sites = lipidLattice(PATCH, PATCH, SPACING, rng.fork('lattice'));
  const phospholipidSites: LipidSite[] = [];
  const cholesterolSites: LipidSite[] = [];
  const pick = rng.fork('sites');
  for (const s of sites) {
    const toChannel = Math.hypot(s.x - CHANNEL.x, s.z - CHANNEL.z);
    const toReceptor = Math.hypot(s.x - RECEPTOR.x, s.z - RECEPTOR.z);
    if (toChannel < 4.3 || toReceptor < 1.2) continue;
    if (pick.chance(0.4)) cholesterolSites.push(s); // ≈0.7 cholesterol per phospholipid
    else phospholipidSites.push(s);
  }
  const lipids = phospholipidMeshes(phospholipidSites, {
    quality,
    jiggle,
    rng: rng.fork('lipids'),
    thickness: THICKNESS,
    headRadius: HEAD_R,
    headColor: '#e3d4b9',
    tailColor: '#8fa8dc',
  });
  root.add(lipids.heads, lipids.tails);

  // Cholesterol: hydroxyl level with the head groups, rigid ring body in the tail region.
  const cholGeometry = cholesterolGeometry(quality);
  const cholMaterial = moleculeMaterial('#ffe066', { roughness: 0.42, emissiveIntensity: 0.3 });
  addJiggle(cholMaterial, jiggle, LIPID_JIGGLE, 1, 'pmJiggle');
  const cholRng = rng.fork('cholesterol');
  const up = new THREE.Vector3(0, 1, 0);
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  const cholPlacements: Placement[] = cholesterolSites.map((s) => {
    const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(cholRng.range(-0.15, 0.15), 1, cholRng.range(-0.15, 0.15)).normalize());
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, cholRng.range(0, Math.PI * 2)));
    if (s.leaflet === -1) q.premultiply(flip);
    return { position: new THREE.Vector3(s.x, s.leaflet * (HEAD_Y - 0.1), s.z), quaternion: q };
  });
  const cholesterol = instanced(cholGeometry, cholMaterial, cholPlacements);
  setSeeds(cholesterol, cholesterolSites.map((s) => s.seed));
  root.add(cholesterol);

  // ── Ion channel: five lumpy subunits around a ~1 nm pore ────────────────
  const channelGeometry = blobGeometry(1, 'pm-channel', 0.2, quality === 'high' ? 3 : 2);
  channelGeometry.scale(1.6, 5, 1.9);
  const channelMaterial = moleculeMaterial('#2ec4b6', { roughness: 0.5 });
  const channel = new THREE.InstancedMesh(channelGeometry, channelMaterial, CHANNEL_SUBUNITS);
  channel.position.copy(CHANNEL);
  channel.frustumCulled = false;
  root.add(channel);
  const subunitAngle = (k: number) => (k / CHANNEL_SUBUNITS) * Math.PI * 2 + 0.35;
  const subunitSpin = Array.from({ length: CHANNEL_SUBUNITS }, (_, k) => new THREE.Quaternion().setFromAxisAngle(up, k * 2.1));
  const _qYaw = new THREE.Quaternion();
  const _qTilt = new THREE.Quaternion();
  const _axis = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _one = new THREE.Vector3(1, 1, 1);
  const setGate = (open: number) => {
    for (let k = 0; k < CHANNEL_SUBUNITS; k++) {
      const a = subunitAngle(k);
      const r = CHANNEL_RING + open * 0.18;
      _p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      _qYaw.setFromAxisAngle(up, -a).multiply(subunitSpin[k]);
      _axis.set(-Math.sin(a), 0, Math.cos(a));
      _qTilt.setFromAxisAngle(_axis, -(0.07 + open * 0.06)); // lean outward at the top (a funnel)
      _qTilt.multiply(_qYaw);
      channel.setMatrixAt(k, _m.compose(_p, _qTilt, _one));
    }
    channel.instanceMatrix.needsUpdate = true;
  };
  setGate(0);

  // ── Receptor: one transmembrane helix, big outer domain, small inner domain
  const receptor = new THREE.Group();
  receptor.position.copy(RECEPTOR);
  root.add(receptor);
  const detail = quality === 'high' ? 3 : 2;
  const helix = new THREE.CylinderGeometry(0.6, 0.6, 5.6, 10);
  const stalk = new THREE.CylinderGeometry(0.5, 0.8, 1.9, 8);
  stalk.translate(0, 3.6, 0);
  const outerA = blobGeometry(1, 'pm-receptor-a', 0.2, detail);
  outerA.scale(3, 2.2, 2.6);
  outerA.translate(0.6, 7.2, 0);
  const outerB = blobGeometry(1, 'pm-receptor-b', 0.22, detail);
  outerB.scale(1.9, 1.7, 1.9);
  outerB.translate(-1.2, 5.3, 0.3);
  const inner = blobGeometry(1, 'pm-receptor-c', 0.2, detail);
  inner.scale(1.7, 1.3, 1.6);
  inner.translate(0.2, -4.1, 0.2);
  const receptorMesh = new THREE.Mesh(mergeParts([helix, stalk, outerA, outerB, inner]), moleculeMaterial('#9b7bff', { roughness: 0.5 }));
  receptor.add(receptorMesh);

  // ── Glycocalyx: branched sugar chains on glycolipids and on the receptor ─
  const beadGeometry = ballGeometry(quality === 'high' ? 1 : 0);
  const mint = new THREE.Color('#c8f5d8');
  const glyRng = rng.fork('glycans');
  interface Chain {
    beads: THREE.Vector3[];
    factor: number[];
    dir: THREE.Vector3;
  }
  const makeChain = (rootPoint: THREE.Vector3, count: number, orientation: THREE.Quaternion | null): Chain => {
    const local = glycanTree(glyRng, count, GLYCAN_STEP);
    const beads = local.map((b) => (orientation ? b.clone().applyQuaternion(orientation) : b.clone()).add(rootPoint));
    const factor = local.map((b) => Math.pow(THREE.MathUtils.clamp(b.length() / 5, 0, 1.3), 1.5));
    const a = glyRng.range(0, Math.PI * 2);
    return { beads, factor, dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) };
  };
  // Glycolipids: well-spaced outer-leaflet phospholipids away from the proteins.
  const candidates = glyRng.shuffle(phospholipidSites.filter((s) => s.leaflet === 1 && Math.abs(s.x) < HALF - 1.5 && Math.abs(s.z) < HALF - 1.2));
  const glycolipids: LipidSite[] = [];
  for (const s of candidates) {
    if (glycolipids.length >= 21) break;
    if (Math.hypot(s.x - CHANNEL.x, s.z - CHANNEL.z) < 7) continue;
    if (Math.hypot(s.x - RECEPTOR.x, s.z - RECEPTOR.z) < 7.5) continue;
    if (glycolipids.some((g) => Math.hypot(g.x - s.x, g.z - s.z) < 6.4)) continue;
    glycolipids.push(s);
  }
  const lipidChains = glycolipids.map((s) => makeChain(new THREE.Vector3(s.x, HEAD_Y + HEAD_R + 0.28, s.z), glyRng.int(5, 8), null));
  const lipidGlycanSeeds: number[] = [];
  const lipidGlycanPlacements: Placement[] = [];
  lipidChains.forEach((chain, c) => {
    chain.beads.forEach((b) => {
      lipidGlycanPlacements.push({ position: b, scale: GLYCAN_BEAD, color: mint.clone().offsetHSL(glyRng.range(-0.015, 0.015), 0, glyRng.range(-0.05, 0.04)) });
      lipidGlycanSeeds.push(glycolipids[c].seed);
    });
  });
  const glycanMaterial = instancedMaterial({ roughness: 0.5 });
  // Bloom (medium/high) already makes the pale sugars glow; without it they need more self-light.
  const glycanGlow = quality === 'low' ? 0.42 : 0.24;
  addInstanceGlow(glycanMaterial, glycanGlow, 'pmGlycan');
  addJiggle(glycanMaterial, jiggle, LIPID_JIGGLE, 1, 'pmJiggle');
  const lipidGlycans = instanced(beadGeometry, glycanMaterial, lipidGlycanPlacements);
  setSeeds(lipidGlycans, lipidGlycanSeeds);
  root.add(lipidGlycans);

  // Glycoprotein: chains on the receptor's outer domain (in the receptor's frame).
  const receptorAttach = [
    { at: new THREE.Vector3(-1.9, 8.4, 1.0), out: new THREE.Vector3(-0.6, 1, 0.3) },
    { at: new THREE.Vector3(2.8, 8.3, -0.6), out: new THREE.Vector3(0.6, 1, -0.2) },
    { at: new THREE.Vector3(0.9, 9.1, 1.4), out: new THREE.Vector3(0.1, 1, 0.5) },
    { at: new THREE.Vector3(-2.6, 5.6, -1.2), out: new THREE.Vector3(-1, 0.7, -0.4) },
  ];
  const receptorChains = receptorAttach.map((a, i) =>
    makeChain(a.at, [9, 8, 10, 7][i], new THREE.Quaternion().setFromUnitVectors(up, a.out.clone().normalize())),
  );
  const receptorGlycanPlacements: Placement[] = [];
  receptorChains.forEach((chain) =>
    chain.beads.forEach((b) => receptorGlycanPlacements.push({ position: b, scale: GLYCAN_BEAD, color: mint.clone().offsetHSL(0, 0, glyRng.range(-0.05, 0.04)) })),
  );
  const receptorGlycanMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(receptorGlycanMaterial, glycanGlow, 'pmGlycan');
  const receptorGlycans = instanced(beadGeometry, receptorGlycanMaterial, receptorGlycanPlacements);
  receptor.add(receptorGlycans);

  // ── Actin filament of the cortex, ~5 nm below the inner leaflet surface ──
  const actinCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-HALF - 7, -11, 14.8),
    new THREE.Vector3(-8, -11.3, 16.6),
    new THREE.Vector3(9, -11, 16.4),
    new THREE.Vector3(HALF + 7, -11.2, 14.4),
  ]);
  const actin = actinFilament({ curve: actinCurve, quality, color: '#ff9f9f', seed: 'pm-actin' });
  root.add(actin.mesh);

  // ── Ions: bursts through the channel, plus a few wandering in solution ──
  const ionCount = BURST + AMBIENT_OUT + AMBIENT_IN;
  const ions = glowPoints({ count: ionCount, color: '#9ff7ff', size: 0.95, pointScale: ctx.pointScale });
  // Dim copy drawn through the protein, so the single file inside the pore stays visible.
  const ionsInPore = glowPoints({ count: ionCount, color: '#9ff7ff', size: 0.95, pointScale: ctx.pointScale, opacity: 0.6, depthTest: false, share: ions });
  ionsInPore.alphas.fill(0);
  root.add(ions.points, ionsInPore.points);
  const ionRng = rng.fork('ions');
  const mouth = CHANNEL.clone().add(new THREE.Vector3(0, 5.8, 0));
  const bottom = CHANNEL.clone().add(new THREE.Vector3(0, -5.8, 0));
  const burst = Array.from({ length: BURST }, (_, i) => {
    const a = -0.4 + (i / BURST) * Math.PI * 2 + ionRng.range(-0.3, 0.3);
    const rho = ionRng.range(5.5, 9);
    const start = CHANNEL.clone().add(new THREE.Vector3(Math.cos(a) * rho, ionRng.range(7.5, 11), Math.sin(a) * rho));
    // Leave toward the front (+z) and sides, in front of the cortex filament.
    const end = CHANNEL.clone().add(new THREE.Vector3(ionRng.range(-7, 7), ionRng.range(-8.5, -6.5), ionRng.range(5.5, 9)));
    const c1 = mouth.clone().add(new THREE.Vector3((start.x - mouth.x) * 0.25, 2.5, (start.z - mouth.z) * 0.25));
    const c2 = bottom.clone().add(new THREE.Vector3((end.x - bottom.x) * 0.2, -2.2, (end.z - bottom.z) * 0.2));
    return { start, end, c1, c2 };
  });
  const ambient = Array.from({ length: AMBIENT_OUT + AMBIENT_IN }, (_, i) => {
    const outside = i < AMBIENT_OUT;
    return new THREE.Vector3(ionRng.range(-HALF + 2, HALF - 2), outside ? ionRng.range(5, 13) : ionRng.range(-6, -13), ionRng.range(-HALF + 2, HALF - 2));
  });
  const _ion = new THREE.Vector3();

  // ── Labels ──────────────────────────────────────────────────────────────
  const nearestFront = (list: LipidSite[], x: number) =>
    list.filter((s) => s.leaflet === 1).reduce((best, s) => (s.z - Math.abs(s.x - x) * 0.4 > best.z - Math.abs(best.x - x) * 0.4 ? s : best));
  const frontHead = nearestFront(phospholipidSites, -2.5);
  const frontChol = nearestFront(cholesterolSites, 13.5);
  const glycoChain = lipidChains.reduce((best, c) => (c.beads[0].distanceTo(new THREE.Vector3(-3, 0, 3)) < best.beads[0].distanceTo(new THREE.Vector3(-3, 0, 3)) ? c : best));
  const glycoTop = glycoChain.beads.reduce((top, b) => (b.y > top.y ? b : top));
  const labels = [
    { part: 'bilayer', anchor: anchorOn(root, new THREE.Vector3(HALF, -0.6, 4)) },
    { part: 'phospholipid', anchor: anchorOn(root, new THREE.Vector3(frontHead.x, HEAD_Y + 0.2, frontHead.z + 0.35)) },
    { part: 'cholesterol', anchor: anchorOn(root, new THREE.Vector3(frontChol.x, HEAD_Y - 0.1 - CHOLESTEROL_LENGTH * 0.45, frontChol.z + 0.4)) },
    { part: 'channel', anchor: anchorOn(root, CHANNEL.clone().add(new THREE.Vector3(2.4, 4.2, 1.2))) },
    { part: 'receptor', anchor: anchorOn(receptor, new THREE.Vector3(1.6, 8.6, 1.6)) },
    { part: 'glycocalyx', anchor: anchorOn(root, glycoTop.clone()) },
    { textKey: 'structures.actin.parts.cortex.name', anchor: anchorOn(root, actinCurve.getPointAt(0.86).add(new THREE.Vector3(0, -1.5, 3.2))) },
    { textKey: 'closeupCaptions.outside', anchor: anchorOn(root, new THREE.Vector3(-14, 12, -12)) },
    { textKey: 'closeupCaptions.cytosol', anchor: anchorOn(root, new THREE.Vector3(-2, -14, 22)) },
  ];

  const _bead = new THREE.Vector3();
  const _q0 = new THREE.Quaternion();
  const _beadScale = new THREE.Vector3().setScalar(GLYCAN_BEAD);
  const swayChains = (mesh: THREE.InstancedMesh, chains: Chain[], t: number, amp: number, offset: number) => {
    let index = 0;
    chains.forEach((chain, c) => {
      const k = c + offset;
      const s1 = noise.noise(k * 3.7, t * 0.32, 0.5) * amp;
      const s2 = noise.noise(k * 3.7, t * 0.32, 7.5) * amp * 0.6;
      chain.beads.forEach((b, i) => {
        const f = chain.factor[i];
        _bead.set(b.x + (chain.dir.x * s1 - chain.dir.z * s2) * f, b.y, b.z + (chain.dir.z * s1 + chain.dir.x * s2) * f);
        mesh.setMatrixAt(index++, _m.compose(_bead, _q0, _beadScale));
      });
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, -1, 3),
        radius: 29,
        direction: new THREE.Vector3(0.28, 0.8, 1).normalize(),
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      const amp = calm ? 0.35 : 1;

      // Sugar chains sway slowly (their lipid's jiggle is added in the shader).
      swayChains(lipidGlycans, lipidChains, t, 1.1 * amp, 0);
      swayChains(receptorGlycans, receptorChains, t, 1.1 * amp, 40);

      // Receptor: gentle wobble about its transmembrane helix.
      receptor.rotation.set(
        noise.noise(t * 0.3, 11.1, 0) * 0.07 * amp,
        noise.noise(t * 0.18, 12.2, 0) * 0.2 * amp,
        noise.noise(t * 0.3, 13.3, 0) * 0.07 * amp,
      );

      // Ion burst: approach the outer mouth, single file down the pore, spread into the cytosol.
      const local = ((t % ION_PERIOD) + ION_PERIOD) % ION_PERIOD;
      for (let i = 0; i < BURST; i++) {
        const s = local - (ION_START + i * ION_GAP);
        const ion = burst[i];
        let alpha = 0;
        let pore = 0;
        if (s >= 0 && s < ION_APPROACH) {
          bezier(ion.start, ion.c1, mouth, sstep(0, 1, s / ION_APPROACH) * 0.85 + (s / ION_APPROACH) * 0.15, _ion);
          alpha = Math.min(1, s / 0.3);
        } else if (s >= ION_APPROACH && s < ION_APPROACH + ION_TRANSIT) {
          const u = (s - ION_APPROACH) / ION_TRANSIT;
          _ion.lerpVectors(mouth, bottom, u);
          alpha = 1;
          pore = Math.min(1, u / 0.15, (1 - u) / 0.15);
        } else if (s >= ION_APPROACH + ION_TRANSIT && s < ION_APPROACH + ION_TRANSIT + ION_EXIT) {
          const u = (s - ION_APPROACH - ION_TRANSIT) / ION_EXIT;
          bezier(bottom, ion.c2, ion.end, 1 - (1 - u) * (1 - u), _ion);
          alpha = Math.min(1, (1 - u) / 0.45);
        } else {
          _ion.copy(ion.start);
        }
        ions.positions[i * 3] = _ion.x;
        ions.positions[i * 3 + 1] = _ion.y;
        ions.positions[i * 3 + 2] = _ion.z;
        ions.alphas[i] = alpha;
        ionsInPore.alphas[i] = pore;
      }
      const wander = calm ? 0.6 : 1.6;
      for (let j = 0; j < ambient.length; j++) {
        const home = ambient[j];
        const k = BURST + j;
        ions.positions[k * 3] = home.x + noise.noise(j * 5.3, t * 0.22, 1) * wander;
        ions.positions[k * 3 + 1] = home.y + noise.noise(j * 5.3, t * 0.22, 4) * wander * 0.6;
        ions.positions[k * 3 + 2] = home.z + noise.noise(j * 5.3, t * 0.22, 9) * wander;
        ions.alphas[k] = 0.75;
      }
      ions.commit();
      ionsInPore.commit();

      // The gate widens slightly while ions stream through.
      const open = pulse(local, GATE_OPEN, GATE_CLOSE, 0.35);
      setGate(open);
      channelMaterial.emissiveIntensity = 0.16 + open * 0.12;
    },
    dispose() {
      lipids.dispose();
      actin.dispose();
      ions.dispose();
      ionsInPore.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
