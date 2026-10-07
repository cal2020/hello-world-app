import * as THREE from 'three';

export interface PickerOptions {
  dom: HTMLElement;
  camera: () => THREE.Camera;
  /** Return the identifier hit by the ray (or null). */
  pick: (ray: THREE.Ray) => string | null;
  onSelect: (id: string | null, pointerType: string) => void;
  onHover: (id: string | null, clientX: number, clientY: number) => void;
  enabled: () => boolean;
}

/**
 * Click/tap selection and hover feedback on the canvas. A press only counts
 * as a click if the pointer barely moved and was released quickly, so
 * orbiting never selects anything by accident.
 */
export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private down: { x: number; y: number; time: number; type: string; id: number } | null = null;
  private moved = false;
  private hoverTimer = 0;
  private lastHover: string | null = null;
  private pendingHover: { x: number; y: number } | null = null;
  private readonly options: PickerOptions;

  constructor(options: PickerOptions) {
    this.options = options;
    const dom = options.dom;
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointerleave', this.onLeave);
    dom.addEventListener('pointercancel', this.onCancel);
  }

  private rayAt(clientX: number, clientY: number): THREE.Ray {
    const rect = this.options.dom.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.options.camera());
    return this.raycaster.ray;
  }

  private onDown = (event: PointerEvent) => {
    if (!event.isPrimary) {
      this.down = null;
      return;
    }
    this.down = { x: event.clientX, y: event.clientY, time: performance.now(), type: event.pointerType, id: event.pointerId };
    this.moved = false;
  };

  private onMove = (event: PointerEvent) => {
    if (this.down && event.pointerId === this.down.id) {
      const limit = this.down.type === 'touch' ? 12 : 6;
      if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > limit) this.moved = true;
    }
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      this.pendingHover = { x: event.clientX, y: event.clientY };
      if (!this.hoverTimer) this.hoverTimer = window.setTimeout(this.flushHover, 70);
    }
  };

  private flushHover = () => {
    this.hoverTimer = 0;
    const pending = this.pendingHover;
    this.pendingHover = null;
    if (!pending || !this.options.enabled()) return;
    const id = this.options.pick(this.rayAt(pending.x, pending.y));
    if (id !== this.lastHover) this.lastHover = id;
    this.options.onHover(id, pending.x, pending.y);
  };

  private onUp = (event: PointerEvent) => {
    const down = this.down;
    this.down = null;
    if (!down || event.pointerId !== down.id || this.moved) return;
    if (performance.now() - down.time > 650) return;
    if (!this.options.enabled()) return;
    const id = this.options.pick(this.rayAt(event.clientX, event.clientY));
    this.options.onSelect(id, event.pointerType);
  };

  private onLeave = () => {
    this.pendingHover = null;
    if (this.lastHover !== null) {
      this.lastHover = null;
      this.options.onHover(null, 0, 0);
    }
  };

  private onCancel = () => {
    this.down = null;
  };

  dispose(): void {
    const dom = this.options.dom;
    dom.removeEventListener('pointerdown', this.onDown);
    dom.removeEventListener('pointermove', this.onMove);
    dom.removeEventListener('pointerup', this.onUp);
    dom.removeEventListener('pointerleave', this.onLeave);
    dom.removeEventListener('pointercancel', this.onCancel);
    window.clearTimeout(this.hoverTimer);
  }
}
