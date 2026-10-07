import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import { addInstanceGlow, anchorOn, instancedMaterial } from './kit';
import { CISTERNA, cisternaColor, cisternaGeometry, coatDirections, cupOffset } from './golgiParts';
import { ballGeometry, cutawayMaterial, glycanTree, hollowBallGeometry, sstep } from './membranesParts';
import type { CloseupFactory } from './types';

/**
 * One Golgi stack in cross-section (1 unit = 10 nm), cis face left, trans
 * face and trans-Golgi network right. Five cup-shaped cisternae cut open
 * toward the camera (back halves drawn, cut walls as lighter rims).
 *
 * Cisternal maturation as a seamless 20 s loop: every cisterna moves one
 * position to the right per loop while its colour matures cis → trans; a new
 * cis cisterna grows from fusing COPII vesicles, and the oldest one — the
 * TGN — buds secretory vesicles (upper right) and clathrin-coated vesicles
 * for lysosomes (lower right) until it is used up. COPI vesicles carry
 * enzymes backward. Cargo beads ride inside the maturing cisternae while
 * their sugar sprigs grow, branch and change colour.
 */
const LOOP = 20;
const SPACING = 5.5; // 35 nm cisterna + 20 nm gap
const SACS = 6; // five cisternae + the one forming / being used up
const CARGO_PER_SAC = 7;
const SPRIG = 8;

const slotX = (p: number) => (p - 2) * SPACING;
/** Cisternae get shorter toward the trans side, so neighbouring dilated rims never collide. */
const sacRadius = (p: number) => 46 - 3 * THREE.MathUtils.clamp(p, -1, 4);

