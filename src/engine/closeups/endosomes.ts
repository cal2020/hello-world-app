import * as THREE from 'three';
import { Rng } from '../core/random';
import { mergeGeometries } from '../core/geometry';
import { blobGeometry, createCloseupScene, disposeScene, easeInOut, smooth } from './common';
import { addInstanceGlow, addJiggle, bilayerStripGeometry, byQuality, createJiggle, instanced, instancedMaterial, randomQuaternion, setSeeds, type Placement } from './kit';
import { addHoleClip, cutBowl, cutFaceMaterial, FusionNeck, membraneBands, membraneMaterial, wander, type HoleClip } from './energyParts';
import { clathrinCage, cutTubule, RECEPTOR_BIND, receptorGeometry, SampledCurve } from './endosomesParts';
import type { CloseupFactory, CloseupLabel } from './types';

/**
 * Endosomal sorting (1 unit = 1 nm), three numbered events in a 27-s loop:
 * 1 Uptake — receptors (blue) with cargo (yellow) gather in a clathrin-coated
 *   pit that deepens, pinches off, uncoats and fuses with the early endosome.
 * 2 Recycling — in the acidic endosome the cargo lets go; the empty receptors
 *   return to the plasma membrane through a recycling tubule.
 * 3 Degradation — the endosome matures (deeper colour, intraluminal vesicles),
 *   moves to the lysosome (violet) and fuses with it; the cargo is broken down.
 * Everything is cut open in the plane z = 0; outside the cell is at the top.
 */

const LOOP = 27;
const MEMBRANE = 5;
const NECK = 6;
const Y_PM = 200; // plasma-membrane mid-plane
const PM_X = 360;
const PM_BACK = -150;
const PIT_X = -150;
const R_V = 40; // coated vesicle membrane (80 nm)
const R_CAGE = 56; // clathrin coat (≈110 nm across)
const E0 = new THREE.Vector3(-60, -45, 0);
const R_EN = 125; // early endosome (250 nm)
const L_C = new THREE.Vector3(205, -235, 0);
const R_LY = 115; // lysosome (230 nm)
const TUBE_R = 25; // recycling tubule (50 nm wide)
const TUBE_ANGLE = 38;
const FUSE_ANGLE = 112; // where the coated vesicle meets the endosome
const RECEPTORS = 6;

const T = {
  gather: [0.3, 2.2],
  pit: [2.0, 5.6],
  move: [5.6, 7.7],
  uncoat: [6.5, 7.2],
  pore: [7.8, 8.4],
  merge: [8.4, 9.4],
  release: [9.6, 11.4],
  slide: [11.2, 12.8],
  grow: [11.4, 13.0],
  travel: [13.0, 15.0],
  retract: [15.4, 16.8],
  spread: [15.6, 24.0],
  mature: [17.2, 19.6],
  ilv: [17.4, 20.0],
  toLyso: [19.6, 21.6],
  lysoPore: [21.6, 22.4],
  transfer: [22.0, 23.6],
  lysoMerge: [23.2, 24.6],
  breakdown: [23.8, 25.6],
  reset: [25.6, 27.0],
  newCargo: [25.8, 26.8],
};
const EVENTS = { uptake: [0, 9.6], recycling: [9.6, 17.0], degradation: [17.0, 27.0], pitLabel: [2.7, 6.3], home: [T.travel[1] + 0.6, T.spread[1]] };

const COLORS = {
  pm: '#b9c8f2',
  pmInner: '#55638f',
  early: '#4cc9f0',
  earlyInner: '#1f5f7a',
  late: '#5b6cff',
  lateInner: '#2a2f78',
  lysosome: '#c77dff',
  lysosomeInner: '#5b3488',
  receptor: '#4d7cff',
  cargo: '#ffd166',
  clathrin: '#e6e9f0',
  ilv: '#9fd8ff',
  hydrolase: '#8f5bff',
};

const deg = THREE.MathUtils.degToRad;
const dirAt = (degrees: number, target: THREE.Vector3, z = 0) => target.set(Math.cos(deg(degrees)), Math.sin(deg(degrees)), z).normalize();
const inWindow = (t: number, w: number[]) => t >= w[0] && t < w[1];
const phase = (t: number, w: number[]) => THREE.MathUtils.clamp((t - w[0]) / (w[1] - w[0]), 0, 1);

