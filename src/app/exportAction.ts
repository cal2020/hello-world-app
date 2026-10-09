import { appStore } from './store';
import { closeModal, dismissToast, pushToast } from './actions';
import { getEngineController } from './engineBridge';

/**
 * Image export can be left out of a build (VITE_EXPORT=off) for hosts that block
 * downloads, such as an embedded demo, so the atlas never reports a save that did not happen.
 */
export const EXPORT_AVAILABLE: boolean = import.meta.env?.VITE_EXPORT !== 'off';

/** Save a PNG of the current view and report the result (or the error) in a toast. */
export async function exportImage(mode: 'clean' | 'annotated'): Promise<void> {
  const t = appStore.getState().translator;
  const engine = getEngineController();
  closeModal();
  if (!engine) {
    pushToast({ kind: 'error', message: t.t('export.unavailable') });
    return;
  }
  const progressToast = pushToast({ kind: 'info', message: t.t('export.saving') }, 0);
  try {
    const { filename } = await engine.exportImage(mode);
    dismissToast(progressToast);
    pushToast({ kind: 'success', message: t.t('export.saved', { file: filename }) });
  } catch (error) {
    dismissToast(progressToast);
    const reason = error instanceof Error ? error.message : String(error);
    pushToast({ kind: 'error', message: t.t('export.failed', { reason }) });
  }
}
