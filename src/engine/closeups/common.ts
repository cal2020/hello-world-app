import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { disposeObject } from '../core/geometry';

/** A dark detail scene with soft, colourful lighting matching the whole-cell look. */
export function createCloseupScene(tint: THREE.ColorRepresentation = '#0b1022'): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = backgroundTexture(tint);
  scene.add(new THREE.HemisphereLight('#a8bfff', '#160c1e', 1.15));
  const key = new THREE.DirectionalLight('#ffffff', 1.7);
  key.position.set(4, 7, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#8a7dff', 1.1);
  rim.position.set(-6, -2, -5);
  scene.add(rim);
  const fill = new THREE.DirectionalLight('#ffd6b0', 0.45);
  fill.position.set(-3, 5, 4);
  scene.add(fill);
  return scene;
}

const textureCache = new Map<string, THREE.Texture>();
/** Radial-gradient backdrop drawn behind every scene (also appears in exported images). */
export function backgroundTexture(tint: THREE.ColorRepresentation): THREE.Texture {
  const key = new THREE.Color(tint).getHexString();
  const cached = textureCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(256, 236, 20, 256, 256, 380);
  const c = new THREE.Color(tint);
  g.addColorStop(0, `#${c.clone().multiplyScalar(1.6).getHexString()}`);
  g.addColorStop(0.55, `#${c.getHexString()}`);
  g.addColorStop(1, '#030409');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, texture);
  return texture;
}

/** A lumpy "protein blob" (Goodsell-style) of given radius. */
export function blobGeometry(radius: number, seed: string, roughness = 0.22, detail = 3): THREE.BufferGeometry {
  const noise = new Simplex3(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = noise.fbm(v.x * 1.8, v.y * 1.8, v.z * 1.8, 3);
    v.multiplyScalar(radius * (1 + n * roughness));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function material(color: THREE.ColorRepresentation, options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.14, roughness: 0.5, metalness: 0, ...options });
}

export function disposeScene(scene: THREE.Scene): void {
  disposeObject(scene);
}

export const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Repeating 0→1 phase for a period (seconds). */
export function cycle(time: number, period: number, offset = 0): number {
  return (((time + offset) % period) + period) % period / period;
}

export function smooth(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOut(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Window helper: 0 outside [a, b], ramps 0→1 over the first and last `ramp` fraction. */
export function window01(x: number, a: number, b: number, ramp = 0.08): number {
  if (x < a || x > b) return 0;
  const span = b - a;
  const u = (x - a) / span;
  return Math.min(1, u / ramp, (1 - u) / ramp);
}
