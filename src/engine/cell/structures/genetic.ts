import * as THREE from 'three';
import { Simplex3 } from '../../core/noise';
import { applyCutaway, applyFresnel, createCut, insideCut, standardFocus } from '../../core/materials';
import { capsuleProfile, mergeGeometries, noisyEllipsoid, profiledTube, rayEllipsoid, smoothCurve } from '../../core/geometry';
import { rngFor } from '../../core/random';
import { colorOf, makeInstance, raySphere, raySpheres } from '../common';
import type { CellLayout } from '../layout';
import type { BuildContext, StructureInstance } from '../types';

export interface PorePlacement {
  position: THREE.Vector3;
  normal: THREE.Vector3;
}

/** Nuclear pore positions (Fibonacci spiral with jitter), shared by the nucleus and nucleolus modules. */
export function porePlacements(layout: CellLayout): PorePlacement[] {
  const cached = layout.cache.get('pores') as PorePlacement[] | undefined;
  if (cached) return cached;
  const rng = rngFor('nuclear-pores');
  const count = 1000;
  const result: PorePlacement[] = [];
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  rng.shuffle(order); // so any prefix (lower quality) is spread evenly
  const dirs: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const k = i + 0.5;
    const y = 1 - (2 * k) / count;
    const r = Math.sqrt(1 - y * y);
    const a = k * 2.399963229728653 + rng.range(-0.02, 0.02);
    dirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  for (const i of order) {
    const d = dirs[i];
    const radii = layout.nucleusRadii;
    const position = layout.nucleusCenter.clone().add(d.clone().multiply(radii));
    const normal = new THREE.Vector3(d.x / radii.x, d.y / radii.y, d.z / radii.z).normalize();
    result.push({ position, normal });
  }
  layout.cache.set('pores', result);
  return result;
}

