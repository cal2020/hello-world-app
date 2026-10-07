import { appStore } from './store';
import { closeModal, dismissToast, pushToast } from './actions';
import { getEngineController } from './engineBridge';

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
