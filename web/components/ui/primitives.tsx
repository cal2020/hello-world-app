import * as RTooltip from '@radix-ui/react-tooltip';
import { Check, Copy, Loader2 } from 'lucide-react';
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { initials, ownerHue } from '../../lib/format';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'text-white bg-[linear-gradient(135deg,var(--brand),color-mix(in_oklab,var(--brand)_70%,var(--brand-2)))] shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_6px_20px_-6px_var(--glow)] hover:brightness-110',
  secondary: 'bg-panel-2 text-ink border border-line hover:bg-panel-3 hover:border-line-strong',
  ghost: 'text-dim hover:text-ink hover:bg-panel-2',
  danger: 'text-rose-600 dark:text-rose-300 border border-rose-500/25 bg-rose-500/8 hover:bg-rose-500/15',
  success:
    'text-white bg-[linear-gradient(135deg,#10b981,#0ea5a4)] shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_6px_20px_-8px_rgb(16_185_129/0.6)] hover:brightness-110',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all select-none whitespace-nowrap',
        'disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:brightness-100',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        className={cx('inline-flex size-8 items-center justify-center rounded-lg text-dim transition hover:bg-panel-2 hover:text-ink', className)}
        {...rest}
      >
        {children}
      </button>
    </Tip>
  );
}

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={250}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[80] max-w-xs rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-ink shadow-xl shadow-black/20"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-panel-2 px-1 text-[11px] text-dim">{children}</kbd>;
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code title={title} className={cx('rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[12px] text-dim ring-1 ring-line', className)}>
      {children}
    </code>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked; the text is selectable */
        }
      }}
    >
      {done ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </IconButton>
  );
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = ownerHue(name);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-panel"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue + 40) % 360} 75% 48%))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-panel', className)}>{children}</div>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">{children}</h3>
      {aside}
    </div>
  );
}

export function Callout({ tone = 'info', icon, title, children }: { tone?: 'info' | 'warn' | 'danger' | 'success'; icon?: ReactNode; title?: ReactNode; children?: ReactNode }) {
  const tones = {
    info: 'border-sky-500/20 bg-sky-500/6 text-sky-900 dark:text-sky-100',
    warn: 'border-amber-500/25 bg-amber-500/8 text-amber-900 dark:text-amber-100',
    danger: 'border-rose-500/25 bg-rose-500/8 text-rose-900 dark:text-rose-100',
    success: 'border-emerald-500/25 bg-emerald-500/8 text-emerald-900 dark:text-emerald-100',
  };
  return (
    <div className={cx('flex gap-3 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed', tones[tone])} role={tone === 'danger' ? 'alert' : undefined}>
      {icon && <span className="mt-0.5 shrink-0 opacity-80">{icon}</span>}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-dim', className)} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-panel-2', className)} />;
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; id: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-rose-600 dark:text-rose-300" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-dim">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none transition focus:border-[var(--brand)] focus:ring-3 focus:ring-[var(--glow)] aria-[invalid=true]:border-rose-500/60';
