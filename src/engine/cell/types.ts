import type * as THREE from 'three';
import type { StructureId } from '../../content/types';
import type { QualityLevel } from '../../app/quality';
import type { CutUniforms, FocusHandle } from '../core/materials';
import type { CellLayout } from './layout';

/** How the camera should frame a structure when it is selected. */
export interface Framing {
  target: THREE.Vector3;
  /** Radius of the region to keep in view, in µm. */
  radius: number;
  /** Preferred viewing direction (from target toward camera); optional. */
  direction?: THREE.Vector3;
}

export interface PartAnchor {
  part: string;
  position: THREE.Vector3;
  /** Optional locale key used instead of the part name (e.g. an event caption). */
  textKey?: string;
}

export interface BuildContext {
  layout: CellLayout;
  cuts: { membrane: CutUniforms; nucleus: CutUniforms };
  /** Shared uniform holding biological time in seconds (stops when frozen). */
  time: { value: number };
  /** Pixels per scene unit at distance 1 (for point sprites); updated on resize. */
  pointScale: { value: number };
  /** Highest quality is built; lower levels draw subsets. */
  maxQuality: QualityLevel;
}

export interface UpdateContext {
  camera: THREE.Camera;
  selected: StructureId | null;
  /** True when ambient/decorative motion should stop (reduced motion). */
  calm: boolean;
  /** Real seconds since the last frame (interface transitions; keeps running while biology is frozen). */
  uiDt: number;
  /** Interface transitions should be instant (reduced motion). */
  instant: boolean;
}

/**
 * The consistent interface every structure implements: scene objects, focus
 * handling, picking, camera framing, label anchors, animation, quality and
 * cleanup. Close-up views are separate lazy-loaded scenes (see closeups/).
 */
export interface StructureInstance {
  id: StructureId;
  root: THREE.Object3D;
  /** Materials controlled by the focus system. */
  focus: FocusHandle[];
  /** Opacity used in the overview (structures that would hide others are translucent). */
  overviewOpacity: number;
  /** Ray test against visible geometry; distance along the ray or null. */
  raycast(ray: THREE.Ray): number | null;
  framing(): Framing;
  /** Candidate label positions in priority order; the first visible one is used. */
  labelAnchors(): THREE.Vector3[];
  /** Labelled parts shown while the structure is focused. */
  partAnchors(): PartAnchor[];
  /** dt and time are biological seconds (dt = 0 while frozen). */
  update(dt: number, time: number, ctx: UpdateContext): void;
  /** Show fewer repeated objects at lower quality; returns the number drawn (or null). */
  setQuality(level: QualityLevel): number | null;
  /** Called when the structure gains or loses focus (e.g. reveal internal detail). */
  setFocused(focused: boolean): void;
  dispose(): void;
}
