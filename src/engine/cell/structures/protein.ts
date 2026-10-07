import * as THREE from 'three';
import { Simplex3 } from '../../core/noise';
import { applyCutaway, insideCut, standardFocus } from '../../core/materials';
import { mergeGeometries, rayEllipsoid, smoothCurve, spherePatch } from '../../core/geometry';
import { rngFor } from '../../core/random';
import { colorOf, easeInOut, makeInstance, rayPoints, raySphere, sampleCurves } from '../common';
import type { CellLayout, ErLayer } from '../layout';
import { mtLength, mtParams, type MtParams } from '../mtDynamics';
import type { BuildContext, StructureInstance } from '../types';

const FRONT = new THREE.Vector3(0.15, 0.25, 1).normalize();

function layerPoint(layout: CellLayout, layer: ErLayer, dir: THREE.Vector3): THREE.Vector3 {
  return layout.nucleusCenter.clone().add(dir.clone().multiply(layer.radii));
}

/** Best direction to look at the ER sheets: well covered and facing the default view. */
function erViewDirection(layout: CellLayout): THREE.Vector3 {
  const cached = layout.cache.get('er-view') as THREE.Vector3 | undefined;
  if (cached) return cached;
  const rng = rngFor('er-view');
  let best = FRONT.clone();
  let bestScore = -Infinity;
  const d = new THREE.Vector3();
  for (let i = 0; i < 600; i++) {
    rng.direction(d);
    if (d.dot(FRONT) < 0.2) continue;
    let cover = 0;
    layout.erLayers.forEach((layer, k) => {
      if (layout.erMaskAt(layer, d)) cover += k < 2 ? 1.2 : 1;
    });
    const score = cover + d.dot(FRONT) * 1.5 - Math.max(0, d.dot(layout.hub)) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = d.clone();
    }
  }
  layout.cache.set('er-view', best);
  return best;
}

/** ER exit site: a sheet point on the inner layers closest to the Golgi. */
export function erExitSite(layout: CellLayout): THREE.Vector3 {
  const cached = layout.cache.get('er-exit') as THREE.Vector3 | undefined;
  if (cached) return cached;
  const rng = rngFor('er-exit');
  const golgi = layout.golgiStacks[1].center;
  let best = layout.nucleusCenter.clone();
  let bestD = Infinity;
  const d = new THREE.Vector3();
  for (let i = 0; i < 4000; i++) {
    rng.direction(d);
    const layer = layout.erLayers[1];
    if (!layout.erMaskAt(layer, d)) continue;
    const p = layerPoint(layout, layer, d);
    const dist = p.distanceTo(golgi);
    if (dist < bestD) {
      bestD = dist;
      best = p;
    }
  }
  layout.cache.set('er-exit', best);
  return best;
}

/**
 * Rough ER: stacked, fenestrated sheets wrapped around the nucleus and joined
 * to it by short connections (the outer nuclear membrane is continuous with
 * the ER). The sheets are opened toward the viewer together with the nucleus.
 */
