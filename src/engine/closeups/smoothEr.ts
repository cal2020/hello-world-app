import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { Rng } from '../core/random';
import { blobGeometry, createCloseupScene, disposeScene } from './common';
import { addInstanceGlow, anchorOn, bandMaterial, bilayerRingGeometry, byQuality, instancedMaterial, membraneMaterial } from './kit';
import { glowPoints, mergeParts, sstep } from './membranesParts';
import { addJunctionHoles, releaseSubunitGeometry, sampleTube, sercaGeometry, type TubeSampler } from './smoothErParts';
import type { CloseupFactory } from './types';

/**
 * A three-way junction of smooth-ER tubes (1 unit = 1 nm): 40 nm wide tubes
 * with a 5 nm membrane, drawn semi-transparent so the calcium store inside is
 * visible. SERCA pumps move calcium ions in, two per ATP (with an ATP cue);
 * every 6 s one of two release channels opens and a burst of ions streams
 * into the cytosol, after which the pumps slowly refill the store.
 * Lipid-making enzymes sit in the membrane.
 */
const OUTER = 20;
const MEMBRANE = 5;
const INNER = OUTER - MEMBRANE;
const JUNCTION = 25.6; // junction sphere: meets the tubes' outer surface 16 nm out along each branch
const START_OUTER = Math.sqrt(JUNCTION * JUNCTION - OUTER * OUTER);
const START_INNER = Math.sqrt((JUNCTION - MEMBRANE) ** 2 - INNER * INNER);
const COLOR = '#6ee7a0';
const ION_COLOR = '#e8fff6';
const ION_SIZE = 2.6; // glow sprite; the bright core reads as a ~1.2 nm dot

const CHANNEL_PERIOD = 12; // each channel fires every 12 s; two channels alternate → a burst every 6 s
const POOL = 48; // ions released per burst (per channel)
const PUMP_PERIOD = 3.6;
const PUMPS = 8;
const CYTOSOL_IONS = 6;

