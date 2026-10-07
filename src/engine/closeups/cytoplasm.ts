import * as THREE from 'three';
import { Rng } from '../core/random';
import { Simplex3 } from '../core/noise';
import { createCloseupScene, disposeScene } from './common';
import {
  actinFilament,
  addInstanceGlow,
  addJiggle,
  anchorOn,
  byQuality,
  createJiggle,
  instanced,
  instancedMaterial,
  moleculeMaterial,
  nearestDistance,
  proteinShapes,
  randomQuaternion,
  ribosomeGeometries,
  scatter,
  setSeeds,
  singleStrand,
  trnaGeometry,
  type Placement,
} from './kit';
import type { CloseupFactory } from './types';

/**
 * Crowded cytosol (1 unit = 1 nm): a 100 nm cube holding proteins of many
 * sizes, three ribosomes (two reading one mRNA), transfer RNAs and an actin
 * filament. Water, ions and small molecules are left out.
 */
const CUBE = 100;
const HALF = CUBE / 2;

const PROTEIN_COLORS = ['#4f86e8', '#5fa8f0', '#3fbf9a', '#62cf7f', '#86d6b4', '#3d6fc9', '#7fb8ff'];

const create: CloseupFactory = (ctx) => {
  const scene = createCloseupScene('#0b1426');
  const rng = new Rng('closeup:cytoplasm');
  const noise = new Simplex3('closeup:cytoplasm:drift');
  const time = { value: 0 };
  const jiggle = createJiggle(time);
  const root = new THREE.Group();
  scene.add(root);

  // Faint cube edges show the sampled volume.
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE, CUBE, CUBE)),
    new THREE.LineBasicMaterial({ color: '#7fa6c9', transparent: true, opacity: 0.35 }),
  );
  root.add(edges);

  // Actin filament crossing the cube near the front.
  const actinCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-HALF - 4, -30, 24),
    new THREE.Vector3(-10, -12, 30),
    new THREE.Vector3(20, 6, 26),
    new THREE.Vector3(HALF + 4, 26, 18),
  ]);
  const actin = actinFilament({ curve: actinCurve, quality: ctx.quality, color: '#ff9f9f', seed: 'cyto-actin' });
  root.add(actin.mesh);

  // mRNA meandering through the upper part, read by two ribosomes (a small polysome).
  const mrnaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-HALF + 2, 30, -10),
    new THREE.Vector3(-24, 20, 14),
    new THREE.Vector3(-4, 34, 28),
    new THREE.Vector3(14, 22, 6),
    new THREE.Vector3(30, 36, -16),
    new THREE.Vector3(HALF - 2, 30, -26),
  ]);
  const mrna = singleStrand({ curve: mrnaCurve, quality: ctx.quality, backboneColor: '#ff7fb3', baseColor: (i) => (i % 6 < 3 ? '#ffd1e4' : '#ffb07f') });
  root.add(mrna.group);

  const ribosomeShapes = ribosomeGeometries(ctx.quality, 'cyto-ribosome');
  const smallMaterial = moleculeMaterial('#f6d58c', { roughness: 0.5 });
  const largeMaterial = moleculeMaterial('#e3a83a', { roughness: 0.5 });
  const ribosomes: { group: THREE.Group; home: THREE.Vector3; base: THREE.Quaternion }[] = [];
  const addRibosome = (position: THREE.Vector3, orientation: THREE.Quaternion) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(ribosomeShapes.small, smallMaterial), new THREE.Mesh(ribosomeShapes.large, largeMaterial));
    group.position.copy(position);
    group.quaternion.copy(orientation);
    root.add(group);
    ribosomes.push({ group, home: position.clone(), base: orientation.clone() });
    return group;
  };
  // Ribosomes on the mRNA: the mRNA passes through the cleft (local −y side).
  for (const u of [0.32, 0.7]) {
    const p = mrnaCurve.getPointAt(u);
    const tangent = mrnaCurve.getTangentAt(u);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), tangent);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), u * 4));
    const offset = new THREE.Vector3(0, 2.6, 0).applyQuaternion(q);
    addRibosome(p.clone().add(offset), q);
  }
  const freeRibosome = addRibosome(new THREE.Vector3(26, -24, -6), randomQuaternion(rng));

  // Transfer RNAs.
  const trnaShape = trnaGeometry(ctx.quality);
  const trnaMaterial = moleculeMaterial('#ffa36b', { roughness: 0.45 });
  const trnas: { mesh: THREE.Mesh; home: THREE.Vector3; base: THREE.Quaternion }[] = [];
  const obstacleSamples: THREE.Vector3[] = [
    ...actin.positions.filter((_, i) => i % 2 === 0),
    ...Array.from({ length: 60 }, (_, i) => mrnaCurve.getPointAt(i / 59)),
  ];
  const ribosomeCenters = ribosomes.map((r) => r.home);
  const box = new THREE.Box3(new THREE.Vector3(-HALF, -HALF, -HALF), new THREE.Vector3(HALF, HALF, HALF));
  const blocked = (p: THREE.Vector3, r: number) =>
    nearestDistance(p, obstacleSamples) < r + 4.5 || ribosomeCenters.some((c) => c.distanceTo(p) < r + 16);
  const trnaSpots = scatter(rng, box.clone().expandByScalar(-6), byQuality(ctx.quality, { low: 8, medium: 12, high: 14 }), () => 6, blocked);
  for (const spot of trnaSpots) {
    const mesh = new THREE.Mesh(trnaShape, trnaMaterial);
    mesh.position.copy(spot.position);
    mesh.quaternion.copy(randomQuaternion(rng));
    root.add(mesh);
    trnas.push({ mesh, home: spot.position.clone(), base: mesh.quaternion.clone() });
  }
  const trnaCenters = trnaSpots.map((s) => s.position);

  // Proteins: many sizes, blues and greens, jiggling in the shader.
  const shapes = proteinShapes('cyto-protein', 6, ctx.quality === 'high' ? 2 : 1);
  const proteinCount = byQuality(ctx.quality, { low: 500, medium: 800, high: 1050 });
  const spots = scatter(
    rng,
    box,
    proteinCount,
    () => {
      const x = rng.next();
      return 1.8 + x * x * 3.6; // many small, few large (1.8–5.4 nm)
    },
    (p, r) => blocked(p, r) || trnaCenters.some((c) => c.distanceTo(p) < r + 5),
    12,
  );
  const proteinMaterial = instancedMaterial({ roughness: 0.55 });
  addInstanceGlow(proteinMaterial, 0.16, 'cytoProteins');
  addJiggle(proteinMaterial, jiggle, new THREE.Vector3(0.9, 0.9, 0.9), 0.55, 'cytoJiggle');
  const buckets: Placement[][] = shapes.map(() => []);
  const seedBuckets: number[][] = shapes.map(() => []);
  spots.forEach((spot, i) => {
    const k = i % shapes.length;
    const color = new THREE.Color(PROTEIN_COLORS[rng.int(0, PROTEIN_COLORS.length - 1)]).offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.05, 0.05));
    buckets[k].push({ position: spot.position, quaternion: randomQuaternion(rng), scale: spot.radius, color });
    seedBuckets[k].push(i);
  });
  let enzymeIndex = 0;
  let enzymeBest = -Infinity;
  spots.forEach((spot, i) => {
    // A medium-sized protein near the front, for the label.
    const score = spot.position.z - Math.abs(spot.position.x + 20) * 0.6 - Math.abs(spot.position.y + 8) * 0.6 + (spot.radius > 3 ? 10 : 0);
    if (score > enzymeBest) {
      enzymeBest = score;
      enzymeIndex = i;
    }
  });
  shapes.forEach((shape, k) => {
    if (!buckets[k].length) return;
    const mesh = instanced(shape, proteinMaterial, buckets[k]);
    setSeeds(mesh, seedBuckets[k]);
    root.add(mesh);
  });
  const enzymeAnchor = spots[enzymeIndex]?.position.clone() ?? new THREE.Vector3(-20, -8, 40);

  const cytosolAnchor = new THREE.Vector3(-HALF, -HALF + 8, HALF);
  return {
    scene,
    views: [
      {
        target: new THREE.Vector3(0, 0, 0),
        radius: 78,
        direction: new THREE.Vector3(0.5, 0.32, 1).normalize(),
        labels: [
          { part: 'enzyme', anchor: anchorOn(root, enzymeAnchor) },
          { part: 'free-ribosome', anchor: anchorOn(freeRibosome, new THREE.Vector3(0, 8, 0)) },
          { part: 'mrna', anchor: anchorOn(root, mrnaCurve.getPointAt(0.52)) },
          { part: 'filament', anchor: anchorOn(root, actinCurve.getPointAt(0.42)) },
          { textKey: 'structures.ribosomes.parts.trna.name', anchor: anchorOn(trnas[0]?.mesh ?? root, new THREE.Vector3()) },
          { part: 'cytosol', anchor: anchorOn(root, cytosolAnchor) },
        ],
      },
    ],
    setView() {},
    update(_dt, t, calm) {
      time.value = t;
      jiggle.amount.value = calm ? 0.3 : 1;
      const amp = calm ? 0.3 : 1;
      // Larger objects wander and tumble slowly (CPU: only a few dozen of them).
      ribosomes.forEach((r, i) => {
        r.group.position.set(
          r.home.x + noise.noise(i * 7.1, t * 0.25, 0) * 0.8 * amp,
          r.home.y + noise.noise(i * 7.1, t * 0.25, 5) * 0.8 * amp,
          r.home.z + noise.noise(i * 7.1, t * 0.25, 9) * 0.8 * amp,
        );
      });
      trnas.forEach((r, i) => {
        r.mesh.position.set(
          r.home.x + noise.noise(i * 3.3, t * 0.45, 1) * 2.2 * amp,
          r.home.y + noise.noise(i * 3.3, t * 0.45, 6) * 2.2 * amp,
          r.home.z + noise.noise(i * 3.3, t * 0.45, 11) * 2.2 * amp,
        );
        r.mesh.quaternion.copy(r.base).multiply(
          new THREE.Quaternion().setFromEuler(new THREE.Euler(noise.noise(i, t * 0.3, 2) * 0.6 * amp, noise.noise(i, t * 0.3, 4) * 0.6 * amp, 0)),
        );
      });
    },
    dispose() {
      actin.dispose();
      mrna.dispose();
      disposeScene(scene);
    },
  };
};

export default create;