export function buildRoughEr(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const cut = ctx.cuts.nucleus;
  const root = new THREE.Group();
  const color = colorOf('rough-er');
  const noise = new Simplex3('er-sheets');
  const materials: THREE.MeshStandardMaterial[] = [];

  layout.erLayers.forEach((layer, index) => {
    const geometry = new THREE.SphereGeometry(1, 120, 60);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = noise.fbm(v.x * 2.2 + index, v.y * 2.2, v.z * 2.2, 2) * 0.06;
      v.multiply(layer.radii).addScaledVector(v.clone().normalize(), n);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.computeVertexNormals();
    // Mask rows are stored top (θ=0) first; SphereGeometry's v runs the other way.
    const data = new Uint8Array(layer.maskWidth * layer.maskHeight * 4);
    for (let y = 0; y < layer.maskHeight; y++) {
      const src = (layer.maskHeight - 1 - y) * layer.maskWidth;
      for (let x = 0; x < layer.maskWidth; x++) {
        const a = layer.mask[src + x];
        const i = (y * layer.maskWidth + x) * 4;
        data[i] = a;
        data[i + 1] = a;
        data[i + 2] = a;
        data[i + 3] = 255;
      }
    }
    const alphaMap = new THREE.DataTexture(data, layer.maskWidth, layer.maskHeight);
    alphaMap.magFilter = THREE.LinearFilter;
    alphaMap.minFilter = THREE.LinearMipmapLinearFilter;
    alphaMap.generateMipmaps = true;
    alphaMap.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.75 - index * 0.06),
      emissive: color,
      roughness: 0.45,
      metalness: 0.05,
      side: THREE.DoubleSide,
      alphaMap,
      alphaTest: 0.5,
    });
    applyCutaway(material, cut, 0.012, `er-layer`);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(layout.nucleusCenter);
    root.add(mesh);
    materials.push(material);
  });

  // Connections between the nuclear envelope and the sheets, and between sheets.
  const rng = rngFor('er-connectors');
  const connectorGeometries: THREE.BufferGeometry[] = [];
  const d = new THREE.Vector3();
  let made = 0;
  for (let tries = 0; tries < 3000 && made < 46; tries++) {
    rng.direction(d);
    const k = rng.int(0, layout.erLayers.length - 1);
    const outerLayer = layout.erLayers[k];
    if (!layout.erMaskAt(outerLayer, d)) continue;
    const innerRadii = k === 0 ? layout.nucleusRadii : layout.erLayers[k - 1].radii;
    if (k > 0 && !layout.erMaskAt(layout.erLayers[k - 1], d)) continue;
    const a = layout.nucleusCenter.clone().add(d.clone().multiply(innerRadii));
    const b = layout.nucleusCenter.clone().add(d.clone().multiply(outerLayer.radii));
    const curve = new THREE.LineCurve3(a, b);
    connectorGeometries.push(new THREE.TubeGeometry(curve, 2, 0.05, 6, false));
    made++;
  }
  const connectorMaterial = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.7), emissive: color, roughness: 0.5 });
  applyCutaway(connectorMaterial, cut, 0.012, 'er-connector');
  if (connectorGeometries.length) root.add(new THREE.Mesh(mergeGeometries(connectorGeometries), connectorMaterial));
  materials.push(connectorMaterial);

  const exit = erExitSite(layout);
  const exitBud = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), connectorMaterial);
  exitBud.position.copy(exit);
  root.add(exitBud);

  const viewDir = erViewDirection(layout);
  const hit = new THREE.Vector3();
  return makeInstance('rough-er', root, {
    focus: materials.map((m) => standardFocus(m, { emissiveBase: 0.12, emissiveBoost: 0.35 })),
    overviewOpacity: 0.9,
    raycast(ray) {
      let best: number | null = null;
      for (const layer of layout.erLayers) {
        const hits = rayEllipsoid(ray, layout.nucleusCenter, layer.radii);
        if (!hits) continue;
        for (const t of hits) {
          if (t < 0 || (best !== null && t >= best)) continue;
          ray.at(t, hit);
          if (insideCut(cut, hit)) continue;
          const dir = hit.clone().sub(layout.nucleusCenter).divide(layer.radii).normalize();
          if (layout.erMaskAt(layer, dir)) best = t;
        }
      }
      return best;
    },
    framing() {
      const target = layerPoint(layout, layout.erLayers[1], viewDir);
      return { target, radius: 1.55, direction: viewDir.clone() };
    },
    labelAnchors() {
      const dir = cut.uCutDir.value;
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const angle = Math.acos(Math.min(1, cut.uCutCos.value)) + 0.2;
      const out: THREE.Vector3[] = [];
      for (const a of [0.6, -0.6, 1.4, -1.4, 2.4]) {
        const up = new THREE.Vector3().crossVectors(side, dir);
        const tangent = up.multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
        const dd = dir.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangent, Math.sin(angle)).normalize();
        for (const layer of layout.erLayers.slice(0, 2)) if (layout.erMaskAt(layer, dd)) out.push(layerPoint(layout, layer, dd));
      }
      out.push(layerPoint(layout, layout.erLayers[1], viewDir));
      return out;
    },
    partAnchors() {
      const sheet = layerPoint(layout, layout.erLayers[1], viewDir);
      const inner = layerPoint(layout, layout.erLayers[0], viewDir);
      return [
        { part: 'er-sheet', position: sheet },
        { part: 'lumen', position: sheet.clone().lerp(inner, 0.5) },
        { part: 'exit-site', position: exit.clone() },
      ];
    },
  });
}

/**
 * Smooth ER: a network of ribosome-free tubes with three-way junctions,
 * connected to the edges of the rough-ER sheets.
 */
