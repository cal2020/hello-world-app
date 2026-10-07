import { useApp, useT } from '../app/store';
import { dismissToast } from '../app/actions';
import { Icon } from './icons';

export function Toasts() {
  const t = useT();
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" data-testid="toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast glass is-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
        >
          <p>{toast.message}</p>
          {toast.action && toast.actionLabel && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                dismissToast(toast.id);
                toast.action?.();
              }}
            >
              {toast.actionLabel}
            </button>
          )}
          <button type="button" className="btn btn-icon btn-ghost" aria-label={t.t('errors.dismiss')} onClick={() => dismissToast(toast.id)}>
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
