import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { blobGeometry } from './common';
import { bandMaterial, membraneMaterial } from './kit';
import { bandArcGeometry, cutawayMaterial, paramSurface } from './membranesParts';

/**
 * ER exit site for the rough-ER close-up: a patch of membrane (cut in half
 * at z = 0, back half drawn) that bulges into a coated bud on the cytosolic
 * side (+y), narrows at a smooth neck and pinches off as a vesicle.
 *
 * Shape: the bud is a sphere (mid-surface radius R) whose centre rises from
 * −R (flat membrane) to the pinch height; a fillet circle of radius ρ joins
 * it smoothly to the flat membrane. Group origin = bud axis on the membrane
 * mid-plane.
 */
export interface BudOptions {
  radius: number;
  fillet: number;
  /** Radius of the dynamic membrane region around the axis (the rest of the sheet is static). */
  region: number;
  thickness: number;
  quality: QualityLevel;
  color: THREE.ColorRepresentation;
  bandHead: THREE.Color;
  bandCore: THREE.Color;
  coatColor: THREE.ColorRepresentation;
  coatCap: THREE.ColorRepresentation;
  cut: THREE.Plane;
  /** Self-glow of the membrane faces (match the surrounding sheet). */
  emissive: number;
}

export interface Bud {
  group: THREE.Group;
  /** The detached vesicle (back half + banded ring), shown after pinch-off. */
  vesicle: THREE.Group;
  /** Sphere-centre height at which the neck closes. */
  pinchHeight: number;
  /**
   * c = sphere-centre height (−R … pinchHeight) while budding; after pinch-off
   * pass `relax` 0 → 1 (the membrane flattens) and the vesicle centre.
   */
  update(c: number, pinched: boolean, relax: number, vesicleCenter: THREE.Vector3, opacity: number): void;
  dispose(): void;
}

const STOPS = [0, 0.28, 0.36, 0.64, 0.72, 1];

