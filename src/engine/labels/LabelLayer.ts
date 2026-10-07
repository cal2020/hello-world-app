import * as THREE from 'three';
import type { ViewInsets } from '../../app/engineBridge';

export interface LabelSpec {
  key: string;
  text: string;
  color?: string;
  /** 'structure' labels select their structure; 'part' labels are informational. */
  kind: 'structure' | 'part';
  structureId?: string;
  anchors: () => THREE.Vector3[];
  priority: number;
}

interface LabelState {
  spec: LabelSpec;
  el: HTMLElement;
  dot: HTMLDivElement;
  line: SVGLineElement;
  width: number;
  height: number;
  anchorIndex: number | null;
  visibleCheckFrame: number;
  shown: boolean;
}

export interface PlacedLabel {
  text: string;
  color?: string;
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const OFFSETS: Array<[number, number]> = [
  [16, -34],
  [-16, -34],
  [16, 14],
  [-16, 14],
  [30, -60],
  [-30, -60],
  [34, 30],
  [-34, 30],
];

/**
 * Screen-space labels. Each label projects its anchor every frame, avoids
 * overlapping higher-priority labels by trying candidate offsets, stays
 * inside the unobstructed viewport, hides when its anchor is occluded or off
 * screen, and draws a leader line. Structure labels are buttons that select
 * their structure (the list is the keyboard-accessible equivalent).
 */
export class LabelLayer {
  private states = new Map<string, LabelState>();
  private frame = 0;
  private placed: PlacedLabel[] = [];
  private readonly container: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly onSelect: (id: string) => void;
  private readonly onHover: (id: string | null) => void;

  constructor(container: HTMLDivElement, svg: SVGSVGElement, onSelect: (id: string) => void, onHover: (id: string | null) => void) {
    this.container = container;
    this.svg = svg;
    this.onSelect = onSelect;
    this.onHover = onHover;
  }

