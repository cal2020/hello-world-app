import type * as THREE from 'three';
import { AutoQualityController, defaultAutoConfig, type QualityLevel } from '../../app/quality';

/**
 * Frame-time measurement, automatic quality changes (with hysteresis, see
 * AutoQualityController) and an optional overlay (?perf=1) that shows the
 * frame rate, frame time, draw calls and triangles.
 */
export class PerfMonitor {
  private controller: AutoQualityController | null = null;
  private overlay: HTMLDivElement | null = null;
  private frames = 0;
  private time = 0;
  private fps = 0;
  private worst = 0;
  readonly targetFps: number;

  constructor(showOverlay: boolean, coarsePointer: boolean) {
    this.targetFps = coarsePointer ? 30 : 60;
    if (showOverlay) {
      this.overlay = document.createElement('div');
      this.overlay.setAttribute('aria-hidden', 'true');
      this.overlay.dataset.testid = 'perf-overlay';
      Object.assign(this.overlay.style, {
        position: 'fixed',
        right: '8px',
        top: '76px',
        zIndex: '200',
        font: '12px/1.4 ui-monospace, monospace',
        color: '#c8ffda',
        background: 'rgba(0,0,0,0.65)',
        padding: '6px 8px',
        borderRadius: '6px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      });
      document.body.appendChild(this.overlay);
    }
  }

  setAuto(enabled: boolean, level: QualityLevel): void {
    if (enabled && !this.controller) this.controller = new AutoQualityController(level, defaultAutoConfig(this.targetFps));
    else if (!enabled) this.controller = null;
    else if (this.controller) this.controller.level = level;
  }

  /** Record a frame; returns a new automatic quality level when one is chosen. */
  sample(frameMs: number, renderer: THREE.WebGLRenderer, quality: QualityLevel): QualityLevel | null {
    this.frames++;
    this.time += frameMs;
    this.worst = Math.max(this.worst, frameMs);
    if (this.time >= 1000) {
      this.fps = (this.frames * 1000) / this.time;
      if (this.overlay) {
        const info = renderer.info.render;
        this.overlay.textContent = `${this.fps.toFixed(1)} fps  (${(this.time / this.frames).toFixed(1)} ms avg, ${this.worst.toFixed(1)} worst)\nquality ${quality}${this.controller ? ' (auto)' : ''}\ncalls ${info.calls}  tris ${info.triangles.toLocaleString('en')}`;
      }
      this.frames = 0;
      this.time = 0;
      this.worst = 0;
    }
    return this.controller ? this.controller.sample(frameMs) : null;
  }

  get currentFps(): number {
    return this.fps;
  }

  dispose(): void {
    this.overlay?.remove();
  }
}
