import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { mergeGeometries } from '../core/geometry';
import { Rng } from '../core/random';
import { blobGeometry } from './common';
import { addInstanceGlow, bilayerStripGeometry, byQuality, instancedMaterial, lipidBilayer, moleculeMaterial, sparks, type JiggleUniforms } from './kit';
import { compositeBlob, wander } from './energyParts';
import type { CloseupLabel } from './types';

/**
 * A patch of crista membrane at true scale (1 unit = 1 nm). The crista lumen
 * (continuous with the intermembrane space) is above (+y), the matrix below.
 * Complexes I, III and IV pump protons upward; protons flow back down
 * through the F_O c-ring of ATP synthase, turning the rotor, and every third
 * of a turn the F1 head releases one ATP into the matrix.
 *
 * Timing (slowdown ×100): one rotor turn per 1.2 s (≈ 12 ms in a cell) with
 * 8 protons per turn (8 c-subunits) and 3 ATP per turn; the pumps deliver
 * 4 + 2 + 2 = 8 protons per turn.
 */

const PATCH_X = 36; // half-width (72 nm)
const PATCH_BACK = -44; // the patch runs from z = −44 to the cut edge at z = 0 (44 nm deep)
const STRIP = 4.5; // the front 4.5 nm are drawn as individual lipids
const SLAB = 2.2; // half-thickness (head group to head group ≈ 4.4 nm)
const TURN = 1.2; // seconds per rotor turn (≈ 12 ms × 100)
const C_SUBUNITS = 8;
const ATP_PER_TURN = 3;
const RING_X = 19.5;
const RING_R = 3.3; // where a bound proton sits (outer face of the c-ring)
const F1_Y = -11.3;
const F1_R = 2.75;
const PROTEIN_Z = 0.4;

const COLORS = {
  ci: '#9d7bff',
  ciii: '#8a6cf2',
  civ: '#b39cff',
  rotor: '#ffdb7a',
  stator: '#d99a2b',
  alpha: '#ffc23d',
  beta: '#f2a332',
  proton: '#ff4d4d',
  atp: '#6ee77a',
  head: '#f6e3cf',
  headDark: '#c9a27a',
};

export interface SynthaseView {
  group: THREE.Group;
  labels: CloseupLabel[];
  update(time: number, calm: boolean): void;
  dispose(): void;
}

