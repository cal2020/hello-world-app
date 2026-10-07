import * as THREE from 'three';
import { mergeGeometries } from '../core/geometry';
import { arcPoints, membraneBands, membraneMaterial, ribbonGeometry, cutFaceMaterial, type Band } from './energyParts';

/** Geometry for the endosome close-up: receptors, the clathrin cage and a cut-open recycling tubule. */

/** A Y-shaped transmembrane receptor along +y (extracellular side up); membrane centre at y = 0. ~19 nm tall. */
export function receptorGeometry(radial: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tail = new THREE.IcosahedronGeometry(1.9, 1);
  tail.translate(0.3, -4.6, 0);
  parts.push(tail);
  const stalk = new THREE.CapsuleGeometry(1.15, 7, 2, radial);
  stalk.translate(0, 0.6, 0);
  parts.push(stalk);
  const body = new THREE.CapsuleGeometry(1.7, 3.5, 2, radial);
  body.translate(0, 7.2, 0);
  parts.push(body);
  for (const s of [-1, 1]) {
    const arm = new THREE.CapsuleGeometry(1.35, 4.6, 2, radial);
    arm.translate(0, 2.6, 0);
    arm.rotateZ(s * 0.62);
    arm.translate(0, 9.6, 0);
    parts.push(arm);
  }
  const prepared = parts.map((g) => {
    const h = g.index ? g.toNonIndexed() : g;
    if (h !== g) g.dispose();
    if (h.attributes.uv) h.deleteAttribute('uv');
    return h;
  });
  const merged = mergeGeometries(prepared)!;
  prepared.forEach((g) => g.dispose());
  return merged;
}

/** Where cargo sits in the receptor's cleft (local +y). */
export const RECEPTOR_BIND = 16.5;

/**
 * Truncated icosahedron ("soccer ball"), the classic clathrin cage: 60 hubs
 * (triskelion centres) and 90 struts with 12 pentagons and 20 hexagons.
 * Unit circumradius.
 */
export function clathrinCage(): { vertices: THREE.Vector3[]; edges: [number, number][] } {
  const phi = (1 + Math.sqrt(5)) / 2;
  const base: [number, number, number][] = [
    [0, 1, 3 * phi],
    [1, 2 + phi, 2 * phi],
    [phi, 2, 2 * phi + 1],
  ];
  const keys = new Set<string>();
  const vertices: THREE.Vector3[] = [];
  for (const [a, b, c] of base) {
    for (const [x, y, z] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ]) {
      for (const sx of [1, -1]) {
        for (const sy of [1, -1]) {
          for (const sz of [1, -1]) {
            const v = new THREE.Vector3(sx * x, sy * y, sz * z);
            const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
            if (keys.has(key)) continue;
            keys.add(key);
            vertices.push(v);
          }
        }
      }
    }
  }
  const edges: [number, number][] = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (Math.abs(vertices[i].distanceTo(vertices[j]) - 2) < 1e-3) edges.push([i, j]);
    }
  }
  const r = vertices[0].length();
  vertices.forEach((v) => v.divideScalar(r));
  return { vertices, edges };
}