function rimFrame(cutDir: THREE.Vector3) {
  const side = new THREE.Vector3().crossVectors(cutDir, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(side, cutDir).normalize();
  return { side, up };
}

/**
 * Nucleus: a double nuclear envelope (outer and inner membrane with the
 * perinuclear space between them), opened toward the viewer, studded with
 * nuclear pore complexes at about true size. Teal particles are imported,
 * amber particles exported (illustrative, slowed traffic).
 */
export function buildNucleus(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const cut = ctx.cuts.nucleus;
  const root = new THREE.Group();
  const color = colorOf('nucleus');
  const noise = new Simplex3('nucleus-shape');

  const outerGeometry = noisyEllipsoid(layout.nucleusRadii, 4, noise, 0.012, 1.6);
  const innerGeometry = noisyEllipsoid(layout.nucleusRadii.clone().subScalar(layout.envelopeGap), 4, noise, 0.012, 1.6);

  const outer = new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.62),
    emissive: '#3b2a8f',
    roughness: 0.4,
    side: THREE.FrontSide,
    transparent: true,
  });
  applyFresnel(outer, '#d9ccff', 2.0, 0.6, 'nucleus-fresnel');
  applyCutaway(outer, cut, 0.02, 'nucleus-outer');
  const inner = new THREE.MeshStandardMaterial({
    color: '#2d2163',
    emissive: '#1d1450',
    roughness: 0.8,
    side: THREE.DoubleSide,
    transparent: true,
  });
  applyCutaway(inner, cut, 0.02, 'nucleus-inner');
  const outerMesh = new THREE.Mesh(outerGeometry, outer);
  const innerMesh = new THREE.Mesh(innerGeometry, inner);
  outerMesh.position.copy(layout.nucleusCenter);
  innerMesh.position.copy(layout.nucleusCenter);
  innerMesh.renderOrder = -1;
  root.add(innerMesh, outerMesh);

  // Nuclear pore complexes (rings) at their true ~0.12 µm size.
  const pores = porePlacements(layout);
  const poreGeometry = new THREE.TorusGeometry(0.05, 0.018, 6, 14);
  poreGeometry.rotateX(Math.PI / 2); // ring axis along +Y
  const poreMaterial = new THREE.MeshStandardMaterial({ color: '#e8e2ff', emissive: '#7d6cff', roughness: 0.45, transparent: true });
  applyCutaway(poreMaterial, cut, 0.015, 'nucleus-pores');
  const poreMesh = new THREE.InstancedMesh(poreGeometry, poreMaterial, pores.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  pores.forEach((pore, i) => {
    q.setFromUnitVectors(up, pore.normal);
    m.compose(pore.position, q, new THREE.Vector3(1, 1, 1));
    poreMesh.setMatrixAt(i, m);
  });
  root.add(poreMesh);

  // Import (teal) and export (amber) traffic through a subset of pores.
  const rng = rngFor('pore-traffic');
  const trafficCount = 56;
  const traffic = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.035, 10, 8),
    new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.4, transparent: true }),
    trafficCount,
  );
  const trafficMaterial = traffic.material as THREE.MeshStandardMaterial;
  const lanes = Array.from({ length: trafficCount }, (_, i) => {
    const importing = i % 2 === 0;
    const pore = pores[rng.int(0, 299)];
    traffic.setColorAt(i, new THREE.Color(importing ? '#3fe0d0' : '#ffb547'));
    const tangent = new THREE.Vector3().crossVectors(pore.normal, rng.direction()).normalize();
    return { importing, pore, tangent, phase: rng.next(), period: rng.range(5, 8), lateral: rng.range(0.2, 0.6) };
  });
  traffic.instanceColor!.needsUpdate = true;
  root.add(traffic);

  const focus = [
    standardFocus(outer, { baseOpacity: 0.62, emissiveBase: 0.35, emissiveBoost: 0.45 }),
    standardFocus(inner, { baseOpacity: 0.85, emissiveBase: 0.3, emissiveBoost: 0.3 }),
    standardFocus(poreMaterial, { baseOpacity: 1, emissiveBase: 0.25, emissiveBoost: 0.6 }),
    standardFocus(trafficMaterial, { baseOpacity: 1, emissiveBase: 0.6, emissiveBoost: 0.4 }),
  ];

  const counts = { low: 350, medium: 650, high: pores.length };
  const radii = layout.nucleusRadii;
  const center = layout.nucleusCenter;
  const hitPoint = new THREE.Vector3();
  const p = new THREE.Vector3();
  const scaleVec = new THREE.Vector3();

  return makeInstance('nucleus', root, {
    focus,
    raycast(ray) {
      const hit = rayEllipsoid(ray, center, radii);
      if (!hit) return null;
      for (const t of hit) {
        if (t < 0) continue;
        ray.at(t, hitPoint);
        if (!insideCut(cut, hitPoint)) return t;
      }
      return null;
    },
    framing() {
      return { target: center.clone(), radius: 3.35, direction: new THREE.Vector3(0.12, 0.3, 1).normalize() };
    },
    labelAnchors() {
      const dir = cut.uCutDir.value.clone();
      const { up, side } = rimFrame(dir);
      const angle = Math.acos(Math.min(1, cut.uCutCos.value)) + 0.25;
      return [0, 0.8, -0.8, Math.PI].map((a) => {
        const tangent = up.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
        const d = dir.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangent, Math.sin(angle)).normalize();
        return center.clone().add(d.multiply(radii));
      });
    },
    partAnchors() {
      const dir = cut.uCutDir.value.clone();
      const { up, side } = rimFrame(dir);
      const angle = Math.acos(Math.min(1, cut.uCutCos.value));
      const at = (a: number, extra: number, scale: number) => {
        const tangent = up.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
        const d = dir.clone().multiplyScalar(Math.cos(angle + extra)).addScaledVector(tangent, Math.sin(angle + extra)).normalize();
        return center.clone().add(d.multiply(radii).multiplyScalar(scale));
      };
      // A pore on the visible surface near the rim.
      let pore = pores[0].position;
      let best = -Infinity;
      for (let i = 0; i < counts.low; i++) {
        const dd = pores[i].normal.dot(dir);
        if (dd < cut.uCutCos.value - 0.05 && dd > best) {
          best = dd;
          pore = pores[i].position;
        }
      }
      const importLane = lanes.find((l) => l.importing)!;
      const exportLane = lanes.find((l) => !l.importing)!;
      return [
        { part: 'outer-membrane', position: at(0.4, 0.02, 1) },
        { part: 'inner-membrane', position: at(-0.5, 0.0, 0.985) },
        { part: 'pore-complex', position: pore.clone() },
        { part: 'import', position: importLane.pore.position.clone().addScaledVector(importLane.pore.normal, 0.4) },
        { part: 'export', position: exportLane.pore.position.clone().addScaledVector(exportLane.pore.normal, 0.4) },
      ];
    },
    update(_dt, time) {
      for (let i = 0; i < trafficCount; i++) {
        const lane = lanes[i];
        const phase = (time / lane.period + lane.phase) % 1;
        // 0–0.45 approach, 0.45–0.55 pass the pore, 0.55–1 depart and fade.
        const s = lane.importing ? phase : 1 - phase;
        const outside = THREE.MathUtils.smoothstep(1 - s, 0.4, 1);
        p.copy(lane.pore.position)
          .addScaledVector(lane.pore.normal, (0.5 - s) * 1.6)
          .addScaledVector(lane.tangent, lane.lateral * outside * (s < 0.5 ? 1 : -0.6));
        const visible = Math.min(1, Math.min(phase, 1 - phase) * 6);
        scaleVec.setScalar(Math.max(0.0001, visible));
        m.compose(p, q.identity(), scaleVec);
        traffic.setMatrixAt(i, m);
      }
      traffic.instanceMatrix.needsUpdate = true;
    },
    setQuality(level) {
      poreMesh.count = counts[level];
      return null;
    },
  });
}