export function buildSmoothEr(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const graph = layout.smoothEr;
  const rng = rngFor('smooth-er-tubes');
  const color = colorOf('smooth-er');
  const curves: THREE.Curve<THREE.Vector3>[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const addTube = (a: THREE.Vector3, b: THREE.Vector3) => {
    const mid = a.clone().lerp(b, 0.5).add(rng.direction().multiplyScalar(a.distanceTo(b) * 0.12));
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    curves.push(curve);
    geometries.push(new THREE.TubeGeometry(curve, 8, 0.04, 6, false));
  };
  for (const [i, j] of graph.edges) addTube(graph.nodes[i], graph.nodes[j]);
  for (const [point, j] of graph.connectors) addTube(point, graph.nodes[j]);
  const degree = new Array(graph.nodes.length).fill(0);
  for (const [i, j] of graph.edges) {
    degree[i]++;
    degree[j]++;
  }
  graph.nodes.forEach((node, i) => {
    if (degree[i] < 2) return;
    const s = new THREE.SphereGeometry(0.055, 8, 6);
    s.translate(node.x, node.y, node.z);
    geometries.push(s);
  });
  const material = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.8), emissive: color, roughness: 0.45 });
  const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
  geometries.forEach((g) => g.dispose());
  const root = new THREE.Group();
  root.add(mesh);
  const samples = sampleCurves(curves, 0.16);
  const frontNode = [...graph.nodes].sort((a, b) => b.clone().normalize().dot(FRONT) - a.clone().normalize().dot(FRONT))[0];
  const junction = graph.nodes.find((_, i) => degree[i] === 3) ?? frontNode;

  return makeInstance('smooth-er', root, {
    focus: [standardFocus(material, { emissiveBase: 0.12, emissiveBoost: 0.4 })],
    overviewOpacity: 0.85,
    raycast(ray) {
      return rayPoints(ray, samples.points, samples.points.length / 3, 0.09);
    },
    framing() {
      return { target: frontNode.clone(), radius: 1.9, direction: frontNode.clone().normalize().add(new THREE.Vector3(0, 0.3, 0.4)).normalize() };
    },
    labelAnchors() {
      return [...graph.nodes]
        .sort((a, b) => b.clone().normalize().dot(FRONT) - a.clone().normalize().dot(FRONT))
        .slice(0, 5)
        .map((n) => n.clone());
    },
    partAnchors() {
      const edge = graph.edges.find(([i, j]) => graph.nodes[i] === frontNode || graph.nodes[j] === frontNode) ?? graph.edges[0];
      return [
        { part: 'tubule', position: graph.nodes[edge[0]].clone().lerp(graph.nodes[edge[1]], 0.5) },
        { part: 'junction', position: junction.clone() },
      ];
    },
  });
}

/**
 * Ribosomes: two-lobed particles (enlarged ×2.5) on the rough-ER sheets and
 * the outer nuclear membrane, in polysome spirals, and free in the cytosol.
 * They jitter slightly in place (shader-driven).
 */
