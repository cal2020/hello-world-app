import * as THREE from 'three';
import CameraControls from 'camera-controls';
import type { ViewInsets } from '../../app/engineBridge';

CameraControls.install({
  THREE: {
    Vector2: THREE.Vector2,
    Vector3: THREE.Vector3,
    Vector4: THREE.Vector4,
    Quaternion: THREE.Quaternion,
    Matrix4: THREE.Matrix4,
    Spherical: THREE.Spherical,
    Box3: THREE.Box3,
    Sphere: THREE.Sphere,
    Raycaster: THREE.Raycaster,
  },
});

export interface FramingRequest {
  /** Use the direction as given (no nudge toward the current view). */
  exact?: boolean;
  target: THREE.Vector3;
  radius: number;
  direction?: THREE.Vector3;
  /** Multiplier on the fitted distance (>1 = farther). */
  margin?: number;
}

export interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

interface Tween {
  from: Pose;
  to: Pose;
  elapsed: number;
  duration: number;
  onArrive?: () => void;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Camera navigation: drag to orbit, wheel/pinch to zoom (camera-controls),
 * plus cinematic, cancellable transitions between framings. A new transition
 * replaces the current one; any direct manipulation cancels it immediately.
 * A view offset centres the subject in the part of the screen not covered by
 * panels; the scale is unaffected (the full image size is kept).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: CameraControls;
  private tween: Tween | null = null;
  private insets: ViewInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  private width = 1;
  private height = 1;
  private userInteracting = false;
  /** Called when the user starts dragging/zooming (cancels transitions). */
  onUserInput: (() => void) | null = null;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    const controls = new CameraControls(camera, dom);
    controls.smoothTime = 0.14;
    controls.draggingSmoothTime = 0.06;
    controls.dollySpeed = 0.7;
    controls.azimuthRotateSpeed = 0.9;
    controls.polarRotateSpeed = 0.9;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI - 0.12;
    controls.dollyToCursor = false;
    controls.infinityDolly = false;
    const A = CameraControls.ACTION;
    controls.mouseButtons.left = A.ROTATE;
    controls.mouseButtons.middle = A.DOLLY;
    controls.mouseButtons.right = A.NONE;
    controls.mouseButtons.wheel = A.DOLLY;
    controls.touches.one = A.TOUCH_ROTATE;
    controls.touches.two = A.TOUCH_DOLLY;
    controls.touches.three = A.NONE;
    controls.addEventListener('controlstart', () => {
      this.userInteracting = true;
      if (this.tween) this.cancelTransition();
      this.onUserInput?.();
    });
    controls.addEventListener('controlend', () => {
      this.userInteracting = false;
    });
    this.controls = controls;
  }

  get interacting(): boolean {
    return this.userInteracting;
  }

  get transitioning(): boolean {
    return this.tween !== null;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.applyViewOffset();
  }

  setInsets(insets: ViewInsets): void {
    this.insets = { ...insets };
    this.applyViewOffset();
  }

  /** Shift the projection so the orbit target appears centred in the unobstructed region. */
  private applyViewOffset(): void {
    const { left, right, top, bottom } = this.clampedInsets();
    const dx = (left - right) / 2;
    const dy = (top - bottom) / 2;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, -dx, -dy, this.width, this.height);
    this.camera.updateProjectionMatrix();
  }

  private clampedInsets(): ViewInsets {
    const maxX = this.width * 0.7;
    const maxY = this.height * 0.75;
    const i = this.insets;
    const scaleX = i.left + i.right > maxX ? maxX / (i.left + i.right) : 1;
    const scaleY = i.top + i.bottom > maxY ? maxY / (i.top + i.bottom) : 1;
    return { left: i.left * scaleX, right: i.right * scaleX, top: i.top * scaleY, bottom: i.bottom * scaleY };
  }

  /** Panel insets currently applied (clamped). */
  currentInsets(): ViewInsets {
    return this.clampedInsets();
  }

  /** Visible (unobstructed) viewport size in CSS pixels. */
  visibleSize(): { width: number; height: number } {
    const i = this.clampedInsets();
    return { width: Math.max(80, this.width - i.left - i.right), height: Math.max(80, this.height - i.top - i.bottom) };
  }

  /** Camera distance at which a sphere of `radius` fits the unobstructed region. */
  fitDistance(radius: number, margin = 1.12): number {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const visible = this.visibleSize();
    const vEff = 2 * Math.atan(Math.tan(vfov / 2) * (visible.height / this.height));
    const hEff = 2 * Math.atan(Math.tan(vfov / 2) * (this.width / this.height) * (visible.width / this.width));
    const fov = Math.min(vEff, hEff);
    return (radius / Math.sin(fov / 2)) * margin;
  }

  pose(): Pose {
    const target = new THREE.Vector3();
    this.controls.getTarget(target);
    return { position: this.camera.position.clone(), target };
  }

  target(): THREE.Vector3 {
    return this.controls.getTarget(new THREE.Vector3());
  }

  distance(): number {
    return this.controls.distance;
  }

  /** Pose that frames a request, keeping the current viewing side where possible. */
  poseFor(request: FramingRequest): Pose {
    const current = this.pose();
    const fromCurrent = current.position.clone().sub(current.target).normalize();
    let dir: THREE.Vector3;
    if (request.direction && request.exact) {
      dir = request.direction.clone().normalize();
    } else if (request.direction) {
      // Mostly the preferred direction, nudged toward the current view to limit swinging.
      dir = request.direction.clone().normalize().multiplyScalar(0.8).addScaledVector(fromCurrent, 0.2).normalize();
    } else {
      dir = fromCurrent;
    }
    const distance = this.fitDistance(request.radius, request.margin ?? 1.12);
    return { target: request.target.clone(), position: request.target.clone().addScaledVector(dir, distance) };
  }

  /** Travel time: about 1–3 s depending on how far the camera moves and turns. */
  durationFor(to: Pose): number {
    const from = this.pose();
    const travel = from.target.distanceTo(to.target);
    const d0 = from.position.distanceTo(from.target);
    const d1 = to.position.distanceTo(to.target);
    const zoom = Math.abs(Math.log(Math.max(0.01, d1) / Math.max(0.01, d0)));
    const a = from.position.clone().sub(from.target).normalize();
    const b = to.position.clone().sub(to.target).normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    const effort = travel / 6 + zoom / 1.4 + angle / Math.PI;
    return THREE.MathUtils.clamp(0.9 + effort * 1.1, 1.0, 3.0);
  }

  /** Start (or replace) a transition. duration 0 = cut immediately (reduced motion). */
  transitionTo(to: Pose, duration: number, onArrive?: () => void): void {
    this.tween = null;
    if (duration <= 0) {
      this.controls.setLookAt(to.position.x, to.position.y, to.position.z, to.target.x, to.target.y, to.target.z, false);
      this.controls.update(0);
      onArrive?.();
      return;
    }
    this.tween = { from: this.pose(), to: { position: to.position.clone(), target: to.target.clone() }, elapsed: 0, duration, onArrive };
  }

  cancelTransition(): void {
    this.tween = null;
  }

  setDistanceLimits(min: number, max: number): void {
    this.controls.minDistance = min;
    this.controls.maxDistance = max;
  }

  zoom(direction: 1 | -1): void {
    const factor = direction > 0 ? 0.75 : 1 / 0.75;
    const next = THREE.MathUtils.clamp(this.controls.distance * factor, this.controls.minDistance, this.controls.maxDistance);
    this.cancelTransition();
    void this.controls.dollyTo(next, true);
  }

  /** Advance transitions / damping. Returns true while the camera is moving. */
  update(dt: number): boolean {
    if (this.tween) {
      const tw = this.tween;
      tw.elapsed += dt;
      const t = Math.min(1, tw.elapsed / tw.duration);
      const e = easeInOutCubic(t);
      const target = tw.from.target.clone().lerp(tw.to.target, e);
      const fromOffset = tw.from.position.clone().sub(tw.from.target);
      const toOffset = tw.to.position.clone().sub(tw.to.target);
      const d0 = Math.max(1e-3, fromOffset.length());
      const d1 = Math.max(1e-3, toOffset.length());
      const q = new THREE.Quaternion().setFromUnitVectors(fromOffset.clone().normalize(), toOffset.clone().normalize());
      const dir = fromOffset.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, e));
      // Pull back slightly mid-flight on long journeys so the path does not skim through structures.
      const lift = Math.sin(Math.PI * e) * Math.min(0.35, tw.from.target.distanceTo(tw.to.target) / 20);
      const dist = Math.exp(THREE.MathUtils.lerp(Math.log(d0), Math.log(d1), e)) * (1 + lift);
      const position = target.clone().addScaledVector(dir, dist);
      this.controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
      this.controls.update(dt);
      if (t >= 1) {
        this.tween = null;
        tw.onArrive?.();
      }
      return true;
    }
    return this.controls.update(dt);
  }

  dispose(): void {
    this.controls.dispose();
  }
}
