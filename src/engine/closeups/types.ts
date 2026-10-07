import type * as THREE from 'three';
import type { QualityLevel } from '../../app/quality';

export interface CloseupLabel {
  /** Part id (named via structures.<id>.parts.<part>.name) … */
  part?: string;
  /** … or an explicit locale key (event captions). */
  textKey?: string;
  anchor: () => THREE.Vector3;
}

export interface CloseupViewSpec {
  /** Camera framing in this close-up's own units (see the structure's closeup.views[].unitNm). */
  target: THREE.Vector3;
  radius: number;
  direction: THREE.Vector3;
  labels: CloseupLabel[];
}

export interface CloseupContext {
  quality: QualityLevel;
  /** Pixels per scene unit at distance 1, for point sprites. */
  pointScale: { value: number };
}

/**
 * A dedicated detail scene at molecular/organelle scale, loaded on demand.
 * `update` receives biological time (dt = 0 while frozen) so the freeze
 * control applies to close-ups too.
 */
export interface CloseupScene {
  scene: THREE.Scene;
  views: CloseupViewSpec[];
  setView(index: number): void;
  update(dt: number, time: number, calm: boolean): void;
  dispose(): void;
}

export type CloseupFactory = (ctx: CloseupContext) => CloseupScene;
