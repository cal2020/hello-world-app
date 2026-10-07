/**
 * Development and test switches read once from the address at start-up.
 * They are not persisted and are not part of shareable routes.
 *
 *   ?renderer=fail           simulate a 3D start-up failure (text atlas)
 *   ?simulate=locale-failure make non-English locale loading fail
 *   ?simulate=context-loss   lose the WebGL context 3 s after entering
 *   ?quality=low|medium|high force a quality level for this visit
 *   ?perf=1                  show the frame-time overlay
 */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();

export const debugParams = {
  renderer: params.get('renderer'),
  simulate: params.get('simulate'),
  quality: params.get('quality') as 'low' | 'medium' | 'high' | null,
  perf: params.get('perf') === '1',
};
