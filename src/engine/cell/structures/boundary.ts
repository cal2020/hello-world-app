import * as THREE from 'three';
import { applyCutaway, applyFresnel, insideCut, pointsFocus, standardFocus } from '../../core/materials';
import { noisyEllipsoid, rayEllipsoid } from '../../core/geometry';
import { rngFor } from '../../core/random';
import { colorOf, makeInstance, softDotTexture } from '../common';
import type { BuildContext, StructureInstance } from '../types';

/**
 * Plasma membrane: a closed, gently irregular shell drawn as two surfaces
 * 80 nm apart (outer front faces, inner back faces), so the cut edge reads as
 * a membrane with thickness (about ten times thicker than reality). Small
 * bumps stand for surface proteins and the sugar coat; they drift slowly,
 * suggesting the fluid bilayer.
 */
export function buildPlasmaMembrane(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const cut = ctx.cuts.membrane;
  const root = new THREE.Group();
  const color = colorOf('plasma-membrane');

  const outerGeometry = noisyEllipsoid(layout.cellRadii, 5, layout.cellNoise, layout.cellNoiseAmplitude, layout.cellNoiseFrequency);
  const innerGeometry = outerGeometry.clone();
  innerGeometry.scale(1 - 0.08 / 6.6, 1 - 0.08 / 6.6, 1 - 0.08 / 6.6);

  const inner = new THREE.MeshStandardMaterial({
    color: '#1f2c5e',
    emissive: '#101a40',
    roughness: 0.7,
    metalness: 0,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  applyCutaway(inner, cut, 0.025, 'membrane-inner');

  const outer = new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.55),
    emissive: '#1b2b66',
    roughness: 0.35,
    metalness: 0,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });
  applyFresnel(outer, '#a9c4ff', 2.4, 0.85, 'membrane-fresnel');
  applyCutaway(outer, cut, 0.03, 'membrane-outer');

  const innerMesh = new THREE.Mesh(innerGeometry, inner);
  innerMesh.renderOrder = -2;
  const outerMesh = new THREE.Mesh(outerGeometry, outer);
  outerMesh.renderOrder = 5;
  root.add(innerMesh, outerMesh);

  // Surface proteins / glycocalyx tufts.
  const rng = rngFor('membrane-bumps');
  const bumpCount = 900;
  const bumpGeometry = new THREE.IcosahedronGeometry(0.05, 1);
  const bumpMaterial = new THREE.MeshStandardMaterial({ color: '#c8d6ff', emissive: '#4a63b5', roughness: 0.5, transparent: true });
  applyCutaway(bumpMaterial, cut, 0.02, 'membrane-bumps');
  const bumps = new THREE.InstancedMesh(bumpGeometry, bumpMaterial, bumpCount);
  const bumpDirs: THREE.Vector3[] = [];
  const bumpScale: number[] = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < bumpCount; i++) {
    const d = rng.direction();
    bumpDirs.push(d.clone());
    bumpScale.push(rng.range(0.6, 1.4));
  }
  const placeBumps = () => {
    for (let i = 0; i < bumpCount; i++) {
      const p = layout.membranePoint(bumpDirs[i], 1.004);
      m.makeScale(bumpScale[i], bumpScale[i], bumpScale[i]).setPosition(p);
      bumps.setMatrixAt(i, m);
    }
    bumps.instanceMatrix.needsUpdate = true;
  };
  placeBumps();
  bumps.renderOrder = 6;
  root.add(bumps);

  const focus = [
    standardFocus(outer, { baseOpacity: 0.34, alwaysTransparent: true, emissiveBase: 0.45, emissiveBoost: 0.5, depthWriteAbove: 2 }),
    standardFocus(inner, { baseOpacity: 0.55, alwaysTransparent: true, emissiveBase: 0.5, emissiveBoost: 0.3, depthWriteAbove: 2 }),
    standardFocus(bumpMaterial, { baseOpacity: 0.85, emissiveBase: 0.25, emissiveBoost: 0.6 }),
  ];

  const center = layout.cellCenter;
  const radii = layout.cellRadii.clone().multiplyScalar(1.01);
  const hitPoint = new THREE.Vector3();
  const drift = rngFor('membrane-drift');
  let driftClock = 0;

  return makeInstance('plasma-membrane', root, {
    focus,
    overviewOpacity: 1,
    raycast(ray) {
      const hit = rayEllipsoid(ray, center, radii);
      if (!hit) return null;
      const [t0, t1] = hit;
      if (t0 >= 0) {
        ray.at(t0, hitPoint);
        return insideCut(cut, hitPoint) ? null : t0;
      }
      if (t1 >= 0) {
        ray.at(t1, hitPoint);
        return insideCut(cut, hitPoint) ? null : t1;
      }
      return null;
    },
    framing() {
      return { target: center.clone(), radius: 7.4, direction: new THREE.Vector3(0.55, 0.35, 0.76).normalize() };
    },
    labelAnchors() {
      // Points on the rim of the cut opening, preferring the upper edge.
      const dir = cut.uCutDir.value.clone();
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(side, dir).normalize();
      const angle = Math.acos(Math.min(1, cut.uCutCos.value)) + 0.18;
      const candidates: THREE.Vector3[] = [];
      for (const a of [0, 0.7, -0.7, 1.4, -1.4]) {
        const tangent = up.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
        const d = dir.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangent, Math.sin(angle)).normalize();
        candidates.push(layout.membranePoint(d, 1));
      }
      return candidates;
    },
    partAnchors() {
      const dir = cut.uCutDir.value.clone();
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(side, dir).normalize();
      const angle = Math.acos(Math.min(1, cut.uCutCos.value)) + 0.03;
      const rim = dir.clone().multiplyScalar(Math.cos(angle)).addScaledVector(up, Math.sin(angle)).normalize();
      const outerDir = dir.clone().multiplyScalar(Math.cos(angle + 0.5)).addScaledVector(side, Math.sin(angle + 0.5)).normalize();
      return [
        { part: 'bilayer', position: layout.membranePoint(rim, 0.996) },
        { part: 'glycocalyx', position: layout.membranePoint(outerDir, 1.01) },
      ];
    },
    update(dt, _time, uctx) {
      if (dt <= 0 || uctx.calm) return;
      driftClock += dt;
      if (driftClock < 0.1) return;
      // Lateral diffusion of surface proteins (illustrative, slowed down).
      const step = driftClock * 0.004;
      driftClock = 0;
      for (let i = 0; i < bumpCount; i++) {
        const d = bumpDirs[i];
        d.x += drift.range(-step, step);
        d.y += drift.range(-step, step);
        d.z += drift.range(-step, step);
        d.normalize();
      }
      placeBumps();
    },
  });
}

