import type { PlacedLabel } from '../labels/LabelLayer';

export interface ExportScale {
  barPx: number;
  text: string;
  context: string;
  note: string;
}

export interface ExportRequest {
  /** Draws the current camera view into the WebGL canvas at the export pixel ratio and returns that canvas. */
  renderFrame: () => HTMLCanvasElement;
  mode: 'clean' | 'annotated';
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
  labels: PlacedLabel[];
  scale: ExportScale;
  title: string;
  caption: string;
  scaleNote: string;
  filename: string;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Produce a PNG of the current view. The WebGL frame is captured right after
 * it is rendered (same task), then labels, the physical scale bar and a
 * caption are composited for the annotated mode.
 */
export async function renderExport(request: ExportRequest): Promise<Blob> {
  const source = request.renderFrame();
  const width = source.width;
  const height = source.height;
  if (!width || !height) throw new Error('The 3D view has no size');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.drawImage(source, 0, 0);

  if (request.mode === 'annotated') {
    const s = width / request.cssWidth;
    ctx.save();
    ctx.scale(s, s);
    const font = "'Alegreya Sans', 'Noto Sans SC', system-ui, sans-serif";
    const display = "'Alegreya', 'Noto Sans SC', Georgia, serif";
    // Labels with leader lines.
    for (const label of request.labels) {
      ctx.strokeStyle = 'rgba(236, 239, 247, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const lx = Math.min(Math.max(label.anchorX, label.x), label.x + label.width);
      const ly = Math.min(Math.max(label.anchorY, label.y), label.y + label.height);
      ctx.moveTo(label.anchorX, label.anchorY);
      ctx.lineTo(lx, ly);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(label.anchorX, label.anchorY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(8, 10, 18, 0.85)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      roundRect(ctx, label.x, label.y, label.width, label.height, label.height / 2);
      ctx.fill();
      ctx.stroke();
      let textX = label.x + 10;
      if (label.color) {
        ctx.fillStyle = label.color;
        ctx.beginPath();
        ctx.arc(label.x + 14, label.y + label.height / 2, 4, 0, Math.PI * 2);
        ctx.fill();
        textX = label.x + 24;
      }
      ctx.fillStyle = '#eceff7';
      ctx.font = `500 14px ${font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(label.text, textX, label.y + label.height / 2 + 0.5, label.width - (textX - label.x) - 8);
    }
    // Scale bar (bottom left).
    const pad = 20;
    const boxW = Math.max(request.scale.barPx + 120, 230);
    const boxH = request.scale.note ? 82 : 64;
    const bx = pad;
    const by = request.cssHeight - pad - boxH;
    ctx.fillStyle = 'rgba(8, 10, 18, 0.82)';
    roundRect(ctx, bx, by, boxW, boxH, 10);
    ctx.fill();
    ctx.strokeStyle = '#eceff7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx + 14, by + 16);
    ctx.lineTo(bx + 14, by + 26);
    ctx.lineTo(bx + 14 + request.scale.barPx, by + 26);
    ctx.lineTo(bx + 14 + request.scale.barPx, by + 16);
    ctx.stroke();
    ctx.fillStyle = '#eceff7';
    ctx.font = `600 16px ${display}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(request.scale.text, bx + 24 + request.scale.barPx, by + 21);
    ctx.fillStyle = '#b8c0d5';
    ctx.font = `400 12px ${font}`;
    ctx.fillText(`${request.scale.context} · ${request.scaleNote}`, bx + 14, by + 44, boxW - 28);
    if (request.scale.note) {
      ctx.fillStyle = '#f7c97e';
      ctx.fillText(request.scale.note, bx + 14, by + 62, boxW - 28);
    }
    // Caption (top left).
    ctx.fillStyle = 'rgba(8, 10, 18, 0.7)';
    ctx.font = `700 22px ${display}`;
    const titleWidth = ctx.measureText(request.title).width;
    ctx.font = `400 13px ${font}`;
    const captionWidth = ctx.measureText(request.caption).width;
    roundRect(ctx, pad, pad, Math.max(titleWidth, captionWidth) + 28, 62, 10);
    ctx.fill();
    ctx.fillStyle = '#eceff7';
    ctx.font = `700 22px ${display}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(request.title, pad + 14, pad + 30);
    ctx.fillStyle = '#b8c0d5';
    ctx.font = `400 13px ${font}`;
    ctx.fillText(request.caption, pad + 14, pad + 50);
    ctx.restore();
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the PNG'))), 'image/png');
  });
}

/** Trigger a download and release the object URL afterwards. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
