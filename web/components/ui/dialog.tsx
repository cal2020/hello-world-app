import * as RDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './primitives';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <RDialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-[70] flex max-h-[min(88vh,820px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl shadow-black/30 outline-none',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 pt-5 pb-4">
            {icon && <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-panel-2 ring-1 ring-line">{icon}</div>}
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-[15px] font-semibold tracking-tight">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-[13px] leading-relaxed text-dim">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">Dialog</RDialog.Description>
              )}
            </div>
            <RDialog.Close className="rounded-lg p-1.5 text-dim hover:bg-panel-2 hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-panel-2/50 px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