const create: CloseupFactory = (ctx) => {
  const quality = ctx.quality;
  const scene = createCloseupScene('#0a1426');
  const rng = new Rng('closeup:endosomes');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);
  const disposables: { dispose(): void }[] = [];
  const radial = quality === 'low' ? 6 : 8;

  // ── Plasma membrane (outside above), with an opening where the pit forms ──
  const pitHole: HoleClip = { center: new THREE.Vector3(PIT_X, Y_PM + 10, 0), axis: new THREE.Vector3(0, -1, 0), radius: { value: 0 } };
  const pmWidth = PM_X * 2;
  const pmDepth = -PM_BACK;
  const pmTop = new THREE.PlaneGeometry(pmWidth, pmDepth, 48, 8);
  pmTop.rotateX(-Math.PI / 2);
  pmTop.translate(0, Y_PM + MEMBRANE / 2, PM_BACK / 2);
  const pmBottom = new THREE.PlaneGeometry(pmWidth, pmDepth, 48, 8);
  pmBottom.rotateX(Math.PI / 2);
  pmBottom.translate(0, Y_PM - MEMBRANE / 2, PM_BACK / 2);
  const pmFaces = mergeGeometries([pmTop, pmBottom])!;
  pmTop.dispose();
  pmBottom.dispose();
  const pmMaterial = membraneMaterial(COLORS.pm, { side: THREE.DoubleSide, rim: 0.3 });
  addHoleClip(pmMaterial, pitHole, 'pmPit');
  const pmEdge = bilayerStripGeometry(pmWidth, MEMBRANE);
  pmEdge.translate(0, Y_PM, 0.05);
  const pmEdgeMaterial = cutFaceMaterial(0.25);
  addHoleClip(pmEdgeMaterial, pitHole, 'pmPitEdge');
  root.add(new THREE.Mesh(pmFaces, pmMaterial), new THREE.Mesh(pmEdge, pmEdgeMaterial));

  // ── Coated pit / vesicle (cut open), clipped at the membrane plane while attached ──
  const pmPlane: HoleClip = { center: new THREE.Vector3(PIT_X, Y_PM, 0), axis: new THREE.Vector3(0, 1, 0), radius: { value: 1e5 } };
  const vesicleHole: HoleClip = { center: new THREE.Vector3(), axis: new THREE.Vector3(), radius: { value: 0 } };
  const vesicle = cutBowl({ radius: R_V, thickness: MEMBRANE, color: COLORS.pm, innerColor: COLORS.pmInner, segments: byQuality(quality, { low: 32, medium: 40, high: 48 }) });
  vesicle.children.forEach((child, i) => addHoleClip((child as THREE.Mesh).material as THREE.Material, [pmPlane, vesicleHole], `vesicle${i}`));
  root.add(vesicle);

  // Clathrin lattice: struts and triskelion hubs on the cytosolic side.
  const cage = clathrinCage();
  const cageTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.2, 0.1));
  const hubDirs = cage.vertices.map((v) => v.clone().applyQuaternion(cageTilt));
  const strutShape = new THREE.CylinderGeometry(1.5, 1.5, 1, 5, 1, true);
  const hubShape = new THREE.IcosahedronGeometry(2.6, 0);
  disposables.push(strutShape, hubShape);
  const clathrinMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(clathrinMaterial, 0.3, 'clathrin');
  const struts = new THREE.InstancedMesh(strutShape, clathrinMaterial, cage.edges.length);
  const hubs = new THREE.InstancedMesh(hubShape, clathrinMaterial, cage.vertices.length);
  struts.frustumCulled = false;
  hubs.frustumCulled = false;
  const clathrinColor = new THREE.Color(COLORS.clathrin);
  for (let i = 0; i < cage.edges.length; i++) struts.setColorAt(i, clathrinColor);
  for (let i = 0; i < cage.vertices.length; i++) hubs.setColorAt(i, clathrinColor);
  const strutDelay = cage.edges.map(() => rng.range(0, 0.55));
  const hubDelay = cage.vertices.map(() => rng.range(0, 0.55));
  root.add(struts, hubs);

  // ── Early → late endosome (cut open), with openings for fusion and the tubule ──
  const tubeHole: HoleClip = { center: E0.clone(), axis: dirAt(TUBE_ANGLE, new THREE.Vector3()), radius: { value: 0 } };
  const vesicleFusion: HoleClip = { center: E0.clone(), axis: dirAt(FUSE_ANGLE, new THREE.Vector3()), radius: { value: 0 } };
  const lysoFusion: HoleClip = { center: new THREE.Vector3(), axis: new THREE.Vector3(), radius: { value: 0 } };
  const endosome = cutBowl({ radius: R_EN, thickness: MEMBRANE, color: COLORS.early, innerColor: COLORS.earlyInner, segments: byQuality(quality, { low: 48, medium: 64, high: 80 }) });
  const endoMaterials = endosome.children.map((child) => (child as THREE.Mesh).material as THREE.MeshStandardMaterial);
  endoMaterials.forEach((material, i) => {
    material.transparent = true;
    addHoleClip(material, [tubeHole, vesicleFusion, lysoFusion], `endo${i}`);
  });
  root.add(endosome);
  const earlyColor = new THREE.Color(COLORS.early);
  const lateColor = new THREE.Color(COLORS.late);
  const earlyInner = new THREE.Color(COLORS.earlyInner);
  const lateInner = new THREE.Color(COLORS.lateInner);

  // Recycling tubule from the endosome to the plasma membrane.
  const tubeStart = E0.clone().add(dirAt(TUBE_ANGLE, new THREE.Vector3()).multiplyScalar(R_EN - 8));
  const tubeCurve = new THREE.CatmullRomCurve3([
    tubeStart,
    E0.clone().add(dirAt(TUBE_ANGLE, new THREE.Vector3()).multiplyScalar(R_EN + 30)),
    new THREE.Vector3(90, 112, 0),
    new THREE.Vector3(102, Y_PM - MEMBRANE / 2 - TUBE_R - 1, 0),
  ]);
  const tubePath = new SampledCurve(tubeCurve, 160);
  const tubeEnd = tubePath.point(1, new THREE.Vector3());
  const tubule = cutTubule(tubeCurve, TUBE_R, MEMBRANE, COLORS.early, COLORS.earlyInner, 48, byQuality(quality, { low: 12, medium: 16, high: 20 }));
  root.add(tubule.group);
  disposables.push(tubule);

  // ── Lysosome (violet) ──
  const lysoHole: HoleClip = { center: L_C.clone(), axis: new THREE.Vector3(), radius: { value: 0 } };
  const lysosome = cutBowl({ radius: R_LY, thickness: MEMBRANE, color: COLORS.lysosome, innerColor: COLORS.lysosomeInner, segments: byQuality(quality, { low: 48, medium: 64, high: 80 }) });
  lysosome.position.copy(L_C);
  lysosome.children.forEach((child, i) => addHoleClip((child as THREE.Mesh).material as THREE.Material, lysoHole, `lyso${i}`));
  root.add(lysosome);
  const hydroShape = blobGeometry(1, 'endo-hydrolase', 0.3, 1);
  disposables.push(hydroShape);
  const hydroMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(hydroMaterial, 0.25, 'endoHydrolase');
  addJiggle(hydroMaterial, jiggle, new THREE.Vector3(2, 2, 2), 0.5, 'endoHydroJiggle');
  const hydroPlacements: Placement[] = [];
  for (let i = 0; i < 10; i++) {
    const p = rng.inBall(new THREE.Vector3()).multiplyScalar(R_LY - 25);
    p.z = -Math.abs(p.z) - 15;
    hydroPlacements.push({ position: p.add(L_C), quaternion: randomQuaternion(rng), scale: rng.range(3, 4.2), color: new THREE.Color(COLORS.hydrolase).offsetHSL(0, 0, rng.range(-0.06, 0.06)) });
  }
  const hydrolases = instanced(hydroShape, hydroMaterial, hydroPlacements);
  setSeeds(
    hydrolases,
    hydroPlacements.map((_, i) => i),
  );
  root.add(hydrolases);

  // Fusion necks (vesicle → endosome, endosome → lysosome).
  const bands = membraneBands('#f1e3c8', '#b08a3e');
  const vesicleNeck = new FusionNeck(
    [membraneMaterial(COLORS.early, { side: THREE.FrontSide }), membraneMaterial(COLORS.earlyInner, { side: THREE.BackSide, rim: 0.25 })],
    cutFaceMaterial(0.25),
    MEMBRANE,
    bands,
    16,
  );
  const lysoNeck = new FusionNeck(
    [membraneMaterial(COLORS.lysosome, { side: THREE.FrontSide }), membraneMaterial(COLORS.lysosomeInner, { side: THREE.BackSide, rim: 0.25 })],
    cutFaceMaterial(0.25),
    MEMBRANE,
    bands,
    20,
  );
  root.add(vesicleNeck.group, lysoNeck.group);
  disposables.push(vesicleNeck, lysoNeck);

  // ── Receptors (blue) and cargo (yellow) ──
  const receptorShape = receptorGeometry(radial);
  disposables.push(receptorShape);
  const receptorMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(receptorMaterial, 0.3, 'receptors');
  const receptors = new THREE.InstancedMesh(receptorShape, receptorMaterial, RECEPTORS);
  receptors.frustumCulled = false;
  for (let k = 0; k < RECEPTORS; k++) receptors.setColorAt(k, new THREE.Color(COLORS.receptor).offsetHSL(0, 0, k * 0.012));
  const cargoShape = blobGeometry(1, 'endo-cargo', 0.25, 1);
  disposables.push(cargoShape);
  const cargoMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(cargoMaterial, 0.35, 'endoCargo');
  const cargo = new THREE.InstancedMesh(cargoShape, cargoMaterial, RECEPTORS);
  const fragments = new THREE.InstancedMesh(cargoShape, cargoMaterial, RECEPTORS * 4);
  cargo.frustumCulled = false;
  fragments.frustumCulled = false;
  for (let k = 0; k < RECEPTORS; k++) cargo.setColorAt(k, new THREE.Color(COLORS.cargo));
  for (let k = 0; k < RECEPTORS * 4; k++) fragments.setColorAt(k, new THREE.Color(COLORS.cargo).offsetHSL(0, 0, -0.05));
  root.add(receptors, cargo, fragments);
  const homes = [-236, -212, -190, -112, -88, -62];
  const pitSpots = [-30, -18, -6, 6, 18, 30].map((dx) => PIT_X + dx);
  const budAngles = [-158, -136, -114, -66, -44, -22];
  const budDirs = budAngles.map((a) => dirAt(a, new THREE.Vector3(), -0.08));
  const lumenSpots = Array.from({ length: RECEPTORS }, () => new THREE.Vector3(rng.range(-55, 55), rng.range(-50, 45), rng.range(-55, -22)));
  const lysoSpots = Array.from({ length: RECEPTORS }, () => new THREE.Vector3(rng.range(-50, 40), rng.range(-50, 40), rng.range(-60, -25)));
  const fragmentDirs = Array.from({ length: RECEPTORS * 4 }, () => rng.direction(new THREE.Vector3()));

  // ── Intraluminal vesicles (bud inward as the endosome matures) ──
  const ilvShape = new THREE.SphereGeometry(1, 20, 14);
  disposables.push(ilvShape);
  const ilvMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(ilvMaterial, 0.18, 'endoIlv');
  const ilvSpecs = [
    { dir: new THREE.Vector3(-0.55, -0.45, -0.7).normalize(), r: 24, lyso: new THREE.Vector3(-30, -40, -55) },
    { dir: new THREE.Vector3(0.6, -0.5, -0.62).normalize(), r: 22, lyso: new THREE.Vector3(35, 10, -60) },
    { dir: new THREE.Vector3(-0.2, 0.55, -0.81).normalize(), r: 25, lyso: new THREE.Vector3(-10, 45, -50) },
    { dir: new THREE.Vector3(-0.78, 0.2, -0.59).normalize(), r: 21, lyso: new THREE.Vector3(-55, 5, -45) },
    { dir: new THREE.Vector3(0.25, -0.75, -0.6).normalize(), r: 23, lyso: new THREE.Vector3(10, -55, -40) },
  ];
  const ilvs = new THREE.InstancedMesh(ilvShape, ilvMaterial, ilvSpecs.length);
  ilvs.frustumCulled = false;
  ilvSpecs.forEach((_, i) => ilvs.setColorAt(i, new THREE.Color(COLORS.ilv)));
  root.add(ilvs);
  const ilvPositions = ilvSpecs.map(() => new THREE.Vector3());

  // ── Scratch state (no allocation per frame) ──
  const UP = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const dirTmp = new THREE.Vector3();
  const sideTmp = new THREE.Vector3();
  const vesicleCenter = new THREE.Vector3();
  const endoCenter = new THREE.Vector3();
  const neckA = new THREE.Vector3();
  const neckB = new THREE.Vector3();
  const fuseDir = dirAt(FUSE_ANGLE, new THREE.Vector3());
  const lysoDir = L_C.clone().sub(E0).normalize();
  const eContact = L_C.clone().addScaledVector(lysoDir, -(R_LY + NECK + R_EN));
  const vesicleStart = new THREE.Vector3(PIT_X, Y_PM - R_V - 1, 0);
  const vesicleContact = E0.clone().addScaledVector(fuseDir, R_EN + NECK + R_V);
  const receptorPos = Array.from({ length: RECEPTORS }, () => new THREE.Vector3());
  const receptorDir = Array.from({ length: RECEPTORS }, () => new THREE.Vector3(0, 1, 0));
  const cargoPos = Array.from({ length: RECEPTORS }, () => new THREE.Vector3());
  const state = { budY: Y_PM + R_V, vesicleScale: 1, vesicleVisible: false, endoScale: 1, endoOpacity: 1, maturity: 0, cargoScale: 1, ilvVisible: false, grow: 0 };
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  lysoHole.axis.copy(lysoDir).negate();

  const placeOnSphere = (center: THREE.Vector3, radius: number, angleDeg: number, z: number, pos: THREE.Vector3, dir: THREE.Vector3) => {
    dirAt(angleDeg, dir, z);
    pos.copy(center).addScaledVector(dir, radius);
    dir.negate();
  };

  const update = (t: number, calm: boolean) => {
    const amp = calm ? 0.35 : 1;
    const lt = ((t % LOOP) + LOOP) % LOOP;

    // 1 Uptake: the bud deepens and pinches off (its centre sinks through the membrane plane).
    let budY = Y_PM + R_V;
    if (lt >= T.pit[0] && lt < T.pit[1]) budY = THREE.MathUtils.lerp(Y_PM + R_V - 2, Y_PM - R_V - 1, smooth(phase(lt, T.pit)));
    const attached = lt >= T.pit[0] && lt < T.pit[1];
    const pitDepth = Y_PM - budY;
    pitHole.radius.value = attached && Math.abs(pitDepth) < R_V ? Math.sqrt(R_V * R_V - pitDepth * pitDepth) : 0;
    pmPlane.radius.value = attached ? 1e5 : 0;
    // Vesicle path, pore and merging into the endosome.
    let vesicleScale = 1;
    let rhoV = 0;
    if (attached) vesicleCenter.set(PIT_X, budY, 0);
    else if (lt >= T.move[0] && lt < T.pore[0]) vesicleCenter.lerpVectors(vesicleStart, vesicleContact, easeInOut(phase(lt, T.move)));
    else if (lt >= T.pore[0] && lt < T.merge[1]) {
      rhoV = 24 * smooth(phase(lt, T.pore));
      if (lt >= T.merge[0]) {
        vesicleScale = 1 - easeInOut(phase(lt, T.merge));
        rhoV = Math.min(rhoV, 0.8 * R_V * vesicleScale);
      }
      const rv = R_V * vesicleScale;
      vesicleCenter.copy(E0).addScaledVector(fuseDir, Math.sqrt(R_EN * R_EN - rhoV * rhoV) + NECK + Math.sqrt(Math.max(0, rv * rv - rhoV * rhoV)));
    }
    state.vesicleVisible = (attached && pitDepth > -R_V) || (lt >= T.move[0] && lt < T.merge[1] && vesicleScale > 0.02);
    vesicle.visible = state.vesicleVisible;
    vesicle.position.copy(vesicleCenter);
    vesicle.scale.setScalar(Math.max(0.001, vesicleScale));
    vesicleHole.center.copy(vesicleCenter);
    vesicleHole.axis.copy(fuseDir).negate();
    vesicleHole.radius.value = rhoV;
    vesicleFusion.radius.value = rhoV;
    neckA.copy(vesicleCenter).addScaledVector(fuseDir, -Math.sqrt(Math.max(0, ((R_V - MEMBRANE) * vesicleScale) ** 2 - rhoV * rhoV)));
    neckB.copy(E0).addScaledVector(fuseDir, Math.sqrt((R_EN - MEMBRANE) ** 2 - rhoV * rhoV));
    vesicleNeck.set(neckA, neckB, state.vesicleVisible ? rhoV : 0);

    // Clathrin: assembled below the membrane while the pit forms, shed after pinching off.
    const coatOn = state.vesicleVisible && lt < T.uncoat[1] + 0.8;
    for (let e = 0; e < cage.edges.length; e++) {
      const [i, j] = cage.edges[e];
      v.addVectors(hubDirs[i], hubDirs[j]).multiplyScalar(0.5 * R_CAGE).add(vesicleCenter);
      const shed = smooth((lt - T.uncoat[0] - strutDelay[e]) / 0.35);
      const visible = coatOn && v.z <= 3 && (!attached || v.y < Y_PM - 6) && shed < 0.99;
      if (!visible) {
        struts.setMatrixAt(e, hidden);
        continue;
      }
      w.subVectors(hubDirs[j], hubDirs[i]);
      const length = w.length() * R_CAGE;
      q.setFromUnitVectors(UP, w.normalize());
      tmp.subVectors(v, vesicleCenter).normalize();
      v.addScaledVector(tmp, shed * 14);
      struts.setMatrixAt(e, m.compose(v, q, s.set(1 - shed, length * (1 - shed * 0.5), 1 - shed)));
    }
    for (let i = 0; i < cage.vertices.length; i++) {
      v.copy(hubDirs[i]).multiplyScalar(R_CAGE).add(vesicleCenter);
      const shed = smooth((lt - T.uncoat[0] - hubDelay[i]) / 0.35);
      const visible = coatOn && v.z <= 3 && (!attached || v.y < Y_PM - 6) && shed < 0.99;
      if (!visible) {
        hubs.setMatrixAt(i, hidden);
        continue;
      }
      v.addScaledVector(hubDirs[i], shed * 14);
      hubs.setMatrixAt(i, m.compose(v, q.identity(), s.setScalar(1 - shed)));
    }
    struts.instanceMatrix.needsUpdate = true;
    hubs.instanceMatrix.needsUpdate = true;

    // 2 Recycling tubule.
    let grow = 0;
    if (lt >= T.grow[0] && lt < T.retract[0]) grow = easeInOut(phase(lt, T.grow));
    else if (lt >= T.retract[0] && lt < T.retract[1]) grow = 1 - easeInOut(phase(lt, T.retract));
    state.grow = grow;
    tubule.grow.value = grow;
    tubule.group.visible = grow > 0.005;
    tubule.update();
    tubeHole.radius.value = grow > 0.005 ? TUBE_R - 1 : 0;

    // 3 Degradation: maturation, move to the lysosome, fusion and merging.
    const maturity = smooth(phase(lt, T.mature)) * (lt < T.reset[0] ? 1 : 0);
    state.maturity = maturity;
    let endoScale = 1;
    let rhoL = 0;
    if (lt < T.toLyso[0] || lt >= T.reset[0]) endoCenter.copy(E0);
    else if (lt < T.lysoPore[0]) endoCenter.lerpVectors(E0, eContact, easeInOut(phase(lt, T.toLyso)));
    else {
      rhoL = 50 * smooth(phase(lt, T.lysoPore));
      if (lt >= T.lysoMerge[0]) {
        endoScale = 1 - easeInOut(phase(lt, T.lysoMerge));
        rhoL = Math.min(rhoL, 0.8 * R_EN * endoScale);
      }
      const re = R_EN * endoScale;
      endoCenter.copy(L_C).addScaledVector(lysoDir, -(Math.sqrt(R_LY * R_LY - rhoL * rhoL) + NECK + Math.sqrt(Math.max(0, re * re - rhoL * rhoL))));
    }
    const endoOpacity = lt >= T.reset[0] ? smooth(phase(lt, T.reset)) : 1;
    state.endoScale = endoScale;
    state.endoOpacity = endoOpacity;
    endosome.visible = endoScale > 0.02 && endoOpacity > 0.01 && !(lt >= T.lysoMerge[1] && lt < T.reset[0]);
    endosome.position.copy(endoCenter);
    endosome.scale.setScalar(Math.max(0.001, endoScale) * (0.92 + 0.08 * endoOpacity));
    for (let i = 0; i < endoMaterials.length; i++) {
      const material = endoMaterials[i];
      material.opacity = endoOpacity;
      if (i === 2) continue;
      const c = i === 0 ? material.color.copy(earlyColor).lerp(lateColor, maturity) : material.color.copy(earlyInner).lerp(lateInner, maturity);
      material.emissive.copy(c);
    }
    tubeHole.center.copy(endoCenter);
    vesicleFusion.center.copy(endoCenter);
    lysoFusion.center.copy(endoCenter);
    lysoFusion.axis.copy(lysoDir);
    lysoFusion.radius.value = rhoL;
    lysoHole.radius.value = rhoL;
    neckA.copy(endoCenter).addScaledVector(lysoDir, Math.sqrt(Math.max(0, ((R_EN - MEMBRANE) * endoScale) ** 2 - rhoL * rhoL)));
    neckB.copy(L_C).addScaledVector(lysoDir, -Math.sqrt((R_LY - MEMBRANE) ** 2 - rhoL * rhoL));
    lysoNeck.set(neckA, neckB, endosome.visible ? rhoL : 0);

    // Receptors: PM → pit → vesicle → endosome → tubule → PM.
    for (let k = 0; k < RECEPTORS; k++) {
      const pos = receptorPos[k];
      const dir = receptorDir[k];
      const wall = k % 2 === 0 ? 1 : -1;
      if (lt >= T.spread[1]) {
        pos.set(homes[k], Y_PM, -3);
        dir.copy(UP);
      } else if (lt < T.pit[0]) {
        pos.set(THREE.MathUtils.lerp(homes[k], pitSpots[k], easeInOut(phase(lt, T.gather))), Y_PM, -3);
        dir.copy(UP);
      } else if (attached) {
        // On the flat membrane until the bud reaches this receptor, then on the bud.
        v.copy(vesicleCenter).addScaledVector(budDirs[k], R_V - MEMBRANE / 2);
        const into = THREE.MathUtils.smoothstep(Y_PM + 2 - v.y, 0, 10);
        pos.set(pitSpots[k], Y_PM, -3).lerp(v, into);
        dir.copy(UP).lerp(tmp.copy(budDirs[k]).negate(), into).normalize();
      } else if (lt < T.merge[0]) {
        pos.copy(vesicleCenter).addScaledVector(budDirs[k], R_V - MEMBRANE / 2);
        dir.copy(budDirs[k]).negate();
      } else if (lt < T.slide[0]) {
        const u = easeInOut(phase(lt, T.merge));
        v.copy(vesicleCenter).addScaledVector(budDirs[k], (R_V - MEMBRANE / 2) * vesicleScale);
        placeOnSphere(endoCenter, R_EN - MEMBRANE / 2, FUSE_ANGLE + (k - 2.5) * 6, -0.06, w, tmp);
        pos.lerpVectors(v, w, u);
        dir.copy(budDirs[k]).negate().lerp(tmp, u).normalize();
      } else if (lt < T.travel[0]) {
        const u = easeInOut(THREE.MathUtils.clamp((lt - T.slide[0] - k * 0.08) / (T.slide[1] - T.slide[0] - 0.4), 0, 1));
        const target = TUBE_ANGLE + wall * 10.9;
        placeOnSphere(endoCenter, R_EN - MEMBRANE / 2, THREE.MathUtils.lerp(FUSE_ANGLE + (k - 2.5) * 6, target, u), -0.04, pos, dir);
      } else if (lt < T.travel[1] + 0.6) {
        const u = smooth((lt - T.travel[0] - k * 0.12) / (T.travel[1] - T.travel[0] - 0.6));
        tubePath.point(u, v);
        tubePath.tangent(u, tmp);
        sideTmp.set(-tmp.y, tmp.x, 0).normalize();
        pos.copy(v).addScaledVector(sideTmp, wall * (TUBE_R - MEMBRANE / 2));
        pos.z = -3;
        dir.copy(sideTmp).multiplyScalar(-wall);
        const up = smooth((lt - T.travel[1] - k * 0.12 + 0.6) / 0.6);
        if (up > 0) {
          w.set(tubeEnd.x + wall * (TUBE_R - MEMBRANE / 2), Y_PM, -3);
          pos.lerp(w, up);
          dir.lerp(UP, up).normalize();
        }
      } else {
        const start = tubeEnd.x + wall * (TUBE_R - MEMBRANE / 2);
        pos.set(THREE.MathUtils.lerp(start, homes[k], easeInOut(phase(lt, EVENTS.home))), Y_PM, -3);
        dir.copy(UP);
      }
      wander(k * 3.1 + 1, lt * 0.6, 0.8 * amp, w);
      w.y *= 0.2;
      pos.add(w);
      q.setFromUnitVectors(UP, dir);
      receptors.setMatrixAt(k, m.compose(pos, q, s.setScalar(1)));
    }
    receptors.instanceMatrix.needsUpdate = true;

    // Cargo: bound until the acidic endosome makes it let go; then sent to the lysosome and broken down.
    const newCargo = smooth(phase(lt, T.newCargo));
    const breakdown = phase(lt, T.breakdown);
    state.cargoScale = lt >= T.reset[0] ? newCargo : lt >= T.breakdown[0] ? 1 - smooth(breakdown * 1.4) : 1;
    for (let k = 0; k < RECEPTORS; k++) {
      const bound = v.copy(receptorPos[k]).addScaledVector(receptorDir[k], RECEPTOR_BIND);
      const p = cargoPos[k];
      if (lt < T.release[0] || lt >= T.reset[0]) p.copy(bound);
      else {
        wander(k * 1.7 + 4, lt * 0.5, 4 * amp, w);
        tmp.copy(endoCenter).add(lumenSpots[k]).add(w);
        if (lt < T.transfer[0]) p.lerpVectors(bound, tmp, easeInOut(phase(lt, T.release)));
        else {
          const u = smooth((lt - T.transfer[0] - k * 0.12) / (T.transfer[1] - T.transfer[0] - 0.6));
          w.copy(L_C).add(lysoSpots[k]);
          p.lerpVectors(tmp, w, u);
          p.z -= Math.sin(u * Math.PI) * 10;
        }
      }
      const scale = state.cargoScale * 5;
      cargo.setMatrixAt(k, scale > 0.01 ? m.compose(p, q.identity(), s.setScalar(scale)) : hidden);
      // Breakdown: small pieces that drift apart and vanish.
      for (let f = 0; f < 4; f++) {
        const index = k * 4 + f;
        const life = smooth(breakdown * 1.6) * (1 - smooth((breakdown - 0.55) / 0.45));
        if (life < 0.01 || lt < T.breakdown[0] || lt >= T.breakdown[1]) {
          fragments.setMatrixAt(index, hidden);
          continue;
        }
        w.copy(p).addScaledVector(fragmentDirs[index], 4 + breakdown * 14);
        fragments.setMatrixAt(index, m.compose(w, q.identity(), s.setScalar(1.7 * life)));
      }
    }
    cargo.instanceMatrix.needsUpdate = true;
    fragments.instanceMatrix.needsUpdate = true;

    // Intraluminal vesicles bud inward, travel along, and are digested in the lysosome.
    state.ilvVisible = false;
    for (let i = 0; i < ilvSpecs.length; i++) {
      const spec = ilvSpecs[i];
      const g = smooth((lt - T.ilv[0] - i * 0.4) / 1.4);
      const p = ilvPositions[i];
      p.copy(endoCenter).addScaledVector(spec.dir, (R_EN - MEMBRANE) * Math.max(endoScale, 0.4) - (spec.r + 6) * g);
      const transfer = smooth((lt - T.transfer[0] - 0.3 - i * 0.15) / 1.3);
      if (transfer > 0) p.lerp(w.copy(L_C).add(spec.lyso), transfer);
      const digest = 1 - smooth((lt - T.breakdown[0] - 0.2 - i * 0.15) / 1.2);
      const r = spec.r * g * digest;
      const visible = lt >= T.ilv[0] && lt < T.reset[0] && r > 0.3;
      if (visible) state.ilvVisible = true;
      ilvs.setMatrixAt(i, visible ? m.compose(p, q.identity(), s.setScalar(r)) : hidden);
    }
    ilvs.instanceMatrix.needsUpdate = true;
  };
  update(0, false);

  // ── Labels ──
  const a = {
    pit: new THREE.Vector3(),
    early: new THREE.Vector3(),
    late: new THREE.Vector3(),
    tube: tubePath.point(0.12, new THREE.Vector3()).add(new THREE.Vector3(TUBE_R * 0.95, -TUBE_R * 0.25, 0)),
    ilv: new THREE.Vector3(),
    receptor: new THREE.Vector3(),
    lysosome: L_C.clone().add(dirAt(-12, new THREE.Vector3()).multiplyScalar(R_LY)),
    pm: new THREE.Vector3(-20, Y_PM + MEMBRANE / 2, -6),
    outside: new THREE.Vector3(20, Y_PM + 42, -10),
    uptake: new THREE.Vector3(PIT_X - 40, Y_PM + 46, 0),
    recycling: new THREE.Vector3(-10, 150, 0),
    degradation: new THREE.Vector3(40, -175, 0),
  };
  const now = () => ((time.value % LOOP) + LOOP) % LOOP;
  const labels: CloseupLabel[] = [
    { textKey: 'structures.endosomes.events.uptake', anchor: () => a.uptake, visible: () => inWindow(now(), EVENTS.uptake) },
    { textKey: 'structures.endosomes.events.recycling', anchor: () => a.recycling, visible: () => inWindow(now(), EVENTS.recycling) },
    { textKey: 'structures.endosomes.events.degradation', anchor: () => a.degradation, visible: () => inWindow(now(), EVENTS.degradation) },
    { part: 'coated-pit', anchor: () => a.pit.copy(vesicleCenter).add(dirTmp.set(0.2, -0.98, 0).multiplyScalar(R_CAGE)), visible: () => inWindow(now(), EVENTS.pitLabel) },
    {
      part: 'early-endosome',
      anchor: () => a.early.copy(endoCenter).add(dirAt(205, dirTmp).multiplyScalar(R_EN)),
      visible: () => state.maturity < 0.3 && state.endoOpacity > 0.5 && endosome.visible,
    },
    { part: 'recycling-tubule', anchor: () => a.tube, visible: () => state.grow > 0.7 },
    {
      part: 'late-endosome',
      anchor: () => a.late.copy(endoCenter).add(dirAt(205, dirTmp).multiplyScalar(R_EN * state.endoScale)),
      visible: () => state.maturity > 0.6 && state.endoScale > 0.5 && endosome.visible,
    },
    { part: 'intraluminal-vesicle', anchor: () => a.ilv.copy(ilvPositions[3]), visible: () => state.ilvVisible && now() < T.transfer[0] + 0.4 },
    { part: 'receptor', anchor: () => a.receptor.copy(receptorPos[5]).addScaledVector(receptorDir[5], 6) },
    { part: 'cargo', anchor: () => cargoPos[0], visible: () => state.cargoScale > 0.5 },
    { textKey: 'structures.lysosomes.name', anchor: () => a.lysosome },
    { textKey: 'structures.plasma-membrane.name', anchor: () => a.pm },
    { textKey: 'closeupCaptions.outside', anchor: () => a.outside },
  ];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(57, -50, -30),
        radius: 285,
        direction: new THREE.Vector3(0, 0.12, 1).normalize(),
        posterTime: 4.5, // Opens on event 1, a coated pit taking up cargo.
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
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