function addGrowClip(material: THREE.Material, grow: { value: number }, key: string): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uGrow = grow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aU;\nvarying float vU;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvU = aU;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vU;\nuniform float uGrow;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vU > uGrow) discard;');
  };
  const prev = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prev ? prev() : ''}|grow:${key}`;
}

export interface Tubule {
  group: THREE.Group;
  /** 0–1: how far along its path the tubule has grown. */
  grow: { value: number };
  curve: THREE.Curve<THREE.Vector3>;
  /** Place the rounded tip at the current growth (call after changing grow). */
  update(): void;
  materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

/**
 * A membrane tubule along a curve in the plane z = 0, cut open: the back half
 * of the tube with banded cut edges, a rounded tip, and growth from the start
 * of the curve.
 */
export function cutTubule(
  curve: THREE.Curve<THREE.Vector3>,
  radius: number,
  thickness: number,
  color: THREE.ColorRepresentation,
  innerColor: THREE.ColorRepresentation,
  segments = 48,
  radial = 16,
  bands: Band[] = membraneBands('#f1e3c8', '#b08a3e'),
): Tubule {
  const grow = { value: 0 };
  const positions: number[] = [];
  const normals: number[] = [];
  const us: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const back = new THREE.Vector3(0, 0, -1);
  const n = new THREE.Vector3();
  const edgeA: THREE.Vector2[] = [];
  const edgeB: THREE.Vector2[] = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.set(-t.y, t.x, 0).normalize();
    for (let k = 0; k <= radial; k++) {
      const phi = (k / radial) * Math.PI;
      n.copy(side).multiplyScalar(Math.cos(phi)).addScaledVector(back, Math.sin(phi));
      positions.push(p.x + n.x * radius, p.y + n.y * radius, p.z + n.z * radius);
      normals.push(n.x, n.y, n.z);
      us.push(u);
    }
    edgeA.push(new THREE.Vector2(p.x + side.x * radius, p.y + side.y * radius));
    edgeB.push(new THREE.Vector2(p.x - side.x * radius, p.y - side.y * radius));
  }
  const row = radial + 1;
  for (let i = 0; i < segments; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * row + k;
      const b = (i + 1) * row + k;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const tube = new THREE.BufferGeometry();
  tube.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tube.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  tube.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
  tube.setIndex(indices);
  const outerMaterial = membraneMaterial(color, { side: THREE.FrontSide });
  const innerMaterial = membraneMaterial(innerColor, { side: THREE.BackSide, rim: 0.25 });
  addGrowClip(outerMaterial, grow, 'tubeOuter');
  addGrowClip(innerMaterial, grow, 'tubeInner');
  const group = new THREE.Group();
  group.add(new THREE.Mesh(tube, outerMaterial), new THREE.Mesh(tube, innerMaterial));
  // Cut edges, clipped by growth as well.
  const edgeParts = [edgeA, edgeB].map((pts) => {
    const g = ribbonGeometry(pts, false, thickness, bands, 0.05);
    const u = new Float32Array(pts.length * bands.length);
    for (let i = 0; i < pts.length; i++) for (let k = 0; k < bands.length; k++) u[i * bands.length + k] = i / segments;
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    return g;
  });
  const edges = mergeGeometries(edgeParts)!;
  edgeParts.forEach((g) => g.dispose());
  const edgeMaterial = cutFaceMaterial(0.25);
  addGrowClip(edgeMaterial, grow, 'tubeEdge');
  group.add(new THREE.Mesh(edges, edgeMaterial));
  // Rounded tip: the back half of a forward-facing hemisphere, plus its cut edge.
  const tip = new THREE.Group();
  const cap = new THREE.SphereGeometry(radius, radial, Math.max(6, radial / 2), Math.PI, Math.PI / 2, 0, Math.PI);
  const capOuterMaterial = membraneMaterial(color, { side: THREE.FrontSide });
  const capInnerMaterial = membraneMaterial(innerColor, { side: THREE.BackSide, rim: 0.25 });
  tip.add(new THREE.Mesh(cap, capOuterMaterial), new THREE.Mesh(cap, capInnerMaterial));
  const capEdge = ribbonGeometry(arcPoints(0, 0, radius, -Math.PI / 2, Math.PI / 2, radial), false, thickness, bands, 0.05);
  tip.add(new THREE.Mesh(capEdge, cutFaceMaterial(0.25)));
  group.add(tip);
  const tangent = new THREE.Vector3();
  const sampled = new SampledCurve(curve, 120);
  return {
    group,
    grow,
    curve,
    materials: [outerMaterial, innerMaterial, capOuterMaterial, capInnerMaterial],
    update() {
      const g = THREE.MathUtils.clamp(grow.value, 0, 1);
      tip.visible = g > 0.01;
      sampled.point(g, tip.position);
      sampled.tangent(g, tangent);
      tip.rotation.set(0, 0, Math.atan2(tangent.y, tangent.x));
    },
    dispose() {
      tube.dispose();
      edges.dispose();
      cap.dispose();
      capEdge.dispose();
    },
  };
}

/** A curve sampled once, so positions and tangents can be read every frame without allocating. */
export class SampledCurve {
  private readonly points: THREE.Vector3[] = [];
  private readonly tangents: THREE.Vector3[] = [];

  constructor(curve: THREE.Curve<THREE.Vector3>, samples = 200) {
    for (let i = 0; i <= samples; i++) {
      this.points.push(curve.getPointAt(i / samples));
      this.tangents.push(curve.getTangentAt(i / samples));
    }
  }

  point(u: number, target: THREE.Vector3): THREE.Vector3 {
    const f = THREE.MathUtils.clamp(u, 0, 1) * (this.points.length - 1);
    const i = Math.min(this.points.length - 2, Math.floor(f));
    return target.lerpVectors(this.points[i], this.points[i + 1], f - i);
  }

  tangent(u: number, target: THREE.Vector3): THREE.Vector3 {
    const f = THREE.MathUtils.clamp(u, 0, 1) * (this.tangents.length - 1);
    const i = Math.min(this.tangents.length - 2, Math.floor(f));
    return target.lerpVectors(this.tangents[i], this.tangents[i + 1], f - i).normalize();
  }
}