/**
 * Cytoplasm: faint particles fill the space between organelles as a visual
 * cue for the crowded cytosol (they are not individual molecules). They
 * jitter slightly, suggesting constant molecular motion.
 */
export function buildCytoplasm(ctx: BuildContext): StructureInstance {
  const { layout } = ctx;
  const cut = ctx.cuts.membrane;
  const rng = rngFor('cytoplasm');
  const max = 7000;
  const positions = new Float32Array(max * 3);
  const seeds = new Float32Array(max);
  let n = 0;
  let attempts = 0;
  const p = new THREE.Vector3();
  while (n < max && attempts < max * 20) {
    attempts++;
    rng.inBall(p).multiply(layout.cellRadii);
    if (!layout.inCytoplasm(p, 0.15, 0.95)) continue;
    positions.set([p.x, p.y, p.z], n * 3);
    seeds[n] = rng.next();
    n++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const color = colorOf('cytoplasm');
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: ctx.time,
      uOpacity: { value: 1 },
      uEmphasis: { value: 0 },
      uColor: { value: color.clone().lerp(new THREE.Color('#ffffff'), 0.25) },
      uSize: { value: 0.07 },
      uScale: ctx.pointScale,
      uMap: { value: softDotTexture() },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uSize;
      uniform float uScale;
      uniform float uEmphasis;
      varying float vSeed;
      void main() {
        vec3 p = position;
        float s = aSeed * 6.2831;
        p += 0.07 * vec3(sin(uTime * 0.9 + s * 3.1), sin(uTime * 0.7 + s * 5.3), cos(uTime * 0.8 + s * 7.7));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (1.0 + uEmphasis * 0.6) * uScale / max(0.1, -mv.z);
        vSeed = aSeed;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uEmphasis;
      uniform sampler2D uMap;
      varying float vSeed;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(uColor * (0.6 + 0.4 * vSeed + uEmphasis * 0.4), a * uOpacity * (0.32 + uEmphasis * 0.25));
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  const root = new THREE.Group();
  root.add(points);

  const counts = { low: 2600, medium: 4600, high: n };
  const center = layout.cellCenter;
  const radii = layout.cellRadii;
  const hitPoint = new THREE.Vector3();

  return makeInstance('cytoplasm', root, {
    focus: [pointsFocus(material, 1)],
    overviewOpacity: 1,
    raycast(ray) {
      // Open space seen through the cut opening (or from inside) is cytoplasm.
      const hit = rayEllipsoid(ray, center, radii);
      if (!hit) return null;
      const [t0, t1] = hit;
      if (t1 < 0) return null;
      if (t0 >= 0) {
        ray.at(t0, hitPoint);
        if (!insideCut(cut, hitPoint)) return null;
      }
      return t1 * 0.995;
    },
    framing() {
      const dir = new THREE.Vector3(0.2, -0.45, 0.87).normalize();
      return { target: layout.membranePoint(dir, 0.62), radius: 2.6, direction: dir };
    },
    labelAnchors() {
      const dir = cut.uCutDir.value.clone();
      const down = new THREE.Vector3(0, -1, 0);
      return [0.55, 0.45, 0.65].map((s) => layout.membranePoint(dir.clone().addScaledVector(down, 0.45).normalize(), s));
    },
    partAnchors() {
      const dir = new THREE.Vector3(0.25, -0.35, 0.9).normalize();
      return [{ part: 'cytosol', position: layout.membranePoint(dir, 0.6) }];
    },
    setQuality(level) {
      geometry.setDrawRange(0, counts[level]);
      return null;
    },
  });
}
