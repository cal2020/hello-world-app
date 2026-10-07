import * as THREE from 'three';
import { applyCutaway, applyFresnel, createCut, standardFocus } from '../../core/materials';
import { mergeGeometries, profiledTube, smoothCurve } from '../../core/geometry';
import { rngFor } from '../../core/random';
import { colorOf, makeInstance, raySphere, sampleCurves } from '../common';
import { MT_GLSL, mtLength, mtParams, type MtParams } from '../mtDynamics';
import type { BuildContext, StructureInstance } from '../types';

const FRONT = new THREE.Vector3(0.15, 0.25, 1).normalize();

/**
 * Microtubules: hollow tubes (drawn ×2.4 thicker) radiating from the
 * centrosome. Each shows dynamic instability: slow growth with a bright
 * GTP-cap tip, sudden catastrophe, rapid shrinkage, rescue.
 */
export function buildMicrotubules(ctx: BuildContext, params: MtParams): StructureInstance {
  const { layout } = ctx;
  const curves = layout.microtubules;
  const color = colorOf('microtubules');
  const geometries: THREE.BufferGeometry[] = [];
  const indexCounts: number[] = [];
  curves.forEach((curve, i) => {
    const len = curve.getLength();
    const g = profiledTube(curve, Math.max(8, Math.round(len / 0.18)), 5, () => 0.03);
    const n = g.attributes.position.count;
    g.setAttribute('aPeriod', new THREE.Float32BufferAttribute(new Array(n).fill(params.period[i]), 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(new Array(n).fill(params.phase[i]), 1));
    g.setAttribute('aMin', new THREE.Float32BufferAttribute(new Array(n).fill(params.minimum[i]), 1));
    g.setAttribute('aLen', new THREE.Float32BufferAttribute(new Array(n).fill(len), 1));
    indexCounts.push(g.index!.count);
    geometries.push(g);
  });
  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.7), emissive: color, roughness: 0.5 });
  const dynamics = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.time;
    shader.uniforms.uDynamics = dynamics;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float aT;\nattribute float aPeriod;\nattribute float aPhase;\nattribute float aMin;\nattribute float aLen;\nuniform float uTime;\nuniform float uDynamics;\nvarying float vT;\nvarying float vLen;\nvarying float vGrowing;\nvarying float vLenUnits;\n${MT_GLSL}`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vT = aT;
        vLen = uDynamics > 0.5 ? mtLength(aPeriod, aPhase, aMin, uTime) : 1.0;
        vGrowing = fract(uTime / aPeriod + aPhase) < 0.8 ? 1.0 : 0.0;
        vLenUnits = aLen;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vT;\nvarying float vLen;\nvarying float vGrowing;\nvarying float vLenUnits;')
      .replace(
        'void main() {',
        /* glsl */ `void main() {
        if (vT > vLen) discard;
        float tipDistance = (vLen - vT) * vLenUnits;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.85, 0.95, 1.0) * vGrowing * smoothstep(0.35, 0.0, tipDistance) * 1.1;`,
      );
  };
  material.customProgramCacheKey = () => 'microtubules';
  const mesh = new THREE.Mesh(merged, material);
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.add(mesh);

  const samples = sampleCurves(curves, 0.25);
  const counts = { low: 70, medium: 110, high: curves.length };
  let count = curves.length;
  let lastTime = 0;
  const p = new THREE.Vector3();

  return makeInstance('microtubules', root, {
    focus: [standardFocus(material, { emissiveBase: 0.07, emissiveBoost: 0.45 })],
    raycast(ray) {
      let best: number | null = null;
      for (let k = 0; k < samples.owner.length; k++) {
        const owner = samples.owner[k];
        if (owner >= count) continue;
        if (samples.t[k] > mtLength(params, owner, lastTime)) continue;
        p.set(samples.points[k * 3], samples.points[k * 3 + 1], samples.points[k * 3 + 2]);
        const t = raySphere(ray, p, 0.08);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
    framing() {
      const dir = FRONT.clone().addScaledVector(layout.hub, -0.4).normalize();
      return { target: layout.centrosome.clone().addScaledVector(layout.hub, 1.2), radius: 3.6, direction: dir };
    },
    labelAnchors() {
      return curves.slice(0, 20).map((c, i) => c.getPointAt(Math.min(0.6, mtLength(params, i, lastTime) * 0.8)));
    },
    partAnchors() {
      // A growing microtubule near the front for the plus end.
      let index = 0;
      let bestDot = -Infinity;
      for (let i = 0; i < count; i++) {
        const end = curves[i].getPointAt(0.6);
        const d = end.clone().normalize().dot(FRONT);
        if (d > bestDot) {
          bestDot = d;
          index = i;
        }
      }
      const length = mtLength(params, index, lastTime);
      return [
        { part: 'plus-end', position: curves[index].getPointAt(length) },
        { part: 'minus-end', position: curves[index].getPointAt(0.02) },
      ];
    },
    update(_dt, time) {
      lastTime = time;
      dynamics.value = 1;
    },
    setQuality(level) {
      count = counts[level];
      merged.setDrawRange(0, indexCounts.slice(0, count).reduce((a, b) => a + b, 0));
      return count;
    },
  });
}

/**
 * Actin cortex: short filament segments (drawn ×4 thicker) just inside the
 * membrane. They lengthen and shorten (polymerization/depolymerization).
 */
export function buildActin(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('actin');
  const max = 2600;
  const color = colorOf('actin');
  const geometry = new THREE.CylinderGeometry(0.014, 0.014, 1, 5, 1);
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.85), emissive: color, roughness: 0.5 });
  // Own cut: mirrors the membrane cut, but turns off while actin is focused so the cortex stays visible.
  const cut = createCut(layout.cellCenter, '#ffd0d0');
  applyCutaway(material, cut, 0.005, 'actin-cut');
  const motion = { value: 1 };
  const phases = new Float32Array(max);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uTime = ctx.time;
    shader.uniforms.uMotion = motion;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uMotion;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        float grow = 0.65 + 0.35 * sin(uTime * 0.9 + aPhase * 6.2831) * uMotion;
        transformed.y = (transformed.y + 0.5) * grow - 0.5;`,
      );
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|actin-grow`;
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  const centers = new Float32Array(max * 3);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < max; i++) {
    const dir = rng.direction();
    const inset = rng.range(0.935, 0.985);
    const p = layout.membranePoint(dir, inset);
    const tangent = new THREE.Vector3().crossVectors(dir, rng.direction()).normalize();
    const length = rng.range(0.3, 0.75);
    q.setFromUnitVectors(up, tangent);
    // Cylinder origin at its base so growth extends from one (barbed) end.
    const base = p.clone().addScaledVector(tangent, -length / 2);
    m.compose(base.clone().addScaledVector(tangent, length / 2), q, new THREE.Vector3(1, length, 1));
    mesh.setMatrixAt(i, m);
    centers.set([p.x, p.y, p.z], i * 3);
    phases[i] = rng.next();
  }
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  const root = new THREE.Group();
  root.add(mesh);
  const counts = { low: 900, medium: 1600, high: max };
  let count = max;
  let focused = false;
  const membraneCut = ctx.cuts.membrane;
  const viewDir = new THREE.Vector3(0.35, 0.75, 0.55).normalize();
  const patchCenter = layout.membranePoint(viewDir, 0.955);
  const c = new THREE.Vector3();

  return makeInstance('actin', root, {
    focus: [standardFocus(material, { emissiveBase: 0.15, emissiveBoost: 0.5 })],
    raycast(ray) {
      let best: number | null = null;
      for (let i = 0; i < count; i++) {
        c.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
        const t = raySphere(ray, c, 0.12);
        if (t === null || (best !== null && t >= best)) continue;
        if (!focused && cut.uCutCos.value <= 1) {
          const d = c.clone().sub(cut.uCutCenter.value).normalize();
          if (d.dot(cut.uCutDir.value) > cut.uCutCos.value) continue;
        }
        best = t;
      }
      return best;
    },
    framing() {
      // Seen from inside the cell, looking out at the cortex lining the membrane.
      return { target: patchCenter.clone(), radius: 1.5, direction: viewDir.clone().negate() };
    },
    labelAnchors() {
      const out: THREE.Vector3[] = [];
      const dir = membraneCut.uCutDir.value.clone();
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      for (const a of [1.0, -1.0, 1.6]) {
        const d = dir.clone().applyAxisAngle(side, a * 0.85).normalize();
        out.push(layout.membranePoint(d, 0.95));
      }
      return out;
    },
    partAnchors() {
      return [{ part: 'cortex', position: patchCenter.clone() }];
    },
    setFocused(value) {
      focused = value;
    },
    update(_dt, _time, uctx) {
      motion.value = uctx.calm ? 0 : 1;
      cut.uCutCenter.value.copy(membraneCut.uCutCenter.value);
      cut.uCutDir.value.copy(membraneCut.uCutDir.value);
      cut.uCutCos.value = focused ? 1.01 : membraneCut.uCutCos.value;
    },
    setQuality(level) {
      count = counts[level];
      mesh.count = count;
      return count;
    },
  });
}

/**
 * Intermediate filaments (vimentin, as in fibroblast-like cells): a wavy cage
 * around the nucleus with strands reaching the cortex. They sway gently but
 * stay in place.
 */
export function buildIntermediateFilaments(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('intermediate-filaments');
  const color = colorOf('intermediate-filaments');
  const curves: THREE.CatmullRomCurve3[] = [];
  const max = 80;
  const cageCount = 16;
  // Perinuclear cage first (always drawn), then radial strands (thinned at lower quality).
  while (curves.length < cageCount) {
    const axis = rng.direction();
    const a = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
    const b = new THREE.Vector3().crossVectors(axis, a).normalize();
    const start = rng.range(0, Math.PI * 2);
    const span = rng.range(1.6, 3.2);
    const points: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const ang = start + (span * k) / 8;
      const d = a.clone().multiplyScalar(Math.cos(ang)).addScaledVector(b, Math.sin(ang)).normalize();
      points.push(layout.nucleusCenter.clone().addScaledVector(d, layout.nucleusRadius(d) + 0.3 + rng.range(-0.05, 0.08)));
    }
    curves.push(smoothCurve(points));
  }
  let attempts = 0;
  while (curves.length < max && attempts++ < 2000) {
    const d = rng.direction();
    const start = layout.nucleusCenter.clone().addScaledVector(d, layout.nucleusRadius(d) + rng.range(0.22, 0.45));
    const endDir = d.clone().add(rng.direction().multiplyScalar(0.6)).normalize();
    const end = layout.membranePoint(endDir, rng.range(0.86, 0.93));
    const points: THREE.Vector3[] = [];
    for (let k = 0; k <= 5; k++) {
      const p = start.clone().lerp(end, k / 5).add(rng.direction().multiplyScalar(k === 0 || k === 5 ? 0 : 0.35));
      const off = p.clone().sub(layout.nucleusCenter);
      const dir = off.clone().normalize();
      if (layout.nucleusClearance(p) < 0.2) p.copy(layout.nucleusCenter).addScaledVector(dir, layout.nucleusRadius(dir) + 0.25);
      points.push(p);
    }
    curves.push(smoothCurve(points));
  }
  const geometries = curves.map((curve) => profiledTube(curve, Math.max(10, Math.round(curve.getLength() / 0.15)), 4, () => 0.02));
  const indexCounts = geometries.map((g) => g.index!.count);
  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.85), emissive: color, roughness: 0.55 });
  const sway = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.time;
    shader.uniforms.uSway = sway;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSway;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vec3 wp = position;
        transformed += uSway * 0.03 * vec3(sin(uTime * 0.45 + wp.y * 1.3), sin(uTime * 0.38 + wp.z * 1.1), sin(uTime * 0.41 + wp.x * 1.2));`,
      );
  };
  material.customProgramCacheKey = () => 'if-sway';
  const mesh = new THREE.Mesh(merged, material);
  const root = new THREE.Group();
  root.add(mesh);
  const samples = sampleCurves(curves, 0.25);
  const counts = { low: 40, medium: 60, high: max };
  let count = max;
  const p = new THREE.Vector3();
  const front = layout.nucleusCenter.clone().addScaledVector(FRONT, layout.nucleusRadius(FRONT) + 0.6);

  return makeInstance('intermediate-filaments', root, {
    focus: [standardFocus(material, { emissiveBase: 0.12, emissiveBoost: 0.45 })],
    raycast(ray) {
      let best: number | null = null;
      for (let k = 0; k < samples.owner.length; k++) {
        if (samples.owner[k] >= count) continue;
        p.set(samples.points[k * 3], samples.points[k * 3 + 1], samples.points[k * 3 + 2]);
        const t = raySphere(ray, p, 0.08);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
    framing() {
      return { target: layout.nucleusCenter.clone().addScaledVector(FRONT, 1.4), radius: 4.2, direction: FRONT.clone() };
    },
    labelAnchors() {
      return [front, ...curves.slice(cageCount, cageCount + 8).map((c) => c.getPointAt(0.5))];
    },
    partAnchors() {
      return [
        { part: 'perinuclear-cage', position: curves[0].getPointAt(0.5) },
        { part: 'filament', position: curves[cageCount].getPointAt(0.6) },
      ];
    },
    update(_dt, _time, uctx) {
      sway.value = uctx.calm ? 0 : 1;
    },
    setQuality(level) {
      count = counts[level];
      merged.setDrawRange(0, indexCounts.slice(0, count).reduce((a, b) => a + b, 0));
      return count;
    },
  });
}

/**
 * Centrosome: two centrioles at right angles (nine microtubule triplets
 * each, drawn at true size) inside a soft cloud of pericentriolar material
 * dotted with γ-tubulin ring complexes where microtubules start.
 */
export function buildCentrosome(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('centrosome');
  const root = new THREE.Group();
  const color = colorOf('centrosome');
  const tubeGeometry = new THREE.CylinderGeometry(0.0125, 0.0125, 1, 6, 1);
  const tripletMaterial = new THREE.MeshStandardMaterial({ color: '#efe8ff', emissive: color, roughness: 0.35 });
  const tubes = new THREE.InstancedMesh(tubeGeometry, tripletMaterial, 2 * 9 * 3);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let index = 0;
  const centrioleCenters: THREE.Vector3[] = [];
  layout.centrioleAxes.forEach((axis, c) => {
    const length = c === 0 ? 0.48 : 0.42;
    const center = layout.centrosome.clone().addScaledVector(c === 0 ? layout.centrioleAxes[1] : axis, c === 0 ? -0.08 : 0.2);
    centrioleCenters.push(center);
    const a = new THREE.Vector3().crossVectors(axis, up).normalize();
    if (a.lengthSq() < 0.01) a.set(1, 0, 0);
    const b = new THREE.Vector3().crossVectors(axis, a).normalize();
    q.setFromUnitVectors(up, axis);
    for (let k = 0; k < 9; k++) {
      const ang = (k / 9) * Math.PI * 2;
      for (let j = 0; j < 3; j++) {
        // Triplets are tilted like a pinwheel: inner (A) to outer (C) tubule.
        const r = 0.085 + j * 0.022;
        const offset = a
          .clone()
          .multiplyScalar(Math.cos(ang + j * 0.22) * r)
          .addScaledVector(b, Math.sin(ang + j * 0.22) * r);
        m.compose(center.clone().add(offset), q, new THREE.Vector3(1, j === 2 ? length * 0.85 : length, 1));
        tubes.setMatrixAt(index++, m);
      }
    }
  });
  root.add(tubes);
  const pcmMaterial = new THREE.MeshStandardMaterial({ color: '#5d4f9a', emissive: color, roughness: 0.8, transparent: true, depthWrite: false });
  applyFresnel(pcmMaterial, '#efe6ff', 1.6, 0.8, 'pcm');
  const pcm = new THREE.Mesh(new THREE.SphereGeometry(0.46, 32, 24), pcmMaterial);
  pcm.position.copy(layout.centrosome);
  pcm.renderOrder = 3;
  root.add(pcm);
  const turcMaterial = new THREE.MeshStandardMaterial({ color: '#ffb46b', emissive: '#ff9440', roughness: 0.4 });
  const turcs = new THREE.InstancedMesh(new THREE.TorusGeometry(0.018, 0.006, 5, 10), turcMaterial, 40);
  for (let i = 0; i < 40; i++) {
    const d = rng.direction();
    const p = layout.centrosome.clone().addScaledVector(d, rng.range(0.28, 0.42));
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    m.compose(p, q, new THREE.Vector3(1, 1, 1));
    turcs.setMatrixAt(i, m);
  }
  root.add(turcs);

  return makeInstance('centrosome', root, {
    focus: [
      standardFocus(tripletMaterial, { emissiveBase: 0.35, emissiveBoost: 0.5 }),
      standardFocus(pcmMaterial, { baseOpacity: 0.32, alwaysTransparent: true, emissiveBase: 0.35, emissiveBoost: 0.4, depthWriteAbove: 2 }),
      standardFocus(turcMaterial, { emissiveBase: 0.5, emissiveBoost: 0.4 }),
    ],
    raycast(ray) {
      return raySphere(ray, layout.centrosome, 0.5);
    },
    framing() {
      const dir = FRONT.clone().addScaledVector(layout.hub, 0.3).normalize();
      return { target: layout.centrosome.clone(), radius: 0.75, direction: dir };
    },
    labelAnchors() {
      return [layout.centrosome.clone()];
    },
    partAnchors() {
      return [
        { part: 'mother-centriole', position: centrioleCenters[0].clone() },
        { part: 'daughter-centriole', position: centrioleCenters[1].clone() },
        { part: 'pcm', position: layout.centrosome.clone().add(new THREE.Vector3(0, 0.4, 0)) },
      ];
    },
  });
}

export { mtParams };
