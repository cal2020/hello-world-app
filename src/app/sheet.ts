import type { SheetState } from './store';

/** Bottom-sheet heights for the phone (portrait) layout. */
export function sheetHeight(sheet: SheetState, viewportHeight: number, topbar = 52): number {
  if (sheet === 'collapsed') return 148;
  if (sheet === 'half') return Math.round(viewportHeight * 0.5);
  return Math.max(200, viewportHeight - topbar - 22);
}