type Kind = 'copii' | 'copi' | 'secretory' | 'clathrin';
interface VesicleDef {
  kind: Kind;
  start: number;
  /** +1 = top rims / upper right, −1 = bottom rims / lower right. */
  side: 1 | -1;
  y: number;
}
const RADIUS: Record<Kind, number> = { copii: 3.3, copi: 2.5, secretory: 5, clathrin: 4 };
const COAT: Record<Kind, string | null> = { copii: '#ffcf7a', copi: '#7fd6ff', secretory: null, clathrin: '#c77dff' };
const BODY: Record<Kind, string> = { copii: '#f3e8d2', copi: '#e3f2f8', secretory: '#ff6f91', clathrin: '#efe2fb' };
const VESICLES: VesicleDef[] = [
  { kind: 'copii', start: 0.5, side: 1, y: 14 },
  { kind: 'copii', start: 5, side: -1, y: -18 },
  { kind: 'copii', start: 9.5, side: 1, y: 2 },
  { kind: 'copii', start: 14, side: -1, y: -6 },
  { kind: 'copi', start: 3, side: 1, y: 0 },
  { kind: 'copi', start: 12, side: -1, y: 0 },
  { kind: 'secretory', start: 1.5, side: 1, y: 0 },
  { kind: 'secretory', start: 9.5, side: 1, y: 0 },
  { kind: 'clathrin', start: 5.5, side: -1, y: 0 },
  { kind: 'clathrin', start: 13, side: -1, y: 0 },
];
const COPII_TRAVEL = 3;
const COPII_FUSE = 0.8;
const BUD = 3; // TGN buds grow for 3 s, then leave
const LEAVE = 4.5;
const COPI = { bud: 1.2, travel: 4, fuse: 0.8 };

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#1a1208');
  const rng = new Rng('closeup:golgi');
  const noise = new Simplex3('closeup:golgi:motion');
  const quality = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);
  const cut = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  // ── Cisternae ───────────────────────────────────────────────────────────
  const sacGeometry = cisternaGeometry(quality);
  const sacs = Array.from({ length: SACS }, () => {
    const cap = new THREE.Color();
    const material = cutawayMaterial('#ffffff', cap, cut, { emissiveIntensity: 0.14, roughness: 0.6, transparent: true, vertexColors: true });
    const mesh = new THREE.Mesh(sacGeometry, material);
    root.add(mesh);
    return { mesh, material, cap };
  });

  // Cargo beads in the lumens, each with a sugar sprig.
  const cargoRng = rng.fork('cargo');
  const cargoSlots = Array.from({ length: CARGO_PER_SAC }, (_, i) => {
    const rim = i >= CARGO_PER_SAC - 2;
    const r = rim ? CISTERNA.radius - CISTERNA.rimRadius + cargoRng.range(-0.6, 0.6) : cargoRng.range(7, 33);
    const top = i % 2 === 0;
    const phi = top ? 2 * Math.PI - cargoRng.range(0.06, 0.22) : Math.PI + cargoRng.range(0.06, 0.22);
    return { r, phi, dir: top ? 1 : -1, tree: glycanTree(cargoRng, SPRIG, 0.34) };
  });
  const beadGeometry = ballGeometry(quality === 'high' ? 1 : 0);
  const cargoMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(cargoMaterial, 0.3, 'golgiCargo');
  const cargo = new THREE.InstancedMesh(beadGeometry, cargoMaterial, SACS * CARGO_PER_SAC);
  const sugarMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(sugarMaterial, 0.35, 'golgiSugar');
  const sugars = new THREE.InstancedMesh(beadGeometry, sugarMaterial, SACS * CARGO_PER_SAC * SPRIG);
  cargo.frustumCulled = false;
  sugars.frustumCulled = false;
  const cream = new THREE.Color('#fff0c4');
  for (let i = 0; i < cargo.count; i++) cargo.setColorAt(i, cream);
  for (let i = 0; i < sugars.count; i++) sugars.setColorAt(i, cream);
  root.add(cargo, sugars);
  const sugarEarly = new THREE.Color('#c9f7cf');
  const sugarMid = new THREE.Color('#6ee77a');
  const sugarLate = new THREE.Color('#2fae4e');

  // ── Vesicles: membrane bodies plus coat subunits ────────────────────────
  const dirs = coatDirections();
  // Vesicles are cut open at the same plane as the cisternae, so their contents show.
  const bodyMaterial = cutawayMaterial('#ffffff', '#f1e7d6', cut, { emissive: '#000000', roughness: 0.5, vertexColors: true });
  addInstanceGlow(bodyMaterial, 0.22, 'golgiVesicle');
  const bodies = new THREE.InstancedMesh(hollowBallGeometry(quality === 'low' ? 1 : 2, 0.86), bodyMaterial, VESICLES.length);
  // COPI vesicles carry Golgi enzymes back: a faint blue tint of their cargo.
  VESICLES.forEach((v, i) => bodies.setColorAt(i, new THREE.Color(BODY[v.kind]).lerp(new THREE.Color('#3f8fd8'), v.kind === 'copi' ? 0.15 : 0)));
  const coated = VESICLES.filter((v) => COAT[v.kind]);
  const coatMaterial = cutawayMaterial('#ffffff', '#e6dccb', cut, { emissive: '#000000', roughness: 0.55 });
  addInstanceGlow(coatMaterial, 0.25, 'golgiCoat');
  const coats = new THREE.InstancedMesh(blobGeometry(1, 'golgi-coat', 0.25, 1), coatMaterial, coated.length * dirs.length);
  coated.forEach((v, c) => {
    const color = new THREE.Color(COAT[v.kind]!);
    for (let d = 0; d < dirs.length; d++) coats.setColorAt(c * dirs.length + d, color.clone().offsetHSL(0, 0, ((d * 5) % 3) * 0.03));
  });
  bodies.frustumCulled = false;
  coats.frustumCulled = false;
  // Contents: cargo (cream, with sugar) in COPII and secretory vesicles, Golgi enzymes (blue) in
  // COPI vesicles, lysosomal enzymes (violet) in clathrin-coated vesicles.
  const CONTENT = 3;
  const contentOffsets = [new THREE.Vector3(-0.25, 0.35, -0.5), new THREE.Vector3(0.35, -0.25, -0.9), new THREE.Vector3(-0.1, -0.3, -0.25)];
  const contentColor: Record<Kind, string> = { copii: '#fff0c4', copi: '#3f8fd8', secretory: '#fff0c4', clathrin: '#9a5ce0' };
  const contents = new THREE.InstancedMesh(beadGeometry, cargoMaterial, VESICLES.length * CONTENT);
  VESICLES.forEach((v, i) => {
    for (let c = 0; c < CONTENT; c++) contents.setColorAt(i * CONTENT + c, new THREE.Color(contentColor[v.kind]));
  });
  contents.frustumCulled = false;
  root.add(bodies, coats, contents);
  const WHITE = new THREE.Color('#ffffff');

  // Moving label anchors.
  const marks = { copii: new THREE.Object3D(), copi: new THREE.Object3D(), secretory: new THREE.Object3D(), clathrin: new THREE.Object3D() };
  root.add(marks.copii, marks.copi, marks.secretory, marks.clathrin);
  const shown = { copii: false, copi: false, secretory: false, clathrin: false };

  const rimR = CISTERNA.radius - CISTERNA.rimRadius;
  const labels = [
    { part: 'cis', anchor: anchorOn(root, new THREE.Vector3(slotX(0) - 1.9, 26, 0)) },
    { part: 'medial', anchor: anchorOn(root, new THREE.Vector3(slotX(1.5) - 1.9, 18, 0)) },
    { part: 'trans', anchor: anchorOn(root, new THREE.Vector3(slotX(3) + 1.2, -24, 0)) },
    { part: 'tgn', anchor: anchorOn(root, new THREE.Vector3(slotX(4.2) + 1.2, -6, 0)) },
    { part: 'copii', anchor: anchorOn(marks.copii, new THREE.Vector3(0, 3.3, 0)), visible: () => shown.copii },
    { part: 'copi', anchor: anchorOn(marks.copi, new THREE.Vector3(0, 2.5, 0)), visible: () => shown.copi },
    { part: 'secretory-vesicle', anchor: anchorOn(marks.secretory, new THREE.Vector3(4, -2, 0)), visible: () => shown.secretory },
    { textKey: 'closeupCaptions.toLysosomes', anchor: anchorOn(marks.clathrin, new THREE.Vector3(0, -4, 0)), visible: () => shown.clathrin },
    { textKey: 'closeupCaptions.fromEr', anchor: anchorOn(root, new THREE.Vector3(-38, 22, -2)) },
  ];

  const _p = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _s = new THREE.Vector3();
  const _color = new THREE.Color();
  const _up = new THREE.Vector3(0, 1, 0);
  const _dir = new THREE.Vector3();

  /** World state of cisterna j at loop phase tau. */
  const sacState = (j: number, tau: number, fused: number) => {
    const p = j - 1 + tau;
    let scale = sacRadius(p) / CISTERNA.radius;
    let opacity = 1;
    if (p < 0) {
      // Forming from COPII vesicles: appears with the first fusion and grows with each one.
      scale *= 0.25 + 0.75 * fused;
      opacity = sstep(0, 0.25, fused) * (0.6 + 0.4 * fused);
    } else if (p > 4.3) {
      scale *= 1 - 0.45 * sstep(4.3, 4.85, p);
      opacity = 1 - sstep(4.85, 5, p);
    }
    return { p, x: slotX(p), scale, opacity };
  };
  /** A point on the trans-facing surface of cisterna j, in its upper (+1) or lower (−1) half, at the cut. */
  const transFacePoint = (j: number, tau: number, fused: number, side: 1 | -1, target: THREE.Vector3) => {
    const s = sacState(j, tau, fused);
    const yRef = side * 0.5 * rimR;
    return target.set(s.x + cupOffset(yRef) + CISTERNA.lumenHalf + CISTERNA.membrane, yRef * s.scale, 0);
  };
  /** Top (+1) or bottom (−1) dilated rim of cisterna j, near the cut. */
  const rimPoint = (j: number, tau: number, fused: number, side: 1 | -1, target: THREE.Vector3) => {
    const s = sacState(j, tau, fused);
    return target.set(s.x + cupOffset(rimR), side * rimR * s.scale, 0);
  };

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(2, 5, -6),
        radius: 56,
        direction: new THREE.Vector3(0.12, 0.1, 1).normalize(),
        posterTime: 7.0, // Opens on vesicles arriving, recycling and leaving for lysosomes.
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      const local = ((t % LOOP) + LOOP) % LOOP;
      const tau = local / LOOP;
      const generation = Math.floor(t / LOOP); // a cisterna keeps its identity j − generation as it moves along
      const amp = calm ? 0.4 : 1;
      // How much of the new cis cisterna has arrived (four COPII fusions per loop).
      let fused = 0;
      for (const v of VESICLES) if (v.kind === 'copii') fused += 0.25 * sstep(v.start + COPII_TRAVEL, v.start + COPII_TRAVEL + COPII_FUSE, local);

      // Cisternae: move one slot right per loop, colour maturing with position.
      let ci = 0;
      let si = 0;
      for (let j = 0; j < SACS; j++) {
        const sac = sacs[j];
        const st = sacState(j, tau, fused);
        sac.mesh.position.set(st.x, 0, 0);
        sac.mesh.scale.set(1, st.scale, st.scale);
        sac.mesh.visible = st.opacity > 0.01;
        cisternaColor(st.p, sac.material.color);
        sac.material.emissive.copy(sac.material.color);
        sac.cap.copy(sac.material.color).lerp(WHITE, 0.45);
        sac.material.opacity = st.opacity;
        sac.material.depthWrite = st.opacity > 0.95;
        // Cargo inside this cisterna (fewer in the forming one), with growing sugar sprigs.
        const sprigLevel = THREE.MathUtils.clamp(1.5 + 1.4 * st.p, 1, SPRIG); // sugars added continuously
        const sugarColor = st.p < 2 ? _color.copy(sugarEarly).lerp(sugarMid, THREE.MathUtils.clamp(st.p / 2, 0, 1)) : _color.copy(sugarMid).lerp(sugarLate, THREE.MathUtils.clamp((st.p - 2) / 2.5, 0, 1));
        for (let c = 0; c < CARGO_PER_SAC; c++) {
          const slot = cargoSlots[c];
          const present = st.p >= 0 || c < Math.round(fused * CARGO_PER_SAC);
          const size = present ? 0.5 * Math.min(1, st.opacity * 1.5) : 0;
          const wobble = noise.noise((j - generation) * 7 + c, t * 0.3, 1) * 0.5 * amp;
          _p.set(st.x + cupOffset(slot.r * Math.cos(slot.phi)), slot.r * st.scale * Math.cos(slot.phi) + wobble, slot.r * st.scale * Math.sin(slot.phi));
          cargo.setMatrixAt(ci++, _m.compose(_p, _q.identity(), _s.setScalar(size)));
          // Sprig along the lumen (vertical), branching as it grows.
          _q.setFromUnitVectors(_up, _dir.set(0, slot.dir, -0.25).normalize());
          for (let k = 0; k < SPRIG; k++) {
            const grow = present ? THREE.MathUtils.clamp(sprigLevel - k, 0, 1) : 0;
            _a.copy(slot.tree[k]).applyQuaternion(_q);
            _a.x *= 0.35; // keep the sprig inside the thin lumen
            _a.add(_p).addScaledVector(_dir, 0.45);
            sugars.setMatrixAt(si, _m.compose(_a, _q, _s.setScalar(0.2 * grow * Math.min(1, st.opacity * 1.5))));
            sugars.setColorAt(si++, sugarColor);
          }
        }
      }
      cargo.instanceMatrix.needsUpdate = true;
      sugars.instanceMatrix.needsUpdate = true;
      if (sugars.instanceColor) sugars.instanceColor.needsUpdate = true;

      // Vesicles.
      shown.copii = shown.copi = shown.secretory = shown.clathrin = false;
      let coatIndex = 0;
      VESICLES.forEach((v, i) => {
        const s = (((local - v.start) % LOOP) + LOOP) % LOOP;
        let radius = 0;
        let alpha = 1;
        _p.set(0, 0, 0);
        if (v.kind === 'copii') {
          // From the ER (left) to the forming cis cisterna, then fuse with it.
          if (s < COPII_TRAVEL + COPII_FUSE) {
            const arrive = Math.min(1, s / COPII_TRAVEL);
            const target = sacState(0, tau, fused);
            _b.set(target.x + cupOffset((v.y * 0.75) / target.scale) - 1.8 - RADIUS.copii * (1 - sstep(COPII_TRAVEL, COPII_TRAVEL + COPII_FUSE, s)), v.y * 0.75, 0);
            _a.set(-40, v.y + 6 * v.side, 0);
            _p.copy(_a).lerp(_b, sstep(0, 1, arrive));
            _p.y += Math.sin(arrive * Math.PI) * 3 * v.side;
            radius = RADIUS.copii * (1 - sstep(COPII_TRAVEL, COPII_TRAVEL + COPII_FUSE, s));
            alpha = sstep(0, 0.5, s);
            if (s > 0.3 && s < COPII_TRAVEL) {
              shown.copii = true;
              marks.copii.position.copy(_p);
            }
          }
        } else if (v.kind === 'copi') {
          // Backward: buds from a later cisterna's rim, fuses with an earlier one.
          const total = COPI.bud + COPI.travel + COPI.fuse;
          if (s < total) {
            rimPoint(4, tau, fused, v.side, _a);
            rimPoint(2, tau, fused, v.side, _b);
            const out = RADIUS.copi + 1.2;
            if (s < COPI.bud) {
              const g = sstep(0, COPI.bud, s);
              radius = RADIUS.copi * g;
              _p.copy(_a).add(_dir.set(0, v.side * (out * g + 1), 0));
            } else if (s < COPI.bud + COPI.travel) {
              const u = sstep(COPI.bud, COPI.bud + COPI.travel, s);
              radius = RADIUS.copi;
              _p.copy(_a).lerp(_b, u);
              _p.y += v.side * (out + 1 + Math.sin(u * Math.PI) * 4);
              shown.copi = true;
              marks.copi.position.copy(_p);
            } else {
              const f = sstep(COPI.bud + COPI.travel, total, s);
              radius = RADIUS.copi * (1 - f);
              _p.copy(_b);
              _p.y += v.side * (out + 1) * (1 - f);
            }
          }
        } else {
          // Secretory (upper right) and clathrin-coated (lower right) vesicles bud from the TGN.
          if (s < BUD + LEAVE) {
            const budStart = (v.start + LOOP) % LOOP;
            const tauBud = Math.min(1, ((budStart + Math.min(s, BUD)) % LOOP) / LOOP);
            transFacePoint(5, tauBud, fused, v.side, _a);
            const r = RADIUS[v.kind];
            _dir.set(1, v.side * 0.3, 0).normalize();
            if (s < BUD) {
              const g = sstep(0, BUD, s);
              radius = r * (0.15 + 0.85 * g);
              _p.copy(_a).addScaledVector(_dir, radius * 0.85 * g + 0.4);
            } else {
              const u = sstep(BUD, BUD + LEAVE, s);
              radius = r;
              _p.copy(_a).addScaledVector(_dir, r * 0.85 + 0.4);
              _p.x += (v.side > 0 ? 24 : 22) * u;
              _p.y += v.side * (v.side > 0 ? 8 : 18) * u;
              alpha = 1 - sstep(BUD + LEAVE - 1.2, BUD + LEAVE, s);
            }
            _p.x += noise.noise(i, t * 0.4, 0) * 0.3 * amp;
            const labelled = s > 0.6 && s < BUD + (v.kind === 'secretory' ? 2 : LEAVE - 1.4);
            if (v.kind === 'secretory') {
              shown.secretory ||= labelled;
              if (labelled) marks.secretory.position.copy(_p);
            } else {
              shown.clathrin ||= labelled;
              if (labelled) marks.clathrin.position.copy(_p);
            }
          }
        }
        const r = radius * Math.min(1, alpha * 1.5);
        bodies.setMatrixAt(i, _m.compose(_p, _q.identity(), _s.setScalar(Math.max(0, r))));
        for (let c = 0; c < CONTENT; c++) {
          _a.copy(contentOffsets[c]).multiplyScalar(r).add(_p);
          contents.setMatrixAt(i * CONTENT + c, _m.compose(_a, _q, _s.setScalar(r > 1.2 ? 0.5 : 0)));
        }
        if (COAT[v.kind]) {
          for (let d = 0; d < dirs.length; d++) {
            _a.copy(dirs[d]).multiplyScalar(r + 0.35).add(_p);
            coats.setMatrixAt(coatIndex++, _m.compose(_a, _q.identity(), _s.setScalar(r > 0.05 ? 0.42 + r * 0.12 : 0)));
          }
        }
      });
      bodies.instanceMatrix.needsUpdate = true;
      coats.instanceMatrix.needsUpdate = true;
      contents.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      disposeScene(scene);
    },
  };
};

export default create;
