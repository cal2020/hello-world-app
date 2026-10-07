import * as THREE from 'three';
import { Simplex3 } from '../../core/noise';
import { applyFresnel, standardFocus } from '../../core/materials';
import { capsuleProfile, mergeGeometries, noisyEllipsoid, profiledTube } from '../../core/geometry';
import { rngFor } from '../../core/random';
import { colorOf, easeInOut, makeInstance, pulse, raySpheres } from '../common';
import type { BuildContext, PartAnchor, StructureInstance } from '../types';

const FRONT = new THREE.Vector3(0.15, 0.25, 1).normalize();

/**
 * Mitochondria: curved, capsule-shaped organelles at about true size with
 * faint banding where the cristae lie. The "hero" mitochondrion that the
 * camera frames is cut open lengthwise when selected, revealing the inner
 * membrane, plate-like cristae and the matrix with mtDNA and ribosomes.
 */
export function buildMitochondria(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const color = colorOf('mitochondria');
  const placements = layout.mitochondria;
  // Hero: well placed toward the default view, not too deep.
  let heroIndex = 0;
  let heroScore = -Infinity;
  placements.forEach((mito, i) => {
    const mid = mito.curve.getPointAt(0.5);
    const rel = layout.relativeRadius(mid);
    const score = mid.clone().normalize().dot(FRONT) * 2 - Math.abs(rel - 0.62) * 3 + (mito.length > 1.8 ? 0.5 : 0);
    if (score > heroScore) {
      heroScore = score;
      heroIndex = i;
    }
  });
  const hero = placements[heroIndex];
  const others = placements.filter((_, i) => i !== heroIndex);

  const wobble = { value: 1 };
  const patch = (material: THREE.MeshStandardMaterial, banding: boolean) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = ctx.time;
      shader.uniforms.uWobble = wobble;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aT;\nattribute float aLen;\nuniform float uTime;\nuniform float uWobble;\nvarying float vBand;')
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          transformed += normal * uWobble * 0.012 * sin(uTime * 1.1 + aT * 9.0 + aLen * 3.0);
          vBand = aT * aLen / 0.15;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBand;')
        .replace(
          '#include <color_fragment>',
          banding
            ? /* glsl */ `#include <color_fragment>
          float band = smoothstep(0.32, 0.5, abs(fract(vBand) - 0.5));
          diffuseColor.rgb *= 0.74 + 0.26 * band;`
            : '#include <color_fragment>',
        );
    };
    material.customProgramCacheKey = () => `mito-${banding}`;
  };

  const tube = (mito: (typeof placements)[number], scale = 1, radial = 10) => {
    const g = profiledTube(mito.curve, Math.max(16, Math.round(mito.length * 14)), radial, capsuleProfile(mito.radius * scale, mito.length), {
      attribute: 'aLen',
      value: mito.length,
    });
    return g;
  };

  const otherGeometries = others.map((m) => tube(m));
  const indexCounts = otherGeometries.map((g) => g.index!.count);
  const merged = mergeGeometries(otherGeometries);
  otherGeometries.forEach((g) => g.dispose());
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.85), emissive: color, roughness: 0.42 });
  patch(material, true);
  const mesh = new THREE.Mesh(merged, material);

  // Hero detail.
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const heroOuterMaterial = new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.85),
    emissive: color,
    roughness: 0.42,
    side: THREE.DoubleSide,
    transparent: true,
  });
  patch(heroOuterMaterial, true);
  const heroInnerMaterial = new THREE.MeshStandardMaterial({ color: '#ff9b8f', emissive: '#ff5a5f', roughness: 0.5, side: THREE.DoubleSide });
  const cristaMaterial = new THREE.MeshStandardMaterial({ color: '#ffc0b5', emissive: '#ff7b6e', roughness: 0.5, side: THREE.DoubleSide });
  const matrixMaterial = new THREE.MeshStandardMaterial({ color: '#ffe0b0', emissive: '#ffb070', roughness: 0.6 });
  for (const mat of [heroOuterMaterial, heroInnerMaterial, cristaMaterial, matrixMaterial]) {
    mat.clippingPlanes = [clipPlane];
    mat.clipShadows = false;
  }
  const heroOuter = new THREE.Mesh(tube(hero, 1, 18), heroOuterMaterial);
  const heroInner = new THREE.Mesh(tube(hero, 0.82, 18), heroInnerMaterial);
  const rng = rngFor('mito-cristae');
  const cristaGeometries: THREE.BufferGeometry[] = [];
  const cristaPositions: THREE.Vector3[] = [];
  const capU = hero.radius / hero.length;
  const steps = Math.floor((hero.length - 2 * hero.radius) / 0.1);
  const z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= steps; i++) {
    const u = capU + ((1 - 2 * capU) * i) / Math.max(1, steps);
    const p = hero.curve.getPointAt(u);
    const tangent = hero.curve.getTangentAt(u);
    const start = (i % 2) * Math.PI + rng.range(-0.4, 0.4);
    const disk = new THREE.CircleGeometry(hero.radius * 0.8, 20, start, Math.PI * 1.25);
    // Shift so the shelf grows inward from one side of the inner membrane.
    disk.translate(Math.cos(start + Math.PI * 0.625) * hero.radius * 0.12, Math.sin(start + Math.PI * 0.625) * hero.radius * 0.12, 0);
    disk.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(z, tangent));
    disk.translate(p.x, p.y, p.z);
    cristaGeometries.push(disk);
    cristaPositions.push(p);
  }
  const cristae = new THREE.Mesh(mergeGeometries(cristaGeometries), cristaMaterial);
  cristaGeometries.forEach((g) => g.dispose());
  const granules: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const u = rng.range(capU * 1.5, 1 - capU * 1.5);
    const p = hero.curve.getPointAt(u).add(rng.inBall().multiplyScalar(hero.radius * 0.45));
    const g = i < 3 ? new THREE.TorusGeometry(0.035, 0.009, 6, 16) : new THREE.SphereGeometry(0.018, 8, 6);
    g.translate(p.x, p.y, p.z);
    granules.push(g);
  }
  const matrix = new THREE.Mesh(mergeGeometries(granules), matrixMaterial);
  granules.forEach((g) => g.dispose());
  heroInner.visible = false;
  cristae.visible = false;
  matrix.visible = false;

  const root = new THREE.Group();
  root.add(mesh, heroOuter, heroInner, cristae, matrix);

  const heroMid = hero.curve.getPointAt(0.5);
  const axis = hero.curve.getPointAt(0.9).sub(hero.curve.getPointAt(0.1)).normalize();
  const counts = { low: 30, medium: 45, high: placements.length };
  let count = placements.length;
  let focused = false;
  let reveal = 0;
  const camPos = new THREE.Vector3();
  const samples = (mito: (typeof placements)[number]) => {
    const n = Math.max(3, Math.ceil(mito.length / 0.2));
    return Array.from({ length: n + 1 }, (_, i) => ({ center: mito.curve.getPointAt(i / n), radius: mito.radius }));
  };
  const heroSamples = samples(hero);
  const otherSamples = others.map(samples);

  return makeInstance('mitochondria', root, {
    focus: [
      standardFocus(material, { emissiveBase: 0.1, emissiveBoost: 0.4 }),
      standardFocus(heroOuterMaterial, { emissiveBase: 0.1, emissiveBoost: 0.4 }),
      standardFocus(heroInnerMaterial, { emissiveBase: 0.2, emissiveBoost: 0.3 }),
      standardFocus(cristaMaterial, { emissiveBase: 0.2, emissiveBoost: 0.3 }),
      standardFocus(matrixMaterial, { emissiveBase: 0.4, emissiveBoost: 0.3 }),
    ],
    raycast(ray) {
      let best = raySpheres(ray, heroSamples);
      for (let i = 0; i < count - 1; i++) {
        const t = raySpheres(ray, otherSamples[i]);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
    framing() {
      const view = FRONT.clone().addScaledVector(axis, -FRONT.dot(axis)).normalize();
      return { target: heroMid.clone(), radius: hero.length / 2 + 0.35, direction: view };
    },
    labelAnchors() {
      return [heroMid.clone(), ...others.slice(0, 6).map((m) => m.curve.getPointAt(0.5))];
    },
    partAnchors(): PartAnchor[] {
      uCamDir.copy(camPos).sub(heroMid).normalize();
      const side = new THREE.Vector3().crossVectors(axis, uCamDir).normalize();
      const crista = cristaPositions[Math.floor(cristaPositions.length / 2)];
      return [
        { part: 'outer-membrane', position: hero.curve.getPointAt(0.3).addScaledVector(side, hero.radius) },
        { part: 'inner-membrane', position: hero.curve.getPointAt(0.7).addScaledVector(side, -hero.radius * 0.8) },
        { part: 'cristae', position: crista.clone().addScaledVector(side, hero.radius * 0.25) },
        { part: 'matrix', position: hero.curve.getPointAt(0.42) },
      ];
    },
    setFocused(value) {
      focused = value;
    },
    update(dt, _time, uctx) {
      wobble.value = uctx.calm ? 0 : 1;
      reveal = THREE.MathUtils.clamp(reveal + (focused ? 1 : -1) * Math.max(dt, 0.016) * 2.5, 0, 1);
      uctx.camera.getWorldPosition(camPos);
      // Clip plane through the hero's axis, removing the half nearer the camera.
      const toCam = camPos.clone().sub(heroMid);
      const n = toCam.addScaledVector(axis, -toCam.dot(axis)).normalize();
      const offset = THREE.MathUtils.lerp(hero.radius * 1.2, -0.01, easeInOut(reveal));
      clipPlane.normal.copy(n).negate();
      clipPlane.constant = n.dot(heroMid) + offset;
      const open = reveal > 0.01;
      heroInner.visible = open;
      cristae.visible = open;
      matrix.visible = open;
    },
    setQuality(level) {
      count = counts[level];
      const others = Math.max(0, count - 1);
      const indexCount = indexCounts.slice(0, others).reduce((a, b) => a + b, 0);
      merged.setDrawRange(0, indexCount);
      return count;
    },
  });
}
const uCamDir = new THREE.Vector3();

/** Lysosomes: translucent violet spheres around dense, grainy cores (material being digested). */
export function buildLysosomes(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const spheres = layout.lysosomes;
  const color = colorOf('lysosomes');
  const noise = new Simplex3('lysosome-core');
  const outerMaterial = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.7), emissive: color, roughness: 0.3, transparent: true });
  applyFresnel(outerMaterial, '#e2c2ff', 2.2, 0.6, 'lysosome-fresnel');
  const coreMaterial = new THREE.MeshStandardMaterial({ color: '#4a2170', emissive: '#9b4dff', roughness: 0.85 });
  const outer = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), outerMaterial, spheres.length);
  const core = new THREE.InstancedMesh(noisyEllipsoid(new THREE.Vector3(0.62, 0.62, 0.62), 2, noise, 0.18, 2.5), coreMaterial, spheres.length);
  const m = new THREE.Matrix4();
  spheres.forEach((s, i) => {
    outer.setMatrixAt(i, m.makeScale(s.radius, s.radius, s.radius).setPosition(s.center));
    core.setMatrixAt(i, m.makeScale(s.radius, s.radius, s.radius).setPosition(s.center));
  });
  const root = new THREE.Group();
  root.add(core, outer);
  const counts = { low: 18, medium: 24, high: spheres.length };
  let count = spheres.length;
  const front = [...spheres].sort((a, b) => b.center.clone().normalize().dot(FRONT) - a.center.clone().normalize().dot(FRONT));
  const hero = front[0];

  return makeInstance('lysosomes', root, {
    focus: [
      standardFocus(outerMaterial, { baseOpacity: 0.62, alwaysTransparent: true, emissiveBase: 0.25, emissiveBoost: 0.45 }),
      standardFocus(coreMaterial, { emissiveBase: 0.25, emissiveBoost: 0.45 }),
    ],
    raycast(ray) {
      return raySpheres(ray, spheres, count);
    },
    framing() {
      return { target: hero.center.clone(), radius: 1.0, direction: hero.center.clone().normalize().add(FRONT).normalize() };
    },
    labelAnchors() {
      return front.slice(0, 6).map((s) => s.center.clone());
    },
    partAnchors() {
      const side = new THREE.Vector3().crossVectors(FRONT, new THREE.Vector3(0, 1, 0)).normalize();
      return [
        { part: 'membrane', position: hero.center.clone().addScaledVector(side, hero.radius) },
        { part: 'lumen', position: hero.center.clone() },
      ];
    },
    setQuality(level) {
      count = counts[level];
      outer.count = count;
      core.count = count;
      return count;
    },
  });
}