/** Lipid head groups painted on the slab faces (hexagonal pattern, 0.9 nm spacing). */
function headPatternMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: COLORS.head, emissive: COLORS.head, emissiveIntensity: 0.1, roughness: 0.7 });
  const dark = new THREE.Color(COLORS.headDark);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGapColor = { value: dark };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeadPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeadPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeadPos;\nuniform vec3 uGapColor;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{ vec2 q = vHeadPos.xz / 0.9;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(q, r) - h;
  vec2 b = mod(q - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  float k = fract(sin(dot(floor(q * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
  float bead = smoothstep(0.56, 0.18, length(g));
  bead = mix(bead, 0.62, smoothstep(0.1, 0.32, length(fwidth(q))));
  diffuseColor.rgb = mix(uGapColor, diffuseColor.rgb * (0.94 + 0.1 * k), bead); }`,
      );
  };
  material.customProgramCacheKey = () => 'mitoHeads';
  return material;
}

function atpGeometry(): THREE.BufferGeometry {
  const adenosine = blobGeometry(1, 'atp-adenosine', 0.18, 1);
  adenosine.scale(0.5, 0.38, 0.32);
  const parts: THREE.BufferGeometry[] = [adenosine];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.IcosahedronGeometry(0.21, 1);
    p.translate(0.62 + i * 0.36, 0.06 * (i % 2 === 0 ? 1 : -1), 0.04 * i);
    parts.push(p);
  }
  for (const g of parts) if (g.attributes.uv) g.deleteAttribute('uv');
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  parts.forEach((g) => g.dispose());
  merged.translate(-0.4, 0, 0);
  return merged;
}

export function buildSynthaseView(quality: QualityLevel, jiggle: JiggleUniforms, pointScale: { value: number }): SynthaseView {
  const rng = new Rng('closeup:mitochondria:synthase');
  const group = new THREE.Group();
  const detail = quality === 'low' ? 2 : 3;
  const disposables: { dispose(): void }[] = [];

  // ── Membrane patch: individual lipids along the cut edge, a smooth slab (painted head groups) behind ──
  const width = PATCH_X * 2;
  const depth = -PATCH_BACK - STRIP;
  const slabCenterZ = (PATCH_BACK - STRIP) / 2;
  const top = new THREE.PlaneGeometry(width, depth, 1, 1);
  top.rotateX(-Math.PI / 2);
  top.translate(0, SLAB, slabCenterZ);
  const bottom = new THREE.PlaneGeometry(width, depth, 1, 1);
  bottom.rotateX(Math.PI / 2);
  bottom.translate(0, -SLAB, slabCenterZ);
  const faces = mergeGeometries([top, bottom])!;
  top.dispose();
  bottom.dispose();
  const slab = new THREE.Mesh(faces, headPatternMaterial());
  const edges: THREE.BufferGeometry[] = [];
  const front = bilayerStripGeometry(width, SLAB * 2);
  front.translate(0, 0, -STRIP);
  edges.push(front);
  const back = bilayerStripGeometry(width, SLAB * 2);
  back.rotateY(Math.PI);
  back.translate(0, 0, PATCH_BACK);
  edges.push(back);
  for (const sx of [-1, 1]) {
    const side = bilayerStripGeometry(-PATCH_BACK, SLAB * 2);
    side.rotateY((sx * Math.PI) / 2);
    side.translate(sx * PATCH_X, 0, PATCH_BACK / 2);
    edges.push(side);
  }
  const edgeGeometry = mergeGeometries(edges)!;
  edges.forEach((g) => g.dispose());
  const edgeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: '#3a2a14', side: THREE.DoubleSide });
  const edgeMesh = new THREE.Mesh(edgeGeometry, edgeMaterial);
  // Where the membrane domains of the proteins sit, lipids are left out (world x range, z beyond which they begin).
  const footprints = [
    { x0: -35.8, x1: -14.4, z0: -2.7 },
    { x0: -12.0, x1: 1.0, z0: -2.7 },
    { x0: 1.7, x1: 11.3, z0: -2.7 },
    { x0: 15.8, x1: 26.5, z0: -3.1 },
  ];
  const lipids = lipidBilayer({
    width,
    depth: STRIP,
    seed: 'closeup:mitochondria:lipids',
    quality,
    jiggle,
    headColor: COLORS.head,
    exclude: (x, z) => footprints.some((f) => x > f.x0 && x < f.x1 && z - STRIP / 2 > f.z0),
  });
  lipids.group.position.z = -STRIP / 2;
  disposables.push(lipids);
  group.add(slab, edgeMesh, lipids.group);

  // ── Electron transport chain: complexes I, III and IV (purple) ──
  type Lump = [number, number, number, number];
  const lumps = (seed: string, list: Lump[]): THREE.BufferGeometry =>
    compositeBlob(
      list.map(([x, y, z, r], i) => {
        const k = new Rng(`${seed}:${i}`);
        return {
          center: new THREE.Vector3(x, y, z),
          scale: new THREE.Vector3(r * k.range(0.9, 1.1), r * k.range(0.9, 1.1), r * k.range(0.9, 1.1)),
          seed: `${seed}:${i}`,
          roughness: 0.24,
        };
      }),
      detail,
    );
  // Complex I: an L — membrane arm (~19 nm) plus a peripheral arm reaching ~20 nm down into the matrix.
  const complexI = new THREE.Mesh(
    lumps('ci', [
      [-8.2, 0.3, 0.4, 2.2],
      [-6.0, -0.4, -0.5, 2.4],
      [-3.6, 0.5, 0.5, 2.5],
      [-1.2, -0.3, -0.4, 2.5],
      [1.2, 0.4, 0.5, 2.5],
      [3.6, -0.3, -0.4, 2.5],
      [5.9, 0.2, 0.3, 2.5],
      [7.8, -0.6, -0.3, 2.4],
      [-4.8, 1.2, -1.2, 1.4],
      [2.4, -1.4, 1.3, 1.5],
      [-7.2, -1.2, 1.1, 1.3],
      [7.4, -3.6, 0.2, 2.6],
      [8.0, -6.3, -0.6, 2.9],
      [8.3, -9.2, 0.5, 3.1],
      [8.9, -12.2, -0.4, 3.2],
      [9.3, -15.1, 0.4, 3.0],
      [9.6, -17.6, -0.2, 2.5],
      [6.2, -10.5, 1.8, 1.8],
      [11.2, -13.5, -1.2, 1.9],
      [7.4, -16.2, -1.6, 1.8],
      [10.9, -8.0, 1.4, 1.7],
    ]),
    moleculeMaterial(COLORS.ci, { emissiveIntensity: 0.2, roughness: 0.5 }),
  );
  complexI.position.set(-25, 0, PROTEIN_Z);
  // Complex III: a dimer protruding into the matrix (core proteins) and into the crista lumen (cytochrome c1, Rieske protein).
  const ciii: Lump[] = [];
  for (const m of [-1, 1]) {
    ciii.push(
      [m * 2.4, 0.3, 0.6, 2.2],
      [m * 3.6, -0.4, -1.0, 2.0],
      [m * 1.2, -0.2, -1.2, 1.8],
      [m * 2.0, -5.2, 0.8, 2.6],
      [m * 3.8, -6.2, -0.8, 2.5],
      [m * 1.8, -7.6, -1.0, 2.2],
      [m * 3.2, -3.4, 1.5, 1.8],
      [m * 2.6, 3.6, 0.4, 1.7],
      [m * 1.4, 4.2, -0.9, 1.4],
    );
  }
  const complexIII = new THREE.Mesh(lumps('ciii', ciii), moleculeMaterial(COLORS.ciii, { emissiveIntensity: 0.2, roughness: 0.5 }));
  complexIII.position.set(-5.5, 0, PROTEIN_Z);
  // Complex IV.
  const complexIV = new THREE.Mesh(
    lumps('civ', [
      [0, 0.2, 0, 2.6],
      [-2.2, -0.3, 0.8, 2.0],
      [2.1, 0.2, -0.7, 2.1],
      [0.4, -0.5, -1.8, 1.8],
      [0.3, -3.5, 0.5, 2.0],
      [-1.4, -3.2, -0.9, 1.6],
      [0.6, 3.7, 0.6, 2.2],
      [-1.6, 3.2, -0.5, 1.6],
    ]),
    moleculeMaterial(COLORS.civ, { emissiveIntensity: 0.2, roughness: 0.5 }),
  );
  complexIV.position.set(6.5, 0, PROTEIN_Z);
  group.add(complexI, complexIII, complexIV);

  // ── ATP synthase (gold) ──
  const synthase = new THREE.Group();
  synthase.position.set(RING_X, 0, PROTEIN_Z);
  group.add(synthase);
  // Rotor: c-ring of 8 hairpins + central stalk (γ, with the δ/ε foot that makes its turning visible).
  const rotorParts: THREE.BufferGeometry[] = [];
  const capsuleRadial = quality === 'low' ? 6 : 8;
  for (let j = 0; j < C_SUBUNITS; j++) {
    const a = (j / C_SUBUNITS) * Math.PI * 2;
    const innerHelix = new THREE.CapsuleGeometry(0.46, 4.6, 2, capsuleRadial);
    innerHelix.translate(Math.cos(a) * 1.5, -0.2, -Math.sin(a) * 1.5);
    const outerHelix = new THREE.CapsuleGeometry(0.5, 5.2, 2, capsuleRadial);
    outerHelix.translate(Math.cos(a + 0.12) * 2.68, 0, -Math.sin(a + 0.12) * 2.68);
    const loop = new THREE.IcosahedronGeometry(0.62, 1);
    loop.translate(Math.cos(a + 0.06) * 2.1, -3.15, -Math.sin(a + 0.06) * 2.1);
    rotorParts.push(innerHelix, outerHelix, loop);
  }
  const gamma = new THREE.CapsuleGeometry(0.95, 11.5, 3, capsuleRadial + 2);
  gamma.rotateZ(0.05);
  gamma.translate(0.25, -9.0, 0);
  rotorParts.push(gamma);
  const foot = compositeBlob(
    [
      { center: new THREE.Vector3(1.5, -4.4, 0.4), scale: new THREE.Vector3(1.8, 1.25, 1.5), seed: 'eps:0' },
      { center: new THREE.Vector3(-0.8, -3.9, -0.5), scale: new THREE.Vector3(1.25, 1.0, 1.25), seed: 'eps:1' },
    ],
    detail,
  );
  rotorParts.push(foot);
  for (const g of rotorParts) if (g.attributes.uv) g.deleteAttribute('uv');
  const rotorGeometry = mergeGeometries(rotorParts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  rotorParts.forEach((g) => g.dispose());
  const rotor = new THREE.Mesh(rotorGeometry, moleculeMaterial(COLORS.rotor, { emissiveIntensity: 0.22, roughness: 0.42 }));
  synthase.add(rotor);
  // Stator: subunit a beside the ring, the peripheral stalk and OSCP holding the F1 head.
  const statorParts: THREE.BufferGeometry[] = [
    compositeBlob(
      [
        { center: new THREE.Vector3(4.6, 0.1, 0.2), scale: new THREE.Vector3(1.6, 2.6, 2.4), seed: 'sub-a:0' },
        { center: new THREE.Vector3(5.6, -0.4, -1.6), scale: new THREE.Vector3(1.2, 2.3, 1.3), seed: 'sub-a:1' },
        { center: new THREE.Vector3(1.4, -17.1, 0), scale: new THREE.Vector3(2.1, 1.35, 2.0), seed: 'oscp' },
      ],
      detail,
    ),
  ];
  const stalkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(5.0, -1.2, 0.3),
    new THREE.Vector3(5.9, -4.8, 0.5),
    new THREE.Vector3(6.4, -9.0, 0.5),
    new THREE.Vector3(6.1, -13.2, 0.4),
    new THREE.Vector3(4.6, -16.4, 0.2),
    new THREE.Vector3(2.6, -17.4, 0.1),
  ]);
  statorParts.push(new THREE.TubeGeometry(stalkCurve, 32, 0.62, capsuleRadial, false));
  const statorGeometry = mergeGeometries(
    statorParts.map((g) => {
      if (g.attributes.uv) g.deleteAttribute('uv');
      return g.index ? g.toNonIndexed() : g;
    }),
  )!;
  statorParts.forEach((g) => g.dispose());
  synthase.add(new THREE.Mesh(statorGeometry, moleculeMaterial(COLORS.stator, { emissiveIntensity: 0.18, roughness: 0.5 })));
  // F1 head: three α and three β subunits alternating around the γ subunit, hanging into the matrix.
  // Each subunit: C-terminal domain (near the stalk), nucleotide-binding domain, N-terminal barrel (distal).
  const subunitShape = (seed: string) =>
    lumps(seed, [
      [-0.35, 2.7, 0, 1.7],
      [0.15, 0.1, 0, 2.3],
      [0.0, -2.8, 0, 1.85],
    ]);
  const alphaGeometry = subunitShape('f1-alpha');
  const betaGeometry = subunitShape('f1-beta');
  const alphaMaterial = moleculeMaterial(COLORS.alpha, { emissiveIntensity: 0.2, roughness: 0.45 });
  const betaMaterial = moleculeMaterial(COLORS.beta, { emissiveIntensity: 0.2, roughness: 0.45 });
  const betas: { mesh: THREE.Mesh; angle: number; home: THREE.Vector3 }[] = [];
  for (let k = 0; k < 6; k++) {
    const angle = THREE.MathUtils.degToRad(30 + k * 60);
    const isBeta = k % 2 === 0;
    const mesh = new THREE.Mesh(isBeta ? betaGeometry : alphaGeometry, isBeta ? betaMaterial : alphaMaterial);
    const home = new THREE.Vector3(Math.cos(angle) * F1_R, F1_Y, -Math.sin(angle) * F1_R);
    mesh.position.copy(home);
    mesh.rotation.set(0, angle, 0);
    synthase.add(mesh);
    if (isBeta) betas.push({ mesh, angle, home });
  }
  // Release order follows the rotor (clockwise seen from the membrane): 270° → 150° → 30°.
  betas.sort((a, b) => b.angle - a.angle);

  // ── ATP molecules (green): released every third of a turn, drifting into the matrix ──
  const atpSlots = 12;
  const atpShape = atpGeometry();
  const atpMaterial = instancedMaterial({ roughness: 0.4 });
  addInstanceGlow(atpMaterial, 0.35, 'atpGlow');
  const atpMesh = new THREE.InstancedMesh(atpShape, atpMaterial, atpSlots);
  atpMesh.frustumCulled = false;
  const atpColor = new THREE.Color(COLORS.atp);
  for (let i = 0; i < atpSlots; i++) atpMesh.setColorAt(i, atpColor);
  group.add(atpMesh);
  disposables.push(atpShape);
  const atpPositions = Array.from({ length: atpSlots }, () => new THREE.Vector3());

  // ── Protons (red sparks) ──
  const cloudCount = byQuality(quality, { low: 110, medium: 140, high: 170 });
  const belowCount = byQuality(quality, { low: 14, medium: 16, high: 20 });
  const pumpSites: { x: number; y0: number; y1: number; phase: number }[] = [];
  [-7.2, -3.4, 0.4, 4.0].forEach((x, i) => pumpSites.push({ x: complexI.position.x + x, y0: -5.2, y1: 4.2, phase: 0.0 + i * 0.06 }));
  [-2.4, 2.4].forEach((x, i) => pumpSites.push({ x: complexIII.position.x + x, y0: -9.8, y1: 6.2, phase: 0.4 + i * 0.08 }));
  [-1.0, 1.2].forEach((x, i) => pumpSites.push({ x: complexIV.position.x + x, y0: -6.8, y1: 6.2, phase: 0.8 + i * 0.08 }));
  const pumpSlots = pumpSites.length * 2;
  const flowSlots = C_SUBUNITS * 2;
  // Free protons (cloud above, a few below) and the ones being moved right now (brighter, a little larger glow).
  const protons = sparks(cloudCount + belowCount, COLORS.proton, 1.45, pointScale);
  const moving = sparks(pumpSlots + flowSlots, '#ff5a4a', 1.9, pointScale);
  group.add(protons.points, moving.points);
  disposables.push(protons, moving);
  const homes: THREE.Vector3[] = [];
  for (let i = 0; i < cloudCount; i++) {
    const u = rng.next();
    homes.push(new THREE.Vector3(rng.range(-PATCH_X + 1, PATCH_X - 1), SLAB + 1.2 + u * u * 16, rng.range(-26, 8)));
  }
  for (let i = 0; i < belowCount; i++) {
    homes.push(new THREE.Vector3(rng.range(-PATCH_X + 1, PATCH_X - 1), -SLAB - 2.5 - rng.next() * 17, rng.range(-24, 6)));
  }
  // The cloud spark nearest this point carries the "Protons" label.
  const protonLabelHome = new THREE.Vector3(-1, 9.5, 1);
  let protonLabelIndex = 0;
  homes.slice(0, cloudCount).forEach((h, i) => {
    if (h.distanceToSquared(protonLabelHome) < homes[protonLabelIndex].distanceToSquared(protonLabelHome)) protonLabelIndex = i;
  });
  const drift = Array.from({ length: pumpSlots }, () => new THREE.Vector3(rng.range(-4, 4), rng.range(4, 9), rng.range(-6, 3)));

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Vector3(0, 0, 0);
  let latestShowcaseVisible = false;
  const showcaseSlot = 1; // released by the β subunit at 150°, drifts to the left into open matrix

  const setSpark = (i: number, p: THREE.Vector3, alpha: number) => {
    protons.positions[i * 3] = p.x;
    protons.positions[i * 3 + 1] = p.y;
    protons.positions[i * 3 + 2] = p.z;
    protons.alphas[i] = alpha;
  };
  const setMoving = (i: number, p: THREE.Vector3, alpha: number) => {
    moving.positions[i * 3] = p.x;
    moving.positions[i * 3 + 1] = p.y;
    moving.positions[i * 3 + 2] = p.z;
    moving.alphas[i] = alpha;
  };

  const etcAnchor = new THREE.Vector3();
  const protonAnchor = new THREE.Vector3();
  const synthaseAnchor = new THREE.Vector3(RING_X + 4.2, F1_Y - 1.0, PROTEIN_Z + 2.4);
  const lumenAnchor = new THREE.Vector3(-22, 15, -12);
  const matrixAnchor = new THREE.Vector3(-2, -16, 1);
  const membraneAnchor = new THREE.Vector3(-27, SLAB, -26);
  const labels: CloseupLabel[] = [
    { part: 'etc', anchor: () => etcAnchor.set(complexIII.position.x - 2.2, 5.3, complexIII.position.z + 1.2) },
    { part: 'atp-synthase', anchor: () => synthaseAnchor },
    {
      part: 'protons',
      anchor: () => protonAnchor.set(protons.positions[protonLabelIndex * 3], protons.positions[protonLabelIndex * 3 + 1], protons.positions[protonLabelIndex * 3 + 2]),
    },
    { textKey: 'closeupCaptions.cristaSpace', anchor: () => lumenAnchor },
    { part: 'matrix', anchor: () => matrixAnchor },
    { textKey: 'closeupCaptions.atp', anchor: () => atpPositions[showcaseSlot], visible: () => latestShowcaseVisible },
    { part: 'inner-membrane', anchor: () => membraneAnchor },
  ];

  const thermal = { amount: 1 };
  const proteins = [complexI, complexIII, complexIV];
  const proteinHomes = proteins.map((p) => p.position.clone());

  return {
    group,
    labels,
    update(time, calm) {
      thermal.amount = calm ? 0.35 : 1;
      const turn = time / TURN;
      const rotorAngle = -turn * Math.PI * 2;
      rotor.rotation.y = rotorAngle;
      // Gentle thermal wobble of the complexes (they stay in the membrane).
      for (let i = 0; i < proteins.length; i++) {
        wander(i * 3.7 + 1, time * 0.8, 0.12 * thermal.amount, tmp);
        proteins[i].position.set(proteinHomes[i].x + tmp.x, proteinHomes[i].y + tmp.y * 0.4, proteinHomes[i].z + tmp.z * 0.5);
      }

      // Cloud and matrix protons wander.
      for (let i = 0; i < cloudCount + belowCount; i++) {
        wander(i + 0.5, time * (calm ? 0.25 : 0.55), 1.6 * thermal.amount + 0.4, tmp).add(homes[i]);
        if (i < cloudCount) tmp.y = Math.max(SLAB + 0.8, tmp.y);
        else tmp.y = Math.min(-SLAB - 0.8, tmp.y);
        setSpark(i, tmp, i < cloudCount ? 0.82 : 0.75);
      }

      // Pumped protons: up from the matrix, through the complex, out into the crista lumen.
      protons.commit();
      let index = 0;
      for (let s = 0; s < pumpSites.length; s++) {
        const site = pumpSites[s];
        for (let k = 0; k < 2; k++) {
          const slot = s * 2 + k;
          const cycleTime = time / TURN - site.phase / TURN;
          const cycleIndex = Math.floor(cycleTime);
          // Slot k carries the protons of every other cycle.
          const own = cycleIndex - (((cycleIndex - k) % 2) + 2) % 2;
          const age = (cycleTime - own) * TURN;
          if (age < 0 || age > 2.4) {
            setMoving(index++, zero, 0);
            continue;
          }
          const rise = THREE.MathUtils.smoothstep(age, 0, 0.75);
          const z = PROTEIN_Z + 0.2;
          if (age < 0.75) {
            tmp.set(site.x, THREE.MathUtils.lerp(site.y0, site.y1, rise), z);
            setMoving(index++, tmp, Math.min(1, age / 0.15));
          } else {
            const out = THREE.MathUtils.smoothstep(age, 0.75, 2.4);
            tmp.set(site.x, site.y1, z).addScaledVector(drift[slot], out);
            setMoving(index++, tmp, 1 - out * out);
          }
        }
      }

      // Protons flowing down through ATP synthase, riding on the c-ring.
      const step = TURN / C_SUBUNITS;
      for (let slot = 0; slot < flowSlots; slot++) {
        const n = Math.floor((time - slot * step) / (flowSlots * step));
        const t0 = (n * flowSlots + slot) * step;
        const age = time - t0;
        const descend = TURN / 2; // binds when an outer helix (at +0.12 rad) faces subunit a
        const ride = (TURN * 7) / 8;
        const exit = 0.7;
        if (age < 0 || age > descend + ride + exit) {
          setMoving(index++, zero, 0);
          continue;
        }
        if (age < descend) {
          const u = THREE.MathUtils.smoothstep(age, 0, descend);
          tmp.set(RING_X + 3.9, 9, PROTEIN_Z + 1.4).lerp(tmp2.set(RING_X + Math.cos(0.12) * RING_R, 0.1, PROTEIN_Z - Math.sin(0.12) * RING_R), u);
          setMoving(index++, tmp, Math.min(1, age / 0.12));
        } else if (age < descend + ride) {
          const theta = 0.12 - ((age - descend) / TURN) * Math.PI * 2;
          tmp.set(RING_X + Math.cos(theta) * RING_R, 0.1, PROTEIN_Z - Math.sin(theta) * RING_R);
          setMoving(index++, tmp, 1);
        } else {
          const u = (age - descend - ride) / exit;
          const theta = 0.12 - (ride / TURN) * Math.PI * 2;
          tmp.set(RING_X + Math.cos(theta) * RING_R, 0.1, PROTEIN_Z - Math.sin(theta) * RING_R);
          tmp2.set(RING_X + 4.2 + u * 1.5, -3.2 - u * 4.5, PROTEIN_Z + 1.2 + u * 1.5);
          tmp.lerp(tmp2, Math.min(1, u * 1.6));
          setMoving(index++, tmp, 1 - u * u);
        }
      }
      moving.commit();

      // ATP release: one per third of a turn, from the β subunits in turn.
      const release = TURN / ATP_PER_TURN;
      latestShowcaseVisible = false;
      for (let slot = 0; slot < atpSlots; slot++) {
        const n = Math.floor((time - slot * release) / (atpSlots * release));
        const t0 = (n * atpSlots + slot) * release;
        const age = time - t0;
        const life = atpSlots * release;
        const beta = betas[slot % 3];
        const dir = tmp2.set(Math.cos(beta.angle), 0, -Math.sin(beta.angle));
        const travel = 3.2 * (1 - Math.exp(-age / 0.9)) + 0.9 * age;
        const p = atpPositions[slot];
        p.set(RING_X + dir.x * (F1_R + 2.3 + travel), F1_Y - 0.8 - travel * 0.55, PROTEIN_Z + dir.z * (F1_R + 2.3 + travel) + travel * 0.45);
        wander(slot * 1.3 + 2, age * 0.9, Math.min(1, age) * 0.6 * thermal.amount, tmp);
        p.add(tmp);
        const fadeIn = THREE.MathUtils.smoothstep(age, 0, 0.25);
        const fadeOut = 1 - THREE.MathUtils.smoothstep(age, life - 1.0, life);
        const s = Math.max(0.001, fadeIn * fadeOut);
        e.set(age * 0.9 + slot, age * 0.6, slot * 0.8);
        q.setFromEuler(e);
        atpMesh.setMatrixAt(slot, m.compose(p, q, tmp.copy(one).multiplyScalar(s)));
        if (slot === showcaseSlot) latestShowcaseVisible = age > 0.9 && age < life - 1.2;
      }
      atpMesh.instanceMatrix.needsUpdate = true;

      // The β subunit that is releasing ATP opens slightly.
      for (let i = 0; i < betas.length; i++) {
        const b = betas[i];
        const phase = ((time / release - i) % 3 + 3) % 3; // 0 at its release
        const pulse = Math.exp(-((Math.min(phase, 3 - phase) / 0.35) ** 2));
        b.mesh.position.set(b.home.x + Math.cos(b.angle) * 0.35 * pulse, b.home.y, b.home.z - Math.sin(b.angle) * 0.35 * pulse);
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}

