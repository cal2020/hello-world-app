import { TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Dialog } from './ui/dialog';
import { Button, Field, inputClass } from './ui/primitives';

/** A destructive action that names its target and asks for it to be typed. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmText,
  actionLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: ReactNode;
  confirmText: string;
  actionLabel: string;
  onConfirm: (typed: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === confirmText;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      icon={<TriangleAlert className="size-4.5 text-rose-500" />}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(typed.trim());
                setTyped('');
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="text-sm leading-relaxed text-dim">{body}</div>
        <Field id="confirm-input" label={`Type ${confirmText} to confirm`}>
          <input id="confirm-input" autoFocus autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
