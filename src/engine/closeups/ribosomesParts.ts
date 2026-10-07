import * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';
import { mergeGeometries } from '../core/geometry';
import { Simplex3 } from '../core/noise';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRNA_TIPS } from './kit';

/**
 * Ribosome frame for the translation close-up (1 unit = 1 nm). Same layout as
 * the kit's RIBOSOME_FRAME — mRNA along x through the cleft on top of the
 * small subunit, sites A → P → E along +x → −x, exit tunnel leaving the large
 * subunit at the top/back — with positions tuned so the tRNAs' anticodons sit
 * on their codons and the A- and P-site acceptor ends meet at the peptidyl
 * transferase centre (PTC).
 */
export const FRAME = {
  mrnaY: -2.25,
  mrnaZ: 0.9,
  /** Distance between nucleotides of the mRNA (one codon = 3 × this). */
  nt: 0.65,
  /** Exit of the tunnel on the large subunit's surface. */
  exit: new THREE.Vector3(-0.5, 15.9, -6.2),
};
/** The kit tRNA (arms 7.6 / 7 nm) is drawn slightly smaller: arms ≈ 6.5 / 6 nm. */
export const TRNA_SCALE = 0.86;
export const CODON = FRAME.nt * 3;

/** Small subunit (40S): body, head behind the mRNA, shoulder in front, beak. */
export function smallSubunitGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const detail = quality === 'low' ? 3 : 4;
  const parts: [string, THREE.Vector3, THREE.Vector3, number][] = [
    ['body', new THREE.Vector3(12, 4.6, 9.5), new THREE.Vector3(0.4, -7.9, 0.2), 0.2],
    ['head', new THREE.Vector3(7.4, 4.4, 6.0), new THREE.Vector3(-1.6, -4.4, -6.6), 0.22],
    ['shoulder', new THREE.Vector3(4.6, 2.6, 3.8), new THREE.Vector3(6.6, -5.2, 4.2), 0.2],
    ['beak', new THREE.Vector3(2.8, 2.2, 2.6), new THREE.Vector3(-7.4, -3.4, -7.6), 0.2],
    ['foot', new THREE.Vector3(4.0, 2.4, 3.6), new THREE.Vector3(-5.5, -10.2, 2.8), 0.22],
  ];
  return mergeBlobs(parts, detail, 'ribosome:40s');
}

/** Large subunit (60S): body, central protuberance, L1 stalk (E side), P stalk (A side). */
export function largeSubunitGeometry(quality: QualityLevel): THREE.BufferGeometry {
  const detail = quality === 'low' ? 3 : 4;
  const parts: [string, THREE.Vector3, THREE.Vector3, number][] = [
    ['body', new THREE.Vector3(13.5, 8.6, 12), new THREE.Vector3(0, 8.2, -1.0), 0.13],
    ['cp', new THREE.Vector3(4.8, 3.2, 4.2), new THREE.Vector3(0.6, 15.6, -2.6), 0.18],
    ['l1', new THREE.Vector3(3.2, 5.2, 3.0), new THREE.Vector3(-13.6, 10.2, -1.9), 0.18],
    ['pstalk', new THREE.Vector3(2.2, 5.4, 2.2), new THREE.Vector3(13.4, 9.0, -1.4), 0.18],
  ];
  return mergeBlobs(parts, detail, 'ribosome:60s');
}