  setLabels(specs: LabelSpec[]): void {
    const keep = new Set(specs.map((s) => s.key));
    for (const [key, state] of this.states) {
      if (!keep.has(key)) {
        state.el.remove();
        state.dot.remove();
        state.line.remove();
        this.states.delete(key);
      }
    }
    for (const spec of specs) {
      const existing = this.states.get(spec.key);
      if (existing) {
        existing.spec = spec;
        const textEl = existing.el.querySelector('.label-text');
        if (textEl && textEl.textContent !== spec.text) {
          textEl.textContent = spec.text;
          existing.width = 0;
        }
        continue;
      }
      const el = document.createElement(spec.kind === 'structure' ? 'button' : 'div');
      el.className = `scene-label${spec.kind === 'part' ? ' is-part' : ''}`;
      el.tabIndex = -1;
      el.dataset.label = spec.key;
      if (spec.structureId) el.dataset.structure = spec.structureId;
      if (spec.color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = spec.color;
        el.appendChild(dot);
      }
      const text = document.createElement('span');
      text.className = 'label-text';
      text.textContent = spec.text;
      el.appendChild(text);
      if (spec.kind === 'structure' && spec.structureId) {
        const id = spec.structureId;
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          this.onSelect(id);
        });
        el.addEventListener('pointerenter', () => this.onHover(id));
        el.addEventListener('pointerleave', () => this.onHover(null));
      }
      el.hidden = true;
      this.container.appendChild(el);
      const anchorDot = document.createElement('div');
      anchorDot.className = 'anchor-dot';
      anchorDot.hidden = true;
      this.container.appendChild(anchorDot);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.style.display = 'none';
      this.svg.appendChild(line);
      this.states.set(spec.key, { spec, el, dot: anchorDot, line, width: 0, height: 0, anchorIndex: null, visibleCheckFrame: -1, shown: false });
    }
  }

  clear(): void {
    this.setLabels([]);
  }

  /** Labels as currently drawn (for the annotated image export). */
  snapshot(): PlacedLabel[] {
    return this.placed.map((p) => ({ ...p }));
  }

  update(
    camera: THREE.Camera,
    width: number,
    height: number,
    insets: ViewInsets,
    visible: boolean,
    isOccluded: (point: THREE.Vector3) => boolean,
    hovered: string | null,
  ): void {
    this.frame++;
    this.placed = [];
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    const states = [...this.states.values()].sort((a, b) => b.spec.priority - a.spec.priority);
    const projected = new THREE.Vector3();
    const minX = insets.left + 6;
    const maxX = width - insets.right - 6;
    const minY = insets.top + 6;
    const maxY = height - insets.bottom - 6;

    for (const state of states) {
      let show = visible;
      let ax = 0;
      let ay = 0;
      if (show) {
        // Anchors move (animated objects), so positions are read every frame;
        // which anchor to use (and occlusion) is re-evaluated a few times per second.
        const anchors = state.spec.anchors();
        if (this.frame - state.visibleCheckFrame > 8 || state.anchorIndex === null || state.anchorIndex >= anchors.length) {
          state.visibleCheckFrame = this.frame + Math.floor(Math.random() * 3);
          state.anchorIndex = null;
          for (let i = 0; i < anchors.length; i++) {
            const anchor = anchors[i];
            projected.copy(anchor).project(camera);
            if (projected.z > 1 || projected.z < -1) continue;
            const sx = (projected.x * 0.5 + 0.5) * width;
            const sy = (-projected.y * 0.5 + 0.5) * height;
            if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
            if (isOccluded(anchor)) continue;
            state.anchorIndex = i;
            break;
          }
        }
        const anchor = state.anchorIndex !== null ? anchors[state.anchorIndex] : undefined;
        if (!anchor) show = false;
        else {
          projected.copy(anchor).project(camera);
          ax = (projected.x * 0.5 + 0.5) * width;
          ay = (-projected.y * 0.5 + 0.5) * height;
          if (projected.z > 1 || ax < minX || ax > maxX || ay < minY || ay > maxY) show = false;
        }
      }
      let placedBox: { x: number; y: number; w: number; h: number } | null = null;
      if (show) {
        if (!state.width) {
          state.el.hidden = false;
          state.width = state.el.offsetWidth || 120;
          state.height = state.el.offsetHeight || 30;
        }
        for (const [ox, oy] of OFFSETS) {
          const x = ox >= 0 ? ax + ox : ax + ox - state.width;
          const y = ay + oy;
          const box = { x, y, w: state.width, h: state.height };
          if (box.x < minX || box.x + box.w > maxX || box.y < minY || box.y + box.h > maxY) continue;
          if (boxes.some((b) => b.x < box.x + box.w + 4 && box.x < b.x + b.w + 4 && b.y < box.y + box.h + 4 && box.y < b.y + b.h + 4)) continue;
          placedBox = box;
          break;
        }
      }
      if (!placedBox) {
        if (state.shown) {
          state.el.hidden = true;
          state.dot.hidden = true;
          state.line.style.display = 'none';
          state.shown = false;
        } else {
          state.el.hidden = true;
        }
        continue;
      }
      boxes.push(placedBox);
      state.shown = true;
      state.el.hidden = false;
      state.dot.hidden = false;
      state.el.style.transform = `translate3d(${placedBox.x.toFixed(1)}px, ${placedBox.y.toFixed(1)}px, 0)`;
      state.dot.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0)`;
      state.el.classList.toggle('is-hovered', !!state.spec.structureId && hovered === state.spec.structureId);
      // Leader line from the anchor to the nearest point on the label box.
      const lx = THREE.MathUtils.clamp(ax, placedBox.x, placedBox.x + placedBox.w);
      const ly = THREE.MathUtils.clamp(ay, placedBox.y, placedBox.y + placedBox.h);
      state.line.style.display = '';
      state.line.setAttribute('x1', ax.toFixed(1));
      state.line.setAttribute('y1', ay.toFixed(1));
      state.line.setAttribute('x2', lx.toFixed(1));
      state.line.setAttribute('y2', ly.toFixed(1));
      this.placed.push({
        text: state.spec.text,
        color: state.spec.color,
        anchorX: ax,
        anchorY: ay,
        x: placedBox.x,
        y: placedBox.y,
        width: placedBox.w,
        height: placedBox.h,
      });
    }
  }

  dispose(): void {
    this.clear();
  }
}