/** Peroxisomes: small, evenly granular lime spheres (no crystalline core in human cells). */
export function buildPeroxisomes(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const spheres = layout.peroxisomes;
  const color = colorOf('peroxisomes');
  const noise = new Simplex3('peroxisome');
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.75), emissive: color, roughness: 0.55 });
  const mesh = new THREE.InstancedMesh(noisyEllipsoid(new THREE.Vector3(1, 1, 1), 3, noise, 0.04, 5), material, spheres.length);
  const m = new THREE.Matrix4();
  spheres.forEach((s, i) => mesh.setMatrixAt(i, m.makeScale(s.radius, s.radius, s.radius).setPosition(s.center)));
  const root = new THREE.Group();
  root.add(mesh);
  const counts = { low: 16, medium: 22, high: spheres.length };
  let count = spheres.length;
  const front = [...spheres].sort((a, b) => b.center.clone().normalize().dot(FRONT) - a.center.clone().normalize().dot(FRONT));
  const hero = front[0];
  return makeInstance('peroxisomes', root, {
    focus: [standardFocus(material, { emissiveBase: 0.2, emissiveBoost: 0.5 })],
    raycast(ray) {
      return raySpheres(ray, spheres, count, 1.4);
    },
    framing() {
      return { target: hero.center.clone(), radius: 0.85, direction: hero.center.clone().normalize().add(FRONT).normalize() };
    },
    labelAnchors() {
      return front.slice(0, 6).map((s) => s.center.clone());
    },
    partAnchors() {
      const side = new THREE.Vector3().crossVectors(FRONT, new THREE.Vector3(0, 1, 0)).normalize();
      return [
        { part: 'membrane', position: hero.center.clone().addScaledVector(side, hero.radius) },
        { part: 'matrix', position: hero.center.clone() },
      ];
    },
    setQuality(level) {
      count = counts[level];
      mesh.count = count;
      return count;
    },
  });
}