/** A smooth-shaded lumpy blob (indexed, so normals are averaged across faces). */
function smoothBlob(seed: string, roughness: number, detail: number): THREE.BufferGeometry {
  const noise = new Simplex3(seed);
  const base = new THREE.IcosahedronGeometry(1, detail);
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const g = mergeVertices(base);
  base.dispose();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = noise.fbm(v.x * 1.6, v.y * 1.6, v.z * 1.6, 3);
    v.multiplyScalar(1 + n * roughness);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function mergeBlobs(parts: [string, THREE.Vector3, THREE.Vector3, number][], detail: number, seed: string): THREE.BufferGeometry {
  const geometries = parts.map(([name, scale, position, roughness]) => {
    const g = smoothBlob(`${seed}:${name}`, roughness, detail);
    g.scale(scale.x, scale.y, scale.z);
    g.translate(position.x, position.y, position.z);
    g.computeVertexNormals();
    return g;
  });
  const merged = mergeGeometries(geometries)!;
  geometries.forEach((g) => g.dispose());
  return merged;
}

export type Site = 'A' | 'P' | 'E';

/** Local L-frame of the kit tRNA: from anticodon tip towards the acceptor end, and towards the elbow. */
const LOCAL_U = new THREE.Vector3().subVectors(TRNA_TIPS.aminoAcid, TRNA_TIPS.anticodon).normalize();
const LOCAL_W = (() => {
  const a = TRNA_TIPS.anticodon;
  const along = new THREE.Vector3().sub(a).dot(LOCAL_U);
  const foot = a.clone().addScaledVector(LOCAL_U, along);
  return new THREE.Vector3().sub(foot).normalize();
})();
const LOCAL_N = new THREE.Vector3().crossVectors(LOCAL_U, LOCAL_W);
const LOCAL_BASIS = new THREE.Matrix4().makeBasis(LOCAL_U, LOCAL_W, LOCAL_N);
const AC_LENGTH = TRNA_TIPS.aminoAcid.distanceTo(TRNA_TIPS.anticodon) * TRNA_SCALE;

export interface TrnaPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/**
 * Pose (elbow position + rotation) of the kit tRNA so that its anticodon tip
 * sits at `anticodon`, its acceptor end points towards `acceptor` and its
 * elbow sticks out towards `elbowDir`.
 */
export function trnaPose(anticodon: THREE.Vector3, acceptor: THREE.Vector3, elbowDir: THREE.Vector3): TrnaPose {
  const u = new THREE.Vector3().subVectors(acceptor, anticodon).normalize();
  const w = elbowDir.clone().addScaledVector(u, -elbowDir.dot(u)).normalize();
  const n = new THREE.Vector3().crossVectors(u, w);
  const world = new THREE.Matrix4().makeBasis(u, w, n);
  const rotation = world.multiply(LOCAL_BASIS.clone().transpose());
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotation);
  const position = anticodon.clone().sub(TRNA_TIPS.anticodon.clone().multiplyScalar(TRNA_SCALE).applyQuaternion(quaternion));
  return { position, quaternion };
}

/** Site poses: anticodons on consecutive codons, A/P acceptor ends at the PTC, E further out. */
export function sitePoses(): Record<Site, TrnaPose> {
  const y = FRAME.mrnaY + 1.25;
  const z = FRAME.mrnaZ;
  const rotY = (deg: number) => new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
  const toward = (from: THREE.Vector3, to: THREE.Vector3) => from.clone().addScaledVector(to.clone().sub(from).normalize(), AC_LENGTH);
  const aA = new THREE.Vector3(CODON, y, z);
  const aP = new THREE.Vector3(0, y, z);
  const aE = new THREE.Vector3(-CODON, y, z);
  return {
    A: trnaPose(aA, toward(aA, new THREE.Vector3(1.3, 7.9, -0.4)), rotY(96)),
    P: trnaPose(aP, toward(aP, new THREE.Vector3(-0.2, 7.9, -0.9)), rotY(50)),
    E: trnaPose(aE, toward(aE, new THREE.Vector3(-5.8, 6.9, -2.4)), rotY(-4)),
  };
}

/** Where the amino acid (or the chain) attaches: just beyond the kit tRNA's acceptor tip. */
export const ACCEPTOR_LOCAL = TRNA_TIPS.aminoAcid.clone().add(new THREE.Vector3(0.9, 0, 0));
/** Centre of the anticodon loop (coloured to match the codon it reads). */
export const ANTICODON_LOCAL = new THREE.Vector3(0, -6.75, 0);