export function buildRibosomes(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('ribosomes');
  const max = 6000;
  const color = colorOf('ribosomes');
  const large = new THREE.SphereGeometry(0.034, 8, 6);
  const small = new THREE.SphereGeometry(0.025, 8, 6);
  small.translate(0, 0.036, 0.004);
  const geometry = mergeGeometries([large, small]);
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, roughness: 0.5 });
  const jitter = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.time;
    shader.uniforms.uJitter = jitter;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uJitter;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        float rid = float(gl_InstanceID);
        transformed += uJitter * 0.35 * vec3(sin(uTime * 2.1 + rid * 1.7), sin(uTime * 1.7 + rid * 2.3), cos(uTime * 1.9 + rid * 0.9));`,
      );
  };
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  const positions: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const entries: Array<{ p: THREE.Vector3; n: THREE.Vector3 }> = [];
  const d = new THREE.Vector3();

  // 1. Bound to rough-ER sheets (both cytosolic faces).
  let guard = 0;
  while (entries.length < 2500 && guard++ < 60000) {
    rng.direction(d);
    const layer = layout.erLayers[rng.int(0, layout.erLayers.length - 1)];
    if (!layout.erMaskAt(layer, d)) continue;
    const p = layerPoint(layout, layer, d);
    const n = d.clone().divide(layer.radii).normalize();
    const side = rng.chance(0.5) ? 1 : -1;
    entries.push({ p: p.addScaledVector(n, side * 0.055), n: n.multiplyScalar(side) });
  }
  // 2. On the outer nuclear membrane.
  for (let i = 0; i < 350; i++) {
    rng.direction(d);
    const n = d.clone().divide(layout.nucleusRadii).normalize();
    entries.push({ p: layout.nucleusCenter.clone().add(d.clone().multiply(layout.nucleusRadii)).addScaledVector(n, 0.05), n });
  }
  // 3. Polysomes: helical chains of free ribosomes.
  const polyCount = 120;
  guard = 0;
  let polysomes = 0;
  while (polysomes < polyCount && guard++ < 6000) {
    const c = rng.inBall().multiply(layout.cellRadii);
    if (!layout.inCytoplasm(c, 1.45, 0.9) || !layout.isFree(c, 0.25, 0)) continue;
    const axis = rng.direction();
    const a = new THREE.Vector3().crossVectors(axis, up).normalize();
    const b = new THREE.Vector3().crossVectors(axis, a).normalize();
    const nRibo = rng.int(6, 10);
    for (let k = 0; k < nRibo; k++) {
      const ang = k * 0.9;
      const p = c
        .clone()
        .addScaledVector(axis, (k - nRibo / 2) * 0.05)
        .addScaledVector(a, Math.cos(ang) * 0.1)
        .addScaledVector(b, Math.sin(ang) * 0.1);
      entries.push({ p, n: a.clone().multiplyScalar(Math.cos(ang)).addScaledVector(b, Math.sin(ang)) });
    }
    polysomes++;
  }
  // 4. Free ribosomes.
  guard = 0;
  while (entries.length < max && guard++ < 80000) {
    const p = rng.inBall().multiply(layout.cellRadii);
    if (!layout.inCytoplasm(p, 0.12, 0.93) || !layout.isFree(p, 0.04, 0)) continue;
    entries.push({ p, n: rng.direction() });
  }
  rng.shuffle(entries);
  entries.slice(0, max).forEach((entry, i) => {
    q.setFromUnitVectors(up, entry.n.normalize());
    m.compose(entry.p, q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    positions.push(entry.p.x, entry.p.y, entry.p.z);
  });
  const packed = new Float32Array(positions);
  const root = new THREE.Group();
  root.add(mesh);
  const cut = ctx.cuts.nucleus;
  const membraneCut = ctx.cuts.membrane;
  applyCutaway(material, cut, 0.001, 'ribosome-nucleus-cut');
  const hit = new THREE.Vector3();
  const counts = { low: 1500, medium: 3000, high: max };
  let count = max;
  const viewDir = erViewDirection(layout);
  const focusTarget = layerPoint(layout, layout.erLayers[1], viewDir).addScaledVector(viewDir, 0.35);

  return makeInstance('ribosomes', root, {
    focus: [standardFocus(material, { emissiveBase: 0.25, emissiveBoost: 0.55 })],
    raycast(ray) {
      let best: number | null = null;
      const c = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        c.set(packed[i * 3], packed[i * 3 + 1], packed[i * 3 + 2]);
        const t = raySphere(ray, c, 0.07);
        if (t === null || (best !== null && t >= best)) continue;
        ray.at(t, hit);
        if (insideCut(cut, hit) && hit.distanceTo(layout.nucleusCenter) < layout.nucleusRadii.x + 1.3) continue;
        if (insideCut(membraneCut, hit) && layout.relativeRadius(hit) > 1) continue;
        best = t;
      }
      return best;
    },
    framing() {
      return { target: focusTarget.clone(), radius: 0.9, direction: viewDir.clone() };
    },
    labelAnchors() {
      return [focusTarget.clone(), layerPoint(layout, layout.erLayers[0], viewDir).addScaledVector(viewDir, 0.2)];
    },
    update(_dt, _time, uctx) {
      jitter.value = uctx.calm ? 0 : 1;
    },
    setQuality(level) {
      count = counts[level];
      mesh.count = count;
      return count;
    },
  });
}

/**
 * Golgi apparatus: three linked stacks (a ribbon) around the centrosome. Each
 * stack has five curved cisternae with swollen rims, shaded from cis (toward
 * the nucleus) to trans (outward). A highlighted cargo particle follows the
 * secretory pathway: ER exit site → cis face → through the stack → trans-Golgi
 * network → secretory vesicle on a microtubule → fusion with the plasma membrane.
 */
export function buildGolgi(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('golgi-geometry');
  const root = new THREE.Group();
  const cis = new THREE.Color('#ffc46e');
  const trans = new THREE.Color('#ff7e29');
  const geometries: THREE.BufferGeometry[] = [];
  const cisternaCenters: THREE.Vector3[][] = [];
  const rims: THREE.Vector3[] = [];
  const c = new THREE.Color();

  layout.golgiStacks.forEach((stack) => {
    const centers: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const size = stack.size * (i === 0 || i === 4 ? 0.82 : 1) * rng.range(0.94, 1.06);
      const curvature = 1.3;
      const theta = Math.asin(Math.min(0.95, size / 2 / curvature));
      // Sphere centre behind the cisterna so the sac curves around the trans side.
      const offset = stack.normal.clone().multiplyScalar(i * 0.085);
      const center = stack.center.clone().add(offset);
      const sphereCenter = center.clone().addScaledVector(stack.normal, curvature);
      const patch = spherePatch({ center: sphereCenter, axis: stack.normal.clone().negate(), radius: curvature, thetaMax: theta, segments: 28 });
      c.copy(cis).lerp(trans, i / 4);
      const colors = new Float32Array(patch.attributes.position.count * 3);
      for (let k = 0; k < colors.length; k += 3) colors.set([c.r, c.g, c.b], k);
      patch.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometries.push(patch);
      // Swollen rim.
      const rimRadius = curvature * Math.sin(theta);
      const rim = new THREE.TorusGeometry(rimRadius, 0.032, 6, 40);
      const rimCenter = sphereCenter.clone().addScaledVector(stack.normal, -curvature * Math.cos(theta));
      rim.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), stack.normal));
      rim.translate(rimCenter.x, rimCenter.y, rimCenter.z);
      const rimColors = new Float32Array(rim.attributes.position.count * 3);
      for (let k = 0; k < rimColors.length; k += 3) rimColors.set([c.r, c.g, c.b], k);
      rim.setAttribute('color', new THREE.BufferAttribute(rimColors, 3));
      rim.deleteAttribute('uv');
      patch.deleteAttribute('uv');
      geometries.push(rim);
      centers.push(sphereCenter.clone().addScaledVector(stack.normal, -curvature));
      const tangent = new THREE.Vector3().crossVectors(stack.normal, stack.tangent).normalize();
      rims.push(rimCenter.clone().addScaledVector(tangent, rimRadius));
    }
    cisternaCenters.push(centers);
  });
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, side: THREE.DoubleSide, emissive: '#ff8a2a' });
  const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
  geometries.forEach((g) => g.dispose());
  root.add(mesh);

  // Vesicles gathered at the rims (budding/fusing).
  const vesicleCount = 48;
  const vesicleMaterial = new THREE.MeshStandardMaterial({ color: '#ffd59a', emissive: '#ffb066', roughness: 0.4 });
  const vesicles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 10, 8), vesicleMaterial, vesicleCount);
  const vesiclePositions: THREE.Vector3[] = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < vesicleCount; i++) {
    const stack = layout.golgiStacks[i % 3];
    const k = rng.int(0, 4);
    const around = new THREE.Vector3().crossVectors(stack.normal, rng.direction()).normalize();
    const p = stack.center
      .clone()
      .addScaledVector(stack.normal, k * 0.085 + rng.range(-0.05, 0.05))
      .addScaledVector(around, stack.size * 0.5 + rng.range(0.03, 0.15));
    vesiclePositions.push(p);
    vesicles.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
  }
  root.add(vesicles);

  // The secretory journey.
  const exit = erExitSite(layout);
  const middle = layout.golgiStacks[1];
  const middleCenters = cisternaCenters[1];
  const mtIndex = (() => {
    // A microtubule leaving near the trans face toward the cell edge.
    let best = 0;
    let bestScore = -Infinity;
    layout.microtubules.forEach((curve, i) => {
      const end = curve.getPointAt(1);
      const dir = end.clone().sub(layout.centrosome).normalize();
      const score = dir.dot(middle.normal) + (curve.getLength() > 4 ? 0.3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  })();
  const mt = layout.microtubules[mtIndex];
  const tgn = middle.center.clone().addScaledVector(middle.normal, 0.55);
  const cargoPath = smoothCurve([
    exit,
    exit.clone().lerp(middleCenters[0], 0.5).addScaledVector(middle.normal, -0.3),
    middleCenters[0].clone().addScaledVector(middle.normal, -0.12),
    middleCenters[0],
  ]);
  const cargo = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 12),
    new THREE.MeshStandardMaterial({ color: '#fff4c2', emissive: '#ffe08a', emissiveIntensity: 1.6, roughness: 0.3 }),
  );
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 12),
    new THREE.MeshBasicMaterial({ color: '#ffe8a8', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  root.add(cargo, flash);
  const journeyPeriod = 24;
  const cargoMaterial = cargo.material as THREE.MeshStandardMaterial;
  const flashMaterial = flash.material as THREE.MeshBasicMaterial;
  let emphasized = false;
  const p = new THREE.Vector3();

  return makeInstance('golgi', root, {
    focus: [
      standardFocus(material, { emissiveBase: 0.1, emissiveBoost: 0.4 }),
      standardFocus(vesicleMaterial, { emissiveBase: 0.25, emissiveBoost: 0.4 }),
    ],
    raycast(ray) {
      let best: number | null = null;
      for (const stack of layout.golgiStacks) {
        const t = raySphere(ray, stack.center.clone().addScaledVector(stack.normal, 0.17), stack.size * 0.55);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    },
    framing() {
      const up = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(middle.normal, up).normalize();
      const dir = side.multiplyScalar(0.75).addScaledVector(up, 0.35).addScaledVector(FRONT, 0.4).normalize();
      return { target: middle.center.clone().addScaledVector(middle.normal, 0.2), radius: 1.05, direction: dir };
    },
    labelAnchors() {
      return layout.golgiStacks.map((s) => s.center.clone().addScaledVector(s.normal, 0.17));
    },
    partAnchors() {
      return [
        { part: 'cis', position: middleCenters[0].clone() },
        { part: 'medial', position: middleCenters[2].clone() },
        { part: 'trans', position: middleCenters[4].clone() },
        { part: 'tgn', position: tgn.clone() },
        { part: 'secretory-vesicle', position: vesiclePositions[1].clone() },
      ];
    },
    update(_dt, time, uctx) {
      emphasized = uctx.selected === 'golgi' || uctx.selected === 'rough-er' || uctx.selected === 'vesicles-motors';
      const phase = (time % journeyPeriod) / journeyPeriod;
      // 0–0.15 ER → cis; 0.15–0.55 through the stack; 0.55–0.6 to TGN; 0.6–0.95 along a microtubule; 0.95–1 fusion.
      let fade = 1;
      if (phase < 0.15) {
        cargoPath.getPointAt(easeInOut(phase / 0.15), p);
      } else if (phase < 0.55) {
        const s = ((phase - 0.15) / 0.4) * 4;
        const k = Math.min(3, Math.floor(s));
        p.copy(middleCenters[k]).lerp(middleCenters[k + 1], easeInOut(s - k));
      } else if (phase < 0.6) {
        p.copy(middleCenters[4]).lerp(tgn, easeInOut((phase - 0.55) / 0.05));
      } else if (phase < 0.95) {
        const s = easeInOut((phase - 0.6) / 0.35);
        p.copy(tgn).lerp(mt.getPointAt(Math.min(1, 0.2 + s * 0.8)), Math.min(1, s * 4));
      } else {
        p.copy(mt.getPointAt(1));
        fade = 1 - (phase - 0.95) / 0.05;
      }
      cargo.position.copy(p);
      cargo.scale.setScalar((emphasized ? 1.25 : 0.8) * Math.max(0.05, fade));
      const fusion = phase > 0.94 ? Math.sin(((phase - 0.94) / 0.06) * Math.PI) : 0;
      flash.position.copy(mt.getPointAt(1));
      flashMaterial.opacity = fusion * (emphasized ? 0.8 : 0.4);
      flash.scale.setScalar(0.6 + fusion);
      cargoMaterial.emissiveIntensity = emphasized ? 2.2 : 1.2;
    },
  });
}

/**
 * Vesicles moving along microtubules: outward (plus ends, kinesin) and inward
 * (minus ends near the centrosome, dynein), with occasional pauses. They only
 * travel on the currently grown part of each microtubule.
 */
export function buildVesicles(ctx: BuildContext, mt: MtParams = mtParams(ctx.layout.microtubules.length)): StructureInstance {
  const { layout } = ctx;
  const rng = rngFor('vesicles');
  const max = 200;
  const color = colorOf('vesicles-motors');
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, roughness: 0.35 });
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 12, 10), material, max);
  const curves = layout.microtubules;
  type Rider = { curve: number; s: number; outward: boolean; speed: number; pause: number };
  const riders: Rider[] = [];
  const assign = (rider: Partial<Rider> = {}): Rider => {
    const outward = rng.chance(0.6);
    const curve = rng.int(0, curves.length - 1);
    return {
      curve,
      outward,
      s: outward ? rng.range(0.05, 0.3) : rng.range(0.6, 0.95),
      speed: rng.range(0.5, 0.9),
      pause: 0,
      ...rider,
    };
  };
  for (let i = 0; i < max; i++) {
    const r = assign();
    r.s = rng.range(0.05, 0.95);
    riders.push(r);
  }
  const outwardColor = new THREE.Color(color);
  const inwardColor = new THREE.Color('#e48cff');
  riders.forEach((r, i) => mesh.setColorAt(i, r.outward ? outwardColor : inwardColor));
  mesh.instanceColor!.needsUpdate = true;
  const positions = new Float32Array(max * 3);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const counts = { low: 60, medium: 120, high: max };
  let count = max;
  const root = new THREE.Group();
  root.add(mesh);
  const place = (time: number) => {
    for (let i = 0; i < count; i++) {
      const r = riders[i];
      const length = mtLength(mt, r.curve, time);
      const s = Math.min(r.s, length);
      curves[r.curve].getPointAt(s, p);
      // Ride slightly off the microtubule axis (the motor's stalk).
      offset.set(Math.sin(i * 1.3), Math.cos(i * 2.1), Math.sin(i * 0.7)).normalize().multiplyScalar(0.07);
      p.add(offset);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  place(0);
  const golgi = layout.golgiStacks[1];
  const target = golgi.center.clone().addScaledVector(golgi.normal, 1.5);

  return makeInstance('vesicles-motors', root, {
    focus: [standardFocus(material, { emissiveBase: 0.35, emissiveBoost: 0.5 })],
    raycast(ray) {
      return rayPoints(ray, positions, count, 0.11);
    },
    framing() {
      return { target: target.clone(), radius: 1.7, direction: golgi.normal.clone().add(new THREE.Vector3(0, 0.3, 0.6)).normalize() };
    },
    labelAnchors() {
      const out: THREE.Vector3[] = [];
      for (let i = 0; i < Math.min(count, 12); i++) out.push(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
      return out.sort((a, b) => a.distanceTo(target) - b.distanceTo(target));
    },
    partAnchors() {
      let nearest = 0;
      let best = Infinity;
      for (let i = 0; i < count; i++) {
        const d = Math.hypot(positions[i * 3] - target.x, positions[i * 3 + 1] - target.y, positions[i * 3 + 2] - target.z);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      const r = riders[nearest];
      const curve = curves[r.curve];
      return [
        { part: 'vesicle', position: new THREE.Vector3(positions[nearest * 3], positions[nearest * 3 + 1], positions[nearest * 3 + 2]) },
        { part: 'track', position: curve.getPointAt(Math.max(0.1, Math.min(r.s, 0.9) - 0.12)) },
      ];
    },
    update(dt, time) {
      if (dt > 0) {
        for (let i = 0; i < count; i++) {
          const r = riders[i];
          if (r.pause > 0) {
            r.pause -= dt;
            continue;
          }
          const length = mtLength(mt, r.curve, time);
          const ds = (r.speed * dt) / curves[r.curve].getLength();
          r.s += r.outward ? ds : -ds;
          if (rng.chance(dt * 0.15)) r.pause = rng.range(0.4, 1.5);
          if ((r.outward && r.s >= Math.min(0.97, length)) || (!r.outward && r.s <= 0.04)) {
            riders[i] = assign();
            mesh.setColorAt(i, riders[i].outward ? outwardColor : inwardColor);
            mesh.instanceColor!.needsUpdate = true;
          }
        }
      }
      place(time);
    },
    setQuality(level) {
      count = counts[level];
      mesh.count = count;
      return count;
    },
  });
}