const CHROMOSOME_HUES = [
  '#f06bc8', '#ff8fa3', '#c58bff', '#8fa8ff', '#6fd3ff', '#5ee6c5', '#9be86b', '#e8e06b', '#ffb36b', '#ff7d7d', '#e889ff', '#b0b8ff',
  '#7ce0ff', '#7dffb5', '#d6ff7d', '#ffd27d', '#ff9d7d', '#ff7db8', '#cf9dff', '#9dc1ff', '#9dffe1', '#f5ff9d', '#ffc1f0',
];

/** Interphase chromatin: 46 territories of tangled fibres; one compact inactive X (Barr body). */
export function buildChromosomes(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const root = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  for (const territory of layout.territories) {
    const curve = smoothCurve(territory.path);
    const radius = territory.inactiveX ? 0.05 : 0.034;
    const geometry = profiledTube(curve, territory.path.length * 3, 5, capsuleProfile(radius, curve.getLength()));
    const hue = CHROMOSOME_HUES[(territory.chromosome - 1) % CHROMOSOME_HUES.length];
    color.set(hue);
    if (territory.inactiveX) color.lerp(new THREE.Color('#ffffff'), 0.25);
    else if (territory.homolog === 1) color.multiplyScalar(0.88);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([color.r, color.g, color.b], i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.deleteAttribute('aT');
    geometries.push(geometry);
  }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: '#ff7ad1', transparent: false });
  const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
  geometries.forEach((g) => g.dispose());
  root.add(mesh);
  const xi = layout.territories.find((t) => t.inactiveX)!;
  const cut = ctx.cuts.nucleus;

  return makeInstance('chromosomes', root, {
    focus: [standardFocus(material, { emissiveBase: 0.12, emissiveBoost: 0.35 })],
    raycast(ray) {
      return raySpheres(ray, layout.territories.map((t) => ({ center: t.center, radius: t.radius * 0.8 })));
    },
    framing() {
      return { target: layout.nucleusCenter.clone(), radius: 3.05, direction: new THREE.Vector3(0.1, 0.25, 1).normalize() };
    },
    labelAnchors() {
      const dir = cut.uCutDir.value;
      return [...layout.territories]
        .sort((a, b) => b.center.clone().sub(layout.nucleusCenter).dot(dir) - a.center.clone().sub(layout.nucleusCenter).dot(dir))
        .slice(0, 4)
        .map((t) => t.center.clone());
    },
    partAnchors() {
      const dir = cut.uCutDir.value;
      const front = [...layout.territories]
        .filter((t) => !t.inactiveX)
        .sort((a, b) => b.center.clone().sub(layout.nucleusCenter).dot(dir) - a.center.clone().sub(layout.nucleusCenter).dot(dir))[0];
      return [
        { part: 'territory', position: front.center.clone() },
        { part: 'inactive-x', position: xi.center.clone() },
        { part: 'chromosome-end', position: front.path[0].clone() },
      ];
    },
  });
}

