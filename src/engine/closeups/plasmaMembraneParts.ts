import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { mergeGeometries } from '../core/geometry';
import type { Rng } from '../core/random';
import { addInstanceGlow, addJiggle, instanced, instancedMaterial, setSeeds, type JiggleUniforms, type Placement } from './kit';
import { ballGeometry, mergeParts } from './membranesParts';

/**
 * Pieces of the plasma-membrane close-up. The phospholipid layer follows
 * kit.lipidBilayer (same lattice, sizes and thermal motion) but is adapted:
 * cheaper geometry at low quality (the 40 nm patch holds ~2,600
 * phospholipids), cholesterol in some lattice sites, and the per-lipid
 * jiggle seed is exposed so glycolipid sugar chains move with their lipid.
 */

/** Same thermal motion as kit.lipidBilayer (lateral drift larger than vertical). */
export const LIPID_JIGGLE = new THREE.Vector3(0.22, 0.08, 0.22);

export interface LipidSite {
  x: number;
  z: number;
  leaflet: 1 | -1;
  /** Jiggle seed (unique per site). */
  seed: number;
}

/** Hexagonal lattice of lipid positions in both leaflets (outer leaflet = +1, toward +y). */
export function lipidLattice(width: number, depth: number, spacing: number, rng: Rng): LipidSite[] {
  const rows = Math.floor(depth / (spacing * 0.866));
  const cols = Math.floor(width / spacing);
  const sites: LipidSite[] = [];
  for (const leaflet of [1, -1] as const) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -width / 2 + (c + (r % 2) * 0.5 + 0.5) * spacing + rng.range(-0.18, 0.18);
        const z = -depth / 2 + (r + 0.5) * spacing * 0.866 + rng.range(-0.18, 0.18);
        sites.push({ x, z, leaflet, seed: sites.length });
      }
    }
  }
  return sites;
}

export interface LipidMeshes {
  heads: THREE.InstancedMesh;
  tails: THREE.InstancedMesh;
  dispose(): void;
}

/** Phospholipids (head + two tails) at the given sites. */
export function phospholipidMeshes(
  sites: LipidSite[],
  options: {
    quality: QualityLevel;
    jiggle: JiggleUniforms;
    rng: Rng;
    thickness: number;
    headRadius: number;
    headColor: THREE.ColorRepresentation;
    tailColor: THREE.ColorRepresentation;
  },
): LipidMeshes {
  const { quality, rng, headRadius } = options;
  const half = options.thickness / 2;
  const tailLength = half - headRadius * 0.6;
  const headGeometry = ballGeometry(quality === 'low' ? 'octa' : quality === 'medium' ? 0 : 1);
  const radial = quality === 'low' ? 3 : quality === 'medium' ? 4 : 5;
  const tailParts: THREE.BufferGeometry[] = [];
  for (const offset of [-0.2, 0.2]) {
    const tail = new THREE.CylinderGeometry(0.15, 0.11, 1, radial, 1, true);
    tail.translate(offset, -0.5, 0);
    tail.deleteAttribute('uv');
    tailParts.push(tail);
  }
  const tailGeometry = mergeGeometries(tailParts)!;
  tailParts.forEach((g) => g.dispose());

  const headColor = new THREE.Color(options.headColor);
  const tailColor = new THREE.Color(options.tailColor);
  const heads: Placement[] = [];
  const tails: Placement[] = [];
  const seeds: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const site of sites) {
    const { x, z, leaflet } = site;
    const headY = leaflet * half;
    const tint = rng.range(-0.06, 0.06);
    heads.push({ position: new THREE.Vector3(x, headY, z), scale: headRadius * rng.range(0.9, 1.1), color: headColor.clone().offsetHSL(0, 0, tint) });
    const tilt = new THREE.Vector3(rng.range(-0.18, 0.18), -leaflet, rng.range(-0.18, 0.18)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, tilt.negate());
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI)));
    tails.push({
      position: new THREE.Vector3(x, headY - leaflet * headRadius * 0.6, z),
      quaternion: q,
      scale: new THREE.Vector3(1, tailLength * rng.range(0.85, 1.05), 1),
      color: tailColor.clone().offsetHSL(0, 0, tint * 0.5),
    });
    seeds.push(site.seed);
  }
  const headMaterial = instancedMaterial({ roughness: 0.45 });
  addInstanceGlow(headMaterial, 0.2, 'pmHead');
  addJiggle(headMaterial, options.jiggle, LIPID_JIGGLE, 1, 'pmJiggle');
  const tailMaterial = instancedMaterial({ roughness: 0.7 });
  addInstanceGlow(tailMaterial, 0.12, 'pmTail');
  addJiggle(tailMaterial, options.jiggle, LIPID_JIGGLE, 1, 'pmJiggle');
  const headMesh = instanced(headGeometry, headMaterial, heads);
  const tailMesh = instanced(tailGeometry, tailMaterial, tails);
  setSeeds(headMesh, seeds);
  setSeeds(tailMesh, seeds);
  return {
    heads: headMesh,
    tails: tailMesh,
    dispose() {
      headGeometry.dispose();
      tailGeometry.dispose();
      headMaterial.dispose();
      tailMaterial.dispose();
    },
  };
}

/**
 * Cholesterol: a small rigid rod (~1.9 nm) — hydroxyl head, flat four-ring
 * steroid body and a short hydrocarbon tail. Local +y points to the hydroxyl.
 */
export function cholesterolGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const radial = quality === 'low' ? 4 : quality === 'medium' ? 6 : 8;
  const ring = new THREE.CylinderGeometry(0.35, 0.33, 1.15, radial, 1, false);
  ring.scale(1, 1, 0.72); // the steroid ring system is flat
  ring.translate(0, -0.78, 0);
  const tail = new THREE.CylinderGeometry(0.13, 0.07, 0.62, Math.max(3, radial - 2), 1, true);
  tail.translate(0, -1.62, 0);
  const hydroxyl = ballGeometry(quality === 'high' ? 0 : 'octa');
  hydroxyl.scale(0.17, 0.17, 0.17);
  hydroxyl.translate(0, -0.12, 0);
  return mergeParts([ring, tail, hydroxyl]);
}

/** Total length of the cholesterol rod (hydroxyl top to tail tip). */
export const CHOLESTEROL_LENGTH = 1.93;
