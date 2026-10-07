import { useEffect, useRef } from 'react';
import { useApp, useT } from '../app/store';
import { setInspectView } from '../app/actions';
import { overlays } from '../app/engineBridge';

/**
 * In close-up views, a small picture of the whole cell marks where the
 * close-up comes from; the button returns to that location in the cell.
 * The renderer draws the picture into the canvas when the close-up opens.
 */
export function LocationInset() {
  const t = useT();
  const closeup = useApp((s) => s.route.page === 'cell' && !!s.route.structure && s.route.view === 'closeup');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    overlays.insetCanvas = canvas.current;
    return () => {
      overlays.insetCanvas = null;
    };
  });
  return (
    <div className="location-inset glass" hidden={!closeup} data-testid="location-inset">
      <canvas ref={canvas} width={300} height={300} role="img" aria-label={t.t('panel.locationInset')} />
      <button type="button" className="btn" onClick={() => setInspectView('cell')} data-testid="back-to-cell">
        {t.t('panel.backToCell')}
      </button>
    </div>
  );
}