/** Telomeres: glowing markers at both ends of every chromosome fibre (92 in a diploid cell). */
export function buildTelomeres(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const ends: THREE.Vector3[] = [];
  for (const territory of layout.territories) {
    ends.push(territory.path[0].clone(), territory.path[territory.path.length - 1].clone());
  }
  const material = new THREE.MeshStandardMaterial({ color: '#fff3a3', emissive: '#ffe066', roughness: 0.3, transparent: false });
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 12, 10), material, ends.length);
  const m = new THREE.Matrix4();
  ends.forEach((p, i) => mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  const root = new THREE.Group();
  root.add(mesh);
  const cut = ctx.cuts.nucleus;
  const phases = ends.map((_, i) => (i * 0.618) % 1);
  const scale = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const frontmost = () =>
    [...ends].sort(
      (a, b) => b.clone().sub(layout.nucleusCenter).dot(cut.uCutDir.value) - a.clone().sub(layout.nucleusCenter).dot(cut.uCutDir.value),
    );

  return makeInstance('telomeres', root, {
    focus: [standardFocus(material, { emissiveBase: 0.8, emissiveBoost: 0.8 })],
    raycast(ray) {
      let best: number | null = null;
      for (const p of ends) {
        const t = raySphere(ray, p, 0.13);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
    framing() {
      const target = frontmost()[0].clone().lerp(layout.nucleusCenter, 0.25);
      return { target, radius: 1.9, direction: target.clone().sub(layout.nucleusCenter).normalize().add(new THREE.Vector3(0, 0.2, 0.5)).normalize() };
    },
    labelAnchors() {
      return frontmost().slice(0, 4);
    },
    partAnchors() {
      return [{ part: 'chromosome-end', position: frontmost()[0].clone() }];
    },
    update(_dt, time, uctx) {
      if (uctx.calm) return;
      for (let i = 0; i < ends.length; i++) {
        const s = 1 + 0.18 * Math.sin(time * 1.6 + phases[i] * 6.283);
        scale.setScalar(s);
        m.compose(ends[i], q, scale);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  });
}

/**
 * Nucleoli: granular bodies inside the nucleus. When focused, the large one
 * opens toward the viewer to show pale fibrillar centres wrapped in dense
 * fibrillar shells. New ribosomal subunits drift from it to nuclear pores and
 * out into the cytoplasm.
 */
export function buildNucleolus(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const root = new THREE.Group();
  const rng = rngFor('nucleolus');
  const noise = new Simplex3('nucleolus');
  const ownCut = createCut(layout.nucleoli[0].center, '#ffd2b8');

  const gcMaterial = new THREE.MeshStandardMaterial({ color: '#c8552c', emissive: '#ff6a2e', roughness: 0.85, transparent: true, side: THREE.DoubleSide });
  applyCutaway(gcMaterial, ownCut, 0.03, 'nucleolus-gc');
  const fcMaterial = new THREE.MeshStandardMaterial({ color: '#ffe3c9', emissive: '#ffc690', roughness: 0.5 });
  const dfcMaterial = new THREE.MeshStandardMaterial({ color: '#ff9156', emissive: '#ff7a3d', roughness: 0.6, transparent: true });
  const fcs: Array<{ center: THREE.Vector3; radius: number }> = [];
  layout.nucleoli.forEach((nucleolus, index) => {
    const gc = new THREE.Mesh(noisyEllipsoid(new THREE.Vector3(1, 1, 1).multiplyScalar(nucleolus.radius), 4, noise, 0.07, 3.2), gcMaterial);
    gc.position.copy(nucleolus.center);
    root.add(gc);
    const n = index === 0 ? 6 : 2;
    for (let i = 0; i < n; i++) {
      const r = rng.range(0.07, 0.11);
      const c = nucleolus.center.clone().add(rng.inBall().multiplyScalar(nucleolus.radius * 0.55));
      fcs.push({ center: c, radius: r });
      const fc = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), fcMaterial);
      fc.position.copy(c);
      const dfc = new THREE.Mesh(new THREE.SphereGeometry(r + 0.065, 18, 14), dfcMaterial);
      dfc.position.copy(c);
      root.add(fc, dfc);
    }
  });

  // Ribosomal subunits leaving through pores near the nucleolus.
  const pores = porePlacements(layout);
  const main = layout.nucleoli[0];
  const nearPores = pores
    .slice(0, 350)
    .map((p) => ({ p, d: p.position.distanceTo(main.center) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12)
    .map((x) => x.p);
  const subunitCount = 18;
  const subunits = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshStandardMaterial({ color: '#ffcf70', emissive: '#ffb347', emissiveIntensity: 0.7, roughness: 0.4 }),
    subunitCount,
  );
  const subunitMaterial = subunits.material as THREE.MeshStandardMaterial;
  const lanes = Array.from({ length: subunitCount }, (_, i) => ({
    pore: nearPores[i % nearPores.length],
    start: main.center.clone().add(rng.direction().multiplyScalar(main.radius * 0.95)),
    large: i % 2 === 0,
    phase: rng.next(),
    period: rng.range(7, 11),
  }));
  root.add(subunits);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const p = new THREE.Vector3();
  let focused = false;
  const camPos = new THREE.Vector3();

  return makeInstance('nucleolus', root, {
    focus: [
      standardFocus(gcMaterial, { emissiveBase: 0.25, emissiveBoost: 0.4 }),
      standardFocus(fcMaterial, { emissiveBase: 0.35, emissiveBoost: 0.4 }),
      standardFocus(dfcMaterial, { baseOpacity: 0.85, emissiveBase: 0.3, emissiveBoost: 0.4 }),
      standardFocus(subunitMaterial, { emissiveBase: 0.7, emissiveBoost: 0.5 }),
    ],
    raycast(ray) {
      return raySpheres(ray, layout.nucleoli);
    },
    framing() {
      const dir = main.center.clone().sub(layout.nucleusCenter).normalize().add(new THREE.Vector3(0, 0.15, 0.9)).normalize();
      return { target: main.center.clone(), radius: 1.35, direction: dir };
    },
    labelAnchors() {
      return [main.center.clone(), layout.nucleoli[1].center.clone()];
    },
    partAnchors() {
      const sorted = [...fcs].sort((a, b) => a.center.distanceTo(main.center) - b.center.distanceTo(main.center));
      const fc = sorted[0];
      const dir = ownCut.uCutDir.value;
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const lane = lanes[0];
      const lane2 = lanes[1];
      return [
        { part: 'fibrillar-center', position: fc.center.clone() },
        { part: 'dense-fibrillar', position: sorted[1].center.clone().addScaledVector(side, sorted[1].radius + 0.05) },
        { part: 'granular', position: main.center.clone().addScaledVector(side, main.radius * 0.85) },
        { part: 'large-subunit', position: lane.start.clone() },
        { part: 'small-subunit', position: lane2.start.clone() },
      ];
    },
    setFocused(value) {
      focused = value;
    },
    update(_dt, time, uctx) {
      // Open the large nucleolus toward the camera while it is focused.
      uctx.camera.getWorldPosition(camPos);
      ownCut.uCutDir.value.copy(camPos).sub(main.center).normalize();
      ownCut.uCutCos.value = THREE.MathUtils.lerp(ownCut.uCutCos.value, focused ? 0.55 : 1.02, 0.08);
      for (let i = 0; i < subunitCount; i++) {
        const lane = lanes[i];
        const phase = (time / lane.period + lane.phase) % 1;
        const inside = lane.pore.position.clone().addScaledVector(lane.pore.normal, -0.2);
        const outside = lane.pore.position.clone().addScaledVector(lane.pore.normal, 0.7);
        if (phase < 0.7) p.copy(lane.start).lerp(inside, phase / 0.7);
        else p.copy(inside).lerp(outside, (phase - 0.7) / 0.3);
        const fade = Math.min(1, Math.min(phase, 1 - phase) * 8);
        sv.setScalar((lane.large ? 0.04 : 0.03) * fade + 1e-4);
        m.compose(p, q, sv);
        subunits.setMatrixAt(i, m);
      }
      subunits.instanceMatrix.needsUpdate = true;
    },
  });
}