/**
 * Endosomes: early endosomes near the cell edge (with tubular arms) and
 * larger, darker late endosomes (multivesicular bodies) deeper inside. While
 * selected, three events repeat in turn: uptake from the plasma membrane,
 * recycling of receptors back to the surface, and delivery to a lysosome.
 */
export function buildEndosomes(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const color = colorOf('endosomes');
  const early = layout.endosomes.filter((e) => !e.late);
  const late = layout.endosomes.filter((e) => e.late);
  const earlyMaterial = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), emissive: color, roughness: 0.35 });
  const lateMaterial = new THREE.MeshStandardMaterial({ color: '#2a6fa0', emissive: '#3aa0e0', roughness: 0.35, transparent: true });
  applyFresnel(lateMaterial, '#bfe8ff', 2, 0.6, 'late-endosome');
  const ilvMaterial = new THREE.MeshStandardMaterial({ color: '#d6f2ff', emissive: '#7fd4ff', roughness: 0.4 });
  const sphere = new THREE.IcosahedronGeometry(1, 3);
  const earlyMesh = new THREE.InstancedMesh(sphere, earlyMaterial, early.length);
  const lateMesh = new THREE.InstancedMesh(sphere, lateMaterial, late.length);
  const armCount = early.reduce((n, e) => n + e.arms.length, 0);
  const armMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.045, 1, 4, 8), earlyMaterial, armCount);
  const rng = rngFor('endosome-ilv');
  const ilvPerLate = 8;
  const ilvMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 8, 6), ilvMaterial, late.length * ilvPerLate);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  early.forEach((e, i) => earlyMesh.setMatrixAt(i, m.makeScale(e.radius, e.radius, e.radius).setPosition(e.center)));
  late.forEach((e, i) => {
    lateMesh.setMatrixAt(i, m.makeScale(e.radius, e.radius, e.radius).setPosition(e.center));
    for (let k = 0; k < ilvPerLate; k++) {
      const p = e.center.clone().add(rng.inBall().multiplyScalar(e.radius * 0.6));
      ilvMesh.setMatrixAt(i * ilvPerLate + k, m.makeTranslation(p.x, p.y, p.z));
    }
  });
  let a = 0;
  early.forEach((e) => {
    for (const arm of e.arms) {
      const center = e.center.clone().addScaledVector(arm.dir, e.radius + arm.length / 2 - 0.05);
      q.setFromUnitVectors(up, arm.dir);
      m.compose(center, q, new THREE.Vector3(1, arm.length, 1));
      armMesh.setMatrixAt(a++, m);
    }
  });
  const root = new THREE.Group();
  root.add(earlyMesh, armMesh, lateMesh, ilvMesh);

  // Teaching events.
  const ee = [...early].sort((x, y) => y.center.clone().normalize().dot(FRONT) - x.center.clone().normalize().dot(FRONT))[0];
  const le = [...late].sort((x, y) => x.center.distanceTo(ee.center) - y.center.distanceTo(ee.center))[0];
  const lysosome = [...layout.lysosomes].sort((x, y) => x.center.distanceTo(le.center) - y.center.distanceTo(le.center))[0];
  const membraneSpot = layout.membranePoint(ee.center.clone().normalize(), 0.985);
  const eventMaterial = new THREE.MeshStandardMaterial({ color: '#e6f6ff', emissive: '#9fe3ff', emissiveIntensity: 0.9, roughness: 0.3, transparent: true });
  const cargoMaterial = new THREE.MeshStandardMaterial({ color: '#ffe27a', emissive: '#ffd040', emissiveIntensity: 1, roughness: 0.3 });
  const pit = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), eventMaterial);
  const cargo = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), cargoMaterial);
  const tubule = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), eventMaterial);
  const receptor = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: '#6fb8ff', emissive: '#4a9cff', emissiveIntensity: 1 }));
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: '#d8b8ff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  const eventGroup = new THREE.Group();
  eventGroup.add(pit, cargo, tubule, receptor, flash);
  eventGroup.visible = false;
  root.add(eventGroup);
  const period = 15;
  let focused = false;
  let eventIndex = 0;
  const tmp = new THREE.Vector3();
  const counts = { low: 14, medium: 20, high: 26 };
  let earlyCount = early.length;
  let lateCount = late.length;
  const allSpheres = layout.endosomes;

  return makeInstance('endosomes', root, {
    focus: [
      standardFocus(earlyMaterial, { emissiveBase: 0.2, emissiveBoost: 0.5 }),
      standardFocus(lateMaterial, { baseOpacity: 0.7, alwaysTransparent: true, emissiveBase: 0.2, emissiveBoost: 0.45 }),
      standardFocus(ilvMaterial, { emissiveBase: 0.3, emissiveBoost: 0.4 }),
    ],
    raycast(ray) {
      let best = raySpheres(ray, early, earlyCount, 1.25);
      const t = raySpheres(ray, late, lateCount, 1.1);
      if (t !== null && (best === null || t < best)) best = t;
      return best;
    },
    framing() {
      const target = ee.center.clone().lerp(le.center, 0.35).lerp(membraneSpot, 0.15);
      const radius = Math.max(ee.center.distanceTo(le.center), ee.center.distanceTo(membraneSpot)) * 0.75 + 0.5;
      return { target, radius, direction: ee.center.clone().normalize().add(FRONT).normalize() };
    },
    labelAnchors() {
      return [ee.center.clone(), le.center.clone(), ...allSpheres.slice(0, 4).map((e) => e.center.clone())];
    },
    partAnchors(): PartAnchor[] {
      const anchors: PartAnchor[] = [
        { part: 'early-endosome', position: ee.center.clone() },
        { part: 'late-endosome', position: le.center.clone() },
      ];
      if (focused) {
        const key = ['uptake', 'recycling', 'degradation'][eventIndex];
        const where = eventIndex === 0 ? membraneSpot.clone().lerp(ee.center, 0.3) : eventIndex === 1 ? ee.center.clone().lerp(membraneSpot, 0.55) : le.center.clone().lerp(lysosome.center, 0.5);
        anchors.push({ part: key, position: where, textKey: `structures.endosomes.events.${key}` });
      }
      return anchors;
    },
    setFocused(value) {
      focused = value;
      eventGroup.visible = value;
    },
    update(_dt, time) {
      if (!focused) return;
      const phase = (time % period) / period;
      eventIndex = Math.min(2, Math.floor(phase * 3));
      const local = phase * 3 - eventIndex;
      pit.visible = cargo.visible = tubule.visible = receptor.visible = false;
      (flash.material as THREE.MeshBasicMaterial).opacity = 0;
      if (eventIndex === 0) {
        // Uptake: a coated pit forms at the membrane and the vesicle travels to the early endosome.
        pit.visible = cargo.visible = true;
        const s = easeInOut(Math.max(0, (local - 0.25) / 0.65));
        tmp.copy(membraneSpot).lerp(ee.center, s);
        pit.position.copy(tmp);
        pit.scale.setScalar(Math.min(1, local / 0.25) * (1 - Math.max(0, (local - 0.9) / 0.1)) + 1e-3);
        cargo.position.copy(tmp);
      } else if (eventIndex === 1) {
        // Recycling: a tubule extends toward the membrane and carries an empty receptor back.
        tubule.visible = receptor.visible = true;
        const grow = Math.min(1, local / 0.35);
        const dir = membraneSpot.clone().sub(ee.center);
        const length = dir.length() * grow;
        dir.normalize();
        tubule.position.copy(ee.center).addScaledVector(dir, length / 2);
        tubule.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        tubule.scale.set(1, Math.max(0.001, length), 1);
        const travel = easeInOut(Math.max(0, (local - 0.35) / 0.55));
        receptor.position.copy(ee.center).addScaledVector(dir, ee.radius + travel * (length - ee.radius));
      } else {
        // Degradation: material from the late endosome is delivered to a lysosome.
        cargo.visible = true;
        const s = easeInOut(Math.min(1, local / 0.7));
        cargo.position.copy(le.center).lerp(lysosome.center, s);
        const f = local > 0.65 ? pulse((local - 0.65) / 0.35) : 0;
        flash.position.copy(lysosome.center);
        flash.scale.setScalar(lysosome.radius * (1 + f * 0.8));
        (flash.material as THREE.MeshBasicMaterial).opacity = f * 0.6;
      }
    },
    setQuality(level) {
      const total = counts[level];
      earlyCount = Math.round((total * early.length) / (early.length + late.length));
      lateCount = total - earlyCount;
      earlyMesh.count = earlyCount;
      lateMesh.count = lateCount;
      ilvMesh.count = lateCount * ilvPerLate;
      return total;
    },
  });
}