export function createBud(o: BudOptions): Bud {
  const R = o.radius;
  const rho = o.fillet;
  const half = o.thickness / 2;
  const pinchHeight = rho + Math.sqrt(R * R + 2 * R * rho);
  const FLAT = 8;
  const FILLET = 12;
  const SPHERE = o.quality === 'low' ? 22 : o.quality === 'medium' ? 28 : 34;
  const M = FLAT + FILLET + SPHERE + 1;
  const AROUND = o.quality === 'low' ? 20 : o.quality === 'medium' ? 28 : 36;
  const pr = new Float32Array(M);
  const py = new Float32Array(M);
  const nr = new Float32Array(M);
  const ny = new Float32Array(M);

  /** Mid-surface profile (r, y) with the cytosol-side normal, outer edge → top of the bud. */
  const profile = (c: number, pinched: boolean, relax: number) => {
    const d2 = (R + rho) * (R + rho) - (rho - c) * (rho - c);
    const rf = Math.max(0, d2 > 0 ? Math.sqrt(d2) : 0);
    if ((!pinched && rf < 1e-3) || c <= -R + 1e-3) {
      for (let k = 0; k < M; k++) {
        pr[k] = o.region * (1 - k / (M - 1));
        py[k] = 0;
        nr[k] = 0;
        ny[k] = 1;
      }
      return;
    }
    let k = 0;
    for (let i = 0; i < FLAT; i++, k++) {
      pr[k] = o.region + ((rf - o.region) * i) / FLAT;
      py[k] = 0;
      nr[k] = 0;
      ny[k] = 1;
    }
    let beta = Math.atan2(c - rho, -rf);
    if (beta > -Math.PI / 2) beta -= Math.PI * 2;
    // After scission the remaining membrane ends at the closed neck (angle −π) and relaxes flat.
    const filletEnd = pinched ? -Math.PI : beta;
    for (let i = 0; i < FILLET; i++, k++) {
      const a = -Math.PI / 2 + ((filletEnd + Math.PI / 2) * i) / (FILLET - 1);
      pr[k] = Math.max(0, rf + rho * Math.cos(a));
      py[k] = rho + rho * Math.sin(a);
      nr[k] = -Math.cos(a);
      ny[k] = -Math.sin(a);
    }
    if (pinched) {
      for (; k < M; k++) {
        pr[k] = 0;
        py[k] = py[FLAT + FILLET - 1];
        nr[k] = 0;
        ny[k] = 1;
      }
      for (let i = 0; i < M; i++) {
        py[i] *= 1 - relax;
        nr[i] *= 1 - relax;
        ny[i] = ny[i] * (1 - relax) + relax;
        const len = Math.hypot(nr[i], ny[i]) || 1;
        nr[i] /= len;
        ny[i] /= len;
      }
      return;
    }
    const psiT = Math.atan2(rf, rho - c);
    for (let i = 0; i <= SPHERE; i++, k++) {
      const psi = psiT * (1 - i / SPHERE);
      pr[k] = R * Math.sin(psi);
      py[k] = c + R * Math.cos(psi);
      nr[k] = Math.sin(psi);
      ny[k] = Math.cos(psi);
    }
  };

  // Two revolved faces (cytosolic +half, luminal −half), back half only (θ = π … 2π).
  const faces = [1, -1].map((side) => {
    profile(-R, false, 0);
    const geometry = paramSurface(AROUND, M - 1, (u, v, p, n) => {
      const kk = Math.round(v * (M - 1));
      const theta = Math.PI + u * Math.PI;
      const r = pr[kk] + side * half * nr[kk];
      p.set(r * Math.cos(theta), py[kk] + side * half * ny[kk], r * Math.sin(theta));
      n.set(nr[kk] * Math.cos(theta), ny[kk], nr[kk] * Math.sin(theta)).multiplyScalar(side);
    });
    (geometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (geometry.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    return { side, geometry };
  });
  const faceMaterial = membraneMaterial(o.color, { rim: 0.3 });
  faceMaterial.emissiveIntensity = o.emissive;
  const group = new THREE.Group();
  for (const f of faces) {
    const mesh = new THREE.Mesh(f.geometry, faceMaterial);
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // Banded cut face along the profile, left half (θ = π) then right half (θ = 2π).
  const bandPoints = 2 * M - 1;
  const bandPositions = new Float32Array(bandPoints * STOPS.length * 3);
  const bandColors = new Float32Array(bandPoints * STOPS.length * 3);
  const bandIndices: number[] = [];
  for (let s = 0; s < bandPoints; s++) {
    for (let j = 0; j < STOPS.length; j++) {
      const c = j === 0 || j === 1 || j === 4 || j === 5 ? o.bandHead : o.bandCore;
      bandColors.set([c.r, c.g, c.b], (s * STOPS.length + j) * 3);
      if (s < bandPoints - 1 && j < STOPS.length - 1) {
        const a = s * STOPS.length + j;
        const b = a + STOPS.length;
        bandIndices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const bandGeometry = new THREE.BufferGeometry();
  const bandAttribute = new THREE.BufferAttribute(bandPositions, 3);
  bandAttribute.setUsage(THREE.DynamicDrawUsage);
  bandGeometry.setAttribute('position', bandAttribute);
  bandGeometry.setAttribute('color', new THREE.BufferAttribute(bandColors, 3));
  const bandNormals = new Float32Array(bandPoints * STOPS.length * 3);
  for (let i = 2; i < bandNormals.length; i += 3) bandNormals[i] = 1;
  bandGeometry.setAttribute('normal', new THREE.BufferAttribute(bandNormals, 3));
  bandGeometry.setIndex(bandIndices);
  const band = new THREE.Mesh(bandGeometry, bandMaterial());
  band.frustumCulled = false;
  group.add(band);

  // COPII coat: lumpy subunits on a geodesic lattice joined by short rods.
  const ico = new THREE.IcosahedronGeometry(1, 2);
  const icoPos = ico.attributes.position as THREE.BufferAttribute;
  const dirs: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < icoPos.count; i++) {
    v.fromBufferAttribute(icoPos, i).normalize();
    if (!dirs.some((d) => d.distanceToSquared(v) < 1e-6)) dirs.push(v.clone());
  }
  ico.dispose();
  const coatDirs = dirs.filter((d) => d.z <= 0.16);
  const edges: [number, number][] = [];
  for (let i = 0; i < coatDirs.length; i++) {
    for (let j = i + 1; j < coatDirs.length; j++) if (coatDirs[i].angleTo(coatDirs[j]) < 0.45) edges.push([i, j]);
  }
  const coatRadius = R + half + 3.6;
  const subunit = blobGeometry(3.6, 'copii-subunit', 0.24, o.quality === 'high' ? 2 : 1);
  const rod = new THREE.CylinderGeometry(1.1, 1.1, 1, 5, 1, true);
  const coatMaterial = cutawayMaterial(o.coatColor, o.coatCap, o.cut, { emissiveIntensity: 0.2, transparent: true });
  const subunits = new THREE.InstancedMesh(subunit, coatMaterial, coatDirs.length);
  const rods = new THREE.InstancedMesh(rod, coatMaterial, edges.length);
  subunits.frustumCulled = false;
  rods.frustumCulled = false;
  const spins = coatDirs.map((_, i) => new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 1.3, i * 2.1, i * 0.7)));
  const coat = new THREE.Group();
  coat.add(subunits, rods);

  // Detached vesicle: same membrane, closed sphere cut in half.
  const outer = new THREE.SphereGeometry(R + half, 40, 20, Math.PI, Math.PI); // back hemisphere (z ≤ 0)
  const inner = new THREE.SphereGeometry(R - half, 40, 20, Math.PI, Math.PI);
  const vesicleFaceMaterial = membraneMaterial(o.color, { rim: 0.3 });
  vesicleFaceMaterial.emissiveIntensity = o.emissive;
  vesicleFaceMaterial.transparent = true;
  const innerMaterial = membraneMaterial(new THREE.Color(o.color).multiplyScalar(0.8), { side: THREE.BackSide, rim: 0.15 });
  innerMaterial.transparent = true;
  const ringGeometry = bandArcGeometry(R - half, R + half, 0, Math.PI * 2, 64, o.bandHead, o.bandCore);
  const ringMaterial = bandMaterial();
  ringMaterial.transparent = true;
  const vesicle = new THREE.Group();
  vesicle.add(new THREE.Mesh(outer, vesicleFaceMaterial), new THREE.Mesh(inner, innerMaterial), new THREE.Mesh(ringGeometry, ringMaterial));
  vesicle.visible = false;
  const root = new THREE.Group();
  root.add(group, vesicle, coat);

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _center = new THREE.Vector3();

  return {
    group: root,
    vesicle,
    pinchHeight,
    update(c, pinched, relax, vesicleCenter, opacity) {
      profile(c, pinched, relax);
      for (const f of faces) {
        const pos = f.geometry.attributes.position as THREE.BufferAttribute;
        const nor = f.geometry.attributes.normal as THREE.BufferAttribute;
        for (let k = 0; k < M; k++) {
          const r = pr[k] + f.side * half * nr[k];
          const y = py[k] + f.side * half * ny[k];
          for (let i = 0; i <= AROUND; i++) {
            const theta = Math.PI + (i / AROUND) * Math.PI;
            const index = k * (AROUND + 1) + i;
            pos.setXYZ(index, r * Math.cos(theta), y, r * Math.sin(theta));
            nor.setXYZ(index, f.side * nr[k] * Math.cos(theta), f.side * ny[k], f.side * nr[k] * Math.sin(theta));
          }
        }
        pos.needsUpdate = true;
        nor.needsUpdate = true;
      }
      let w = 0;
      for (let s = 0; s < bandPoints; s++) {
        const k = s < M ? s : 2 * M - 2 - s;
        const sign = s < M ? -1 : 1;
        for (let j = 0; j < STOPS.length; j++) {
          const off = -half + o.thickness * STOPS[j];
          bandPositions[w++] = sign * (pr[k] + off * nr[k]);
          bandPositions[w++] = py[k] + off * ny[k];
          bandPositions[w++] = 0;
        }
      }
      bandAttribute.needsUpdate = true;

      // Coat on the budded part of the sphere (or the whole vesicle once detached).
      const psiT = pinched ? Math.PI + 1 : Math.atan2(Math.sqrt(Math.max(0, (R + rho) * (R + rho) - (rho - c) * (rho - c))), rho - c);
      if (pinched) _center.copy(vesicleCenter);
      else _center.set(0, c, 0);
      const coatOn = c > -R + 2;
      for (let i = 0; i < coatDirs.length; i++) {
        const d = coatDirs[i];
        const psi = Math.acos(THREE.MathUtils.clamp(d.y, -1, 1));
        const grow = coatOn ? THREE.MathUtils.clamp((psiT - 0.2 - psi) / 0.25, 0, 1) : 0;
        _p.copy(d).multiplyScalar(coatRadius).add(_center);
        _s.setScalar(grow);
        subunits.setMatrixAt(i, _m.compose(_p, spins[i], _s));
      }
      for (let e = 0; e < edges.length; e++) {
        const [i, j] = edges[e];
        const psiI = Math.acos(THREE.MathUtils.clamp(coatDirs[i].y, -1, 1));
        const psiJ = Math.acos(THREE.MathUtils.clamp(coatDirs[j].y, -1, 1));
        const grow = coatOn ? THREE.MathUtils.clamp((psiT - 0.25 - Math.max(psiI, psiJ)) / 0.25, 0, 1) : 0;
        _a.copy(coatDirs[i]).multiplyScalar(coatRadius).add(_center);
        _b.copy(coatDirs[j]).multiplyScalar(coatRadius).add(_center);
        _p.addVectors(_a, _b).multiplyScalar(0.5);
        _q.setFromUnitVectors(_up, _b.sub(_a).normalize());
        _s.set(grow, _a.distanceTo(_p) * 2 * grow, grow);
        rods.setMatrixAt(e, _m.compose(_p, _q, _s));
      }
      subunits.instanceMatrix.needsUpdate = true;
      rods.instanceMatrix.needsUpdate = true;
      coatMaterial.opacity = opacity;
      coatMaterial.depthWrite = opacity > 0.99;

      vesicle.visible = pinched && opacity > 0.001;
      vesicle.position.copy(vesicleCenter);
      vesicleFaceMaterial.opacity = opacity;
      innerMaterial.opacity = opacity;
      ringMaterial.opacity = opacity;
    },
    dispose() {
      faces.forEach((f) => f.geometry.dispose());
      faceMaterial.dispose();
      bandGeometry.dispose();
      subunit.dispose();
      rod.dispose();
      coatMaterial.dispose();
      outer.dispose();
      inner.dispose();
      ringGeometry.dispose();
      vesicleFaceMaterial.dispose();
      innerMaterial.dispose();
      ringMaterial.dispose();
    },
  };
}
