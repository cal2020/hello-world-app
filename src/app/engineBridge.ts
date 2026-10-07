/**
 * Narrow interface between the React interface and the renderer. The
 * renderer registers a controller when it starts; interface controls call it.
 * Overlay elements (labels, scale bar, hover tip, location inset) are
 * rendered by React once and then updated directly by the renderer each
 * frame, so fast-changing values never go through React state.
 */

export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EngineController {
  /** Start the cutaway "Enter the cell" transition (instant with reduced motion). */
  enter(): void;
  zoom(direction: 1 | -1): void;
  resetView(): void;
  setInsets(insets: ViewInsets): void;
  exportImage(mode: 'clean' | 'annotated'): Promise<{ filename: string }>;
}

export interface OverlayElements {
  labelLayer: HTMLDivElement | null;
  leaderLayer: SVGSVGElement | null;
  hoverTip: HTMLDivElement | null;
  scaleRoot: HTMLDivElement | null;
  scaleBar: HTMLDivElement | null;
  scaleLength: HTMLSpanElement | null;
  scaleContext: HTMLDivElement | null;
  scaleNote: HTMLDivElement | null;
  insetCanvas: HTMLCanvasElement | null;
}

export const overlays: OverlayElements = {
  labelLayer: null,
  leaderLayer: null,
  hoverTip: null,
  scaleRoot: null,
  scaleBar: null,
  scaleLength: null,
  scaleContext: null,
  scaleNote: null,
  insetCanvas: null,
};

let controller: EngineController | null = null;
let latestInsets: ViewInsets = { left: 0, right: 0, top: 0, bottom: 0 };
const listeners = new Set<() => void>();

export function setEngineController(next: EngineController | null): void {
  controller = next;
  if (next) next.setInsets(latestInsets);
  listeners.forEach((fn) => fn());
}

export function getEngineController(): EngineController | null {
  return controller;
}

export function onEngineControllerChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publishInsets(insets: ViewInsets): void {
  latestInsets = insets;
  controller?.setInsets(insets);
}

export function currentInsets(): ViewInsets {
  return latestInsets;
}