interface Branch {
  outer: THREE.CatmullRomCurve3;
  inner: THREE.CatmullRomCurve3;
  sampler: TubeSampler;
}

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0a1a14');
  const rng = new Rng('closeup:smooth-er');
  const noise = new Simplex3('closeup:smooth-er:motion');
  const quality = ctx.quality;
  const root = new THREE.Group();
  scene.add(root);

  // ── Tubes and junction ──────────────────────────────────────────────────
  const branchDefs: { dir: THREE.Vector3; points: [number, number, number][] }[] = [
    { dir: new THREE.Vector3(0.08, 0.05, -1).normalize(), points: [[6, 4, -62], [-3, 9, -92], [4, 13, -118]] },
    { dir: new THREE.Vector3(-0.87, -0.03, 0.5).normalize(), points: [[-58, -4, 30], [-84, -7, 45], [-104, -5, 60]] },
    { dir: new THREE.Vector3(0.87, 0.02, 0.5).normalize(), points: [[58, 3, 32], [84, 7, 47], [102, 10, 60]] },
  ];
  const branches: Branch[] = branchDefs.map(({ dir, points }) => {
    const rest = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const make = (start: number) =>
      new THREE.CatmullRomCurve3([dir.clone().multiplyScalar(start), dir.clone().multiplyScalar(34), ...rest], false, 'centripetal');
    const outer = make(START_OUTER);
    const inner = make(START_INNER);
    return { outer, inner, sampler: sampleTube(inner) };
  });
  const tubular = byQuality(quality, { low: 48, medium: 64, high: 80 });
  const radial = byQuality(quality, { low: 24, medium: 32, high: 40 });
  const outerMaterial = membraneMaterial(COLOR, { opacity: 0.45, rim: 0.6 });
  const innerMaterial = membraneMaterial('#2d7a55', { side: THREE.BackSide, rim: 0.2 });
  const tubeOuter = new THREE.Mesh(mergeParts(branches.map((b) => new THREE.TubeGeometry(b.outer, tubular, OUTER, radial, false))), outerMaterial);
  const tubeInner = new THREE.Mesh(mergeParts(branches.map((b) => new THREE.TubeGeometry(b.inner, tubular, INNER, radial, false))), innerMaterial);
  tubeOuter.renderOrder = 2;
  root.add(tubeOuter, tubeInner);
  // Banded rings where the tubes are cut open.
  const rings = branches.map((b) => {
    const ring = bilayerRingGeometry(INNER, OUTER, radial * 2);
    ring.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.outer.getTangentAt(1)));
    const end = b.outer.getPointAt(1);
    ring.translate(end.x, end.y, end.z);
    return ring;
  });
  root.add(new THREE.Mesh(mergeParts(rings), bandMaterial()));
  // Junction: slightly wider sphere, open where the three tubes join.
  const dirs = branchDefs.map((d) => d.dir);
  const junctionOuterMaterial = membraneMaterial(COLOR, { opacity: 0.45, rim: 0.6 });
  addJunctionHoles(junctionOuterMaterial, dirs, OUTER - 0.3);
  const junctionInnerMaterial = membraneMaterial('#2d7a55', { side: THREE.BackSide, rim: 0.2 });
  addJunctionHoles(junctionInnerMaterial, dirs, INNER - 0.3);
  const junctionOuter = new THREE.Mesh(new THREE.SphereGeometry(JUNCTION, radial * 2, radial), junctionOuterMaterial);
  const junctionInner = new THREE.Mesh(new THREE.SphereGeometry(JUNCTION - MEMBRANE, radial * 2, radial), junctionInnerMaterial);
  junctionOuter.renderOrder = 2;
  root.add(junctionOuter, junctionInner);

  // ── Membrane proteins ───────────────────────────────────────────────────
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _s = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const _x = new THREE.Vector3(1, 0, 0);
  const _z = new THREE.Vector3(0, 0, 1);
  /** Orientation with local +y along the outward normal and local +z along the tube. */
  const frameAt = (b: number, u: number, angle: number, radius: number, position: THREE.Vector3, quaternion: THREE.Quaternion) => {
    branches[b].sampler.at(u, angle, radius, position, _n);
    branches[b].sampler.tangent(u, _t);
    const basis = new THREE.Matrix4().makeBasis(_x.crossVectors(_n, _t).normalize(), _n, _t);
    quaternion.setFromRotationMatrix(basis);
  };

  // SERCA pumps (green), on the sides facing the default camera.
  const pumpSites: [number, number, number][] = [
    [0, 0.3, 0.35],
    [0, 0.72, -0.55],
    [1, 0.34, -0.25],
    [1, 0.8, 0.65],
    [2, 0.3, 0.3],
    [2, 0.86, -0.45],
    [0, 0.5, 1.15],
    [2, 0.6, 1.25],
  ];
  const pumpFrames = pumpSites.map(([b, u, a]) => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    frameAt(b, u, a, OUTER, position, quaternion);
    return { position, quaternion, branch: b, u, angle: a };
  });
  const pumpMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(pumpMaterial, 0.32, 'sercaGlow');
  const pumps = new THREE.InstancedMesh(sercaGeometry(quality), pumpMaterial, PUMPS);
  for (let i = 0; i < PUMPS; i++) pumps.setColorAt(i, new THREE.Color('#3ecf6e').offsetHSL(0, 0, (i % 3) * 0.02));
  pumps.frustumCulled = false;
  root.add(pumps);

  // Calcium-release channels (orange tetramers, ~20 nm).
  const channelSites: [number, number, number][] = [
    [2, 0.52, 0.15],
    [1, 0.58, 0.2],
  ];
  const channelFrames = channelSites.map(([b, u, a]) => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    frameAt(b, u, a, OUTER, position, quaternion);
    return { position, quaternion, branch: b, u, angle: a };
  });
  const subunitShape = releaseSubunitGeometry(quality, 'ip3r');
  const channelMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(channelMaterial, 0.22, 'ip3rGlow');
  const channels = new THREE.InstancedMesh(subunitShape, channelMaterial, channelFrames.length * 4);
  channels.frustumCulled = false;
  root.add(channels);
  const channelOrange = new THREE.Color('#ff9e3d');
  const channelHot = new THREE.Color('#ffe2a8');
  const _color = new THREE.Color();

  // Lipid-making enzymes (pale blue), half in the membrane.
  const enzymeSites: [number, number, number][] = [
    [0, 0.42, -0.2],
    [0, 0.85, 0.5],
    [1, 0.22, 0.6],
    [1, 0.45, -0.8],
    [1, 0.7, -0.15],
    [2, 0.4, -0.7],
    [2, 0.7, 0.55],
    [0, 0.18, -1.0],
  ];
  const enzymeShape = blobGeometry(1, 'lipid-enzyme', 0.22, quality === 'high' ? 2 : 1);
  const enzymeMaterial = instancedMaterial({ roughness: 0.5 });
  addInstanceGlow(enzymeMaterial, 0.22, 'lipidEnzymeGlow');
  const enzymes = new THREE.InstancedMesh(enzymeShape, enzymeMaterial, enzymeSites.length);
  enzymeSites.forEach(([b, u, a], i) => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    frameAt(b, u, a, OUTER - 1, position, quaternion);
    enzymes.setMatrixAt(i, new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(2.6, 2.2, 2.8)));
    enzymes.setColorAt(i, new THREE.Color('#a9d8ff').offsetHSL(0, 0, ((i * 7) % 3) * 0.02));
  });
  enzymes.frustumCulled = false;
  root.add(enzymes);

  // ── Calcium ions ────────────────────────────────────────────────────────
  // Lumen store (wandering), pools released by the channels, pumped ions, and a few in the cytosol.
  const storeCount = byQuality(quality, { low: 96, medium: 116, high: 136 });
  const ionRng = rng.fork('ions');
  interface LumenIon {
    branch: number; // −1 = junction
    u: number;
    angle: number;
    radius: number;
    home: THREE.Vector3;
    seed: number;
  }
  const lumenIon = (branch: number, u: number): LumenIon => ({
    branch,
    u,
    angle: ionRng.range(0, Math.PI * 2),
    radius: Math.sqrt(ionRng.next()) * (INNER - 2.5),
    home: ionRng.inBall().multiplyScalar(JUNCTION - MEMBRANE - 3),
    seed: ionRng.range(0, 100),
  });
  const store: LumenIon[] = Array.from({ length: storeCount }, (_, i) => (i < storeCount * 0.14 ? lumenIon(-1, 0) : lumenIon(i % 3, ionRng.range(0.02, 0.97))));
  const pools = channelFrames.map((frame) =>
    Array.from({ length: POOL }, (_, j) => ({
      ion: lumenIon(frame.branch, THREE.MathUtils.clamp(frame.u + ionRng.range(-0.2, 0.2), 0.03, 0.97)),
      spread: new THREE.Vector3(ionRng.range(-1, 1), ionRng.range(0.5, 1.4), ionRng.range(-1, 1)).normalize().multiplyScalar(ionRng.range(18, 52)),
      refill: 3.8 + (j / POOL) * 7.2 + ionRng.range(-0.1, 0.1),
      lateral: ionRng.range(0, Math.PI * 2),
    })),
  );
  const cytosolHomes = Array.from({ length: CYTOSOL_IONS }, () => new THREE.Vector3(ionRng.range(-90, 90), ionRng.range(26, 60), ionRng.range(-70, 60)));
  const total = storeCount + channelFrames.length * POOL + PUMPS * 2 + CYTOSOL_IONS;
  // Two layers sharing positions: lumen ions are drawn before the translucent tube walls (seen through them).
  const ionsLumen = glowPoints({ count: total, color: ION_COLOR, size: ION_SIZE, pointScale: ctx.pointScale });
  const ionsCytosol = glowPoints({ count: total, color: ION_COLOR, size: ION_SIZE * 1.25, pointScale: ctx.pointScale, share: ionsLumen });
  ionsLumen.points.renderOrder = 1;
  ionsCytosol.points.renderOrder = 3;
  root.add(ionsLumen.points, ionsCytosol.points);
  const atpCues = glowPoints({ count: PUMPS, color: '#ffcc55', size: 7, pointScale: ctx.pointScale, opacity: 1 });
  atpCues.points.renderOrder = 3;
  const channelGlow = glowPoints({ count: channelFrames.length, color: '#ffcf8a', size: 22, pointScale: ctx.pointScale, opacity: 0.6 });
  channelGlow.points.renderOrder = 3;
  root.add(atpCues.points, channelGlow.points);
  const atpLocal = new THREE.Vector3(0.6, 8.2, 0.4);
  const atpWorld = pumpFrames.map((f) => atpLocal.clone().applyQuaternion(f.quaternion).add(f.position));
  atpCues.positions.set(atpWorld.flatMap((p) => [p.x, p.y, p.z]));
  channelFrames.forEach((f, c) => {
    _n.set(0, 1, 0).applyQuaternion(f.quaternion);
    _p.copy(f.position).addScaledVector(_n, 3);
    channelGlow.positions.set([_p.x, _p.y, _p.z], c * 3);
  });

  const _ion = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const burstMarks = channelFrames.map(() => new THREE.Object3D());
  root.add(...burstMarks);
  const state = { burst: 0, bursting: false, atp: false };
  const _burstAnchor = new THREE.Vector3();

  const placeLumen = (ion: LumenIon, t: number, amp: number, target: THREE.Vector3) => {
    if (ion.branch < 0) {
      target.set(
        ion.home.x + noise.noise(ion.seed, t * 0.2, 1) * 4 * amp,
        ion.home.y + noise.noise(ion.seed, t * 0.2, 2) * 4 * amp,
        ion.home.z + noise.noise(ion.seed, t * 0.2, 3) * 4 * amp,
      );
      const r = target.length();
      if (r > JUNCTION - MEMBRANE - 2) target.multiplyScalar((JUNCTION - MEMBRANE - 2) / r);
      return target;
    }
    const u = THREE.MathUtils.clamp(ion.u + noise.noise(ion.seed, t * 0.12, 4) * 0.05 * amp, 0.01, 0.99);
    const angle = ion.angle + noise.noise(ion.seed, t * 0.15, 5) * 1.2 * amp;
    const radius = THREE.MathUtils.clamp(ion.radius + noise.noise(ion.seed, t * 0.2, 6) * 4 * amp, 0, INNER - 2.2);
    return branches[ion.branch].sampler.at(u, angle, radius, target);
  };
  const write = (k: number, p: THREE.Vector3, lumenAlpha: number, cytosolAlpha: number) => {
    ionsLumen.positions[k * 3] = p.x;
    ionsLumen.positions[k * 3 + 1] = p.y;
    ionsLumen.positions[k * 3 + 2] = p.z;
    ionsLumen.alphas[k] = lumenAlpha;
    ionsCytosol.alphas[k] = cytosolAlpha;
  };

  const labels = [
    { part: 'calcium-channel', anchor: anchorOn(root, new THREE.Vector3(0, 13, 4).applyQuaternion(channelFrames[0].quaternion).add(channelFrames[0].position)) },
    { part: 'calcium-pump', anchor: anchorOn(root, new THREE.Vector3(-2, 6, 0).applyQuaternion(pumpFrames[4].quaternion).add(pumpFrames[4].position)) },
    { textKey: 'closeupCaptions.atp', anchor: anchorOn(root, atpWorld[4]), visible: () => state.atp },
    { textKey: 'closeupCaptions.calcium', anchor: () => burstMarks[state.burst].getWorldPosition(_burstAnchor), visible: () => state.bursting },
    { part: 'lipid-enzyme', anchor: anchorOn(root, branches[1].sampler.at(0.22, 0.6, OUTER + 2, new THREE.Vector3())) },
    { part: 'junction', anchor: anchorOn(root, new THREE.Vector3(-6, JUNCTION * 0.8, JUNCTION * 0.55)) },
    { part: 'tubule', anchor: anchorOn(root, branches[0].sampler.at(0.62, -0.9, OUTER, new THREE.Vector3())) },
    { textKey: 'closeupCaptions.lumen', anchor: anchorOn(root, branches[2].sampler.at(0.74, 0.4, 0, new THREE.Vector3())) },
    { textKey: 'closeupCaptions.cytosol', anchor: anchorOn(root, new THREE.Vector3(-70, 52, -50)) },
  ];

  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, 4, 2),
        radius: 118,
        direction: new THREE.Vector3(0.2, 1.05, 0.9).normalize(),
        posterTime: 1.75, // Opens on calcium ions released from the lumen.
        labels,
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      const amp = calm ? 0.4 : 1;
      let k = 0;

      // The store: ions wander inside the tubes and the junction.
      for (const ion of store) write(k++, placeLumen(ion, t, amp, _ion), 1, 0);

      // Release: two channels alternate, each opening every 12 s (a burst every 6 s).
      state.bursting = false;
      channelFrames.forEach((frame, c) => {
        const local = (((t - c * (CHANNEL_PERIOD / 2)) % CHANNEL_PERIOD) + CHANNEL_PERIOD) % CHANNEL_PERIOD;
        const open = sstep(0, 0.35, local) * (1 - sstep(1.3, 2, local));
        _normal.set(0, 1, 0).applyQuaternion(frame.quaternion);
        const mouthIn = _a.copy(frame.position).addScaledVector(_normal, -MEMBRANE - 1.5);
        const mouthOut = _b.copy(frame.position).addScaledVector(_normal, 4);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let count = 0;
        for (let j = 0; j < POOL; j++) {
          const pool = pools[c][j];
          const s = local - j * 0.025;
          if (s < 0) {
            write(k++, placeLumen(pool.ion, t, amp, _ion), 1, 0);
            continue;
          }
          if (s < 0.4) {
            placeLumen(pool.ion, t, amp, _ion).lerp(mouthIn, sstep(0, 0.4, s));
            write(k++, _ion, 1, 0);
          } else if (s < 0.6) {
            _ion.copy(mouthIn).lerp(mouthOut, (s - 0.4) / 0.2);
            write(k++, _ion, s < 0.5 ? 1 : 0, s < 0.5 ? 0 : 1);
          } else if (s < 3.4) {
            // A jet straight out of the pore, then the cloud spreads and fades.
            const jet = sstep(0.6, 1.1, s);
            const u = 1 - Math.pow(1 - sstep(0.9, 3.4, s), 2);
            _ion.copy(pool.spread).applyQuaternion(frame.quaternion).multiplyScalar(u).addScaledVector(_normal, 14 * jet).add(mouthOut);
            const fade = 1 - sstep(2, 3.4, s);
            write(k++, _ion, 0, fade);
            sx += _ion.x;
            sy += _ion.y;
            sz += _ion.z;
            count++;
          } else {
            // Gone into the cytosol; the pumps slowly refill the store near the channel.
          // (pool.refill starts at 3.6 s, after the cloud has faded.)
            const back = sstep(pool.refill, pool.refill + 0.6, local);
            write(k++, placeLumen(pool.ion, t, amp, _ion), back, 0);
          }
        }
        if (count > 0 && local < 3) {
          burstMarks[c].position.set(sx / count, sy / count, sz / count);
          state.burst = c;
          state.bursting = local > 0.7;
        }
        // The channel opens: subunits splay apart and glow.
        for (let i = 0; i < 4; i++) {
          _q.setFromAxisAngle(_up, (i * Math.PI) / 2);
          _q2.copy(frame.quaternion).multiply(_q);
          _p.set(open * 1.6, open * 0.8, 0).applyQuaternion(_q2).add(frame.position);
          channels.setMatrixAt(c * 4 + i, _m.compose(_p, _q2, _s));
          channels.setColorAt(c * 4 + i, _color.copy(channelOrange).lerp(channelHot, open * (calm ? 0.35 : 0.6)));
        }
        channelGlow.alphas[c] = open * (calm ? 0.5 : 1);
      });
      channels.instanceMatrix.needsUpdate = true;
      if (channels.instanceColor) channels.instanceColor.needsUpdate = true;
      channelGlow.commit();

      // Pumps: two ions per ATP from the cytosol into the lumen. They bind one after the
      // other, sit side by side while ATP is used, then cross the membrane together.
      state.atp = false;
      for (let p = 0; p < PUMPS; p++) {
        const frame = pumpFrames[p];
        const ps = (((t + p * 0.45) % PUMP_PERIOD) + PUMP_PERIOD) % PUMP_PERIOD;
        _normal.set(0, 1, 0).applyQuaternion(frame.quaternion);
        _side.set(1, 0, 0).applyQuaternion(frame.quaternion);
        for (let n = 0; n < 2; n++) {
          const sign = n === 0 ? 1 : -1;
          const arrive = n * 0.25;
          const site = _a.copy(frame.position).addScaledVector(_normal, 2.4).addScaledVector(_side, 0.9 * sign);
          let lumenAlpha = 0;
          let cytosolAlpha = 0;
          if (ps < arrive) {
            _ion.copy(site);
          } else if (ps < arrive + 0.8) {
            const angle = p * 2.1 + n * 2.6;
            _ion.set(Math.cos(angle) * 9, 12, Math.sin(angle) * 9).applyQuaternion(frame.quaternion).add(frame.position).lerp(site, sstep(arrive, arrive + 0.8, ps));
            cytosolAlpha = sstep(arrive, arrive + 0.3, ps);
          } else if (ps < 1.5) {
            _ion.copy(site);
            cytosolAlpha = 1;
          } else if (ps < 2) {
            _b.copy(frame.position).addScaledVector(_normal, -MEMBRANE - 3).addScaledVector(_side, 0.9 * sign);
            _ion.copy(site).lerp(_b, sstep(1.5, 2, ps));
            if (ps < 1.75) cytosolAlpha = 1;
            else lumenAlpha = 1;
          } else if (ps < 3) {
            _b.copy(frame.position).addScaledVector(_normal, -MEMBRANE - 3).addScaledVector(_side, 0.9 * sign);
            branches[frame.branch].sampler.at(frame.u, frame.angle + sign * 0.5, 4, _p);
            _ion.copy(_b).lerp(_p, sstep(2, 3, ps));
            lumenAlpha = 1 - sstep(2.4, 3, ps);
          } else {
            _ion.copy(site);
          }
          write(k++, _ion, lumenAlpha, cytosolAlpha);
        }
        const cue = Math.sin(Math.PI * sstep(0.75, 1.55, ps));
        atpCues.alphas[p] = cue * (calm ? 0.6 : 1);
        if (p === 4 && cue > 0.35) state.atp = true;
        // The head tilts as it hands the ions across.
        const nod = Math.sin(Math.PI * sstep(1, 2, ps)) * 0.16 * (calm ? 0.5 : 1);
        _q.setFromAxisAngle(_z, nod);
        _q2.copy(frame.quaternion).multiply(_q);
        pumps.setMatrixAt(p, _m.compose(frame.position, _q2, _s));
      }
      pumps.instanceMatrix.needsUpdate = true;
      atpCues.commit();

      // A few ions in the cytosol (resting level is very low).
      for (let i = 0; i < CYTOSOL_IONS; i++) {
        const h = cytosolHomes[i];
        _ion.set(h.x + noise.noise(i * 3.1, t * 0.18, 1) * 8 * amp, h.y + noise.noise(i * 3.1, t * 0.18, 2) * 5 * amp, h.z + noise.noise(i * 3.1, t * 0.18, 3) * 8 * amp);
        write(k++, _ion, 0, 0.8);
      }
      ionsLumen.commit();
      ionsCytosol.commit();
    },
    dispose() {
      ionsLumen.dispose();
      ionsCytosol.dispose();
      atpCues.dispose();
      channelGlow.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
