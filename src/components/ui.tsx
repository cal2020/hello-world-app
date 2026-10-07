import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info, Loader2, X } from "lucide-react";
import type { Severity } from "../../shared/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-[0_6px_20px_-8px_var(--accent)] hover:brightness-110 active:brightness-95 border border-white/10",
  secondary: "bg-panel-2 text-fg border border-line hover:border-line-strong hover:bg-panel-solid",
  ghost: "text-fg-2 hover:text-fg hover:bg-panel-2 border border-transparent",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:bg-danger hover:text-white",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 select-none whitespace-nowrap",
          "disabled:opacity-45 disabled:pointer-events-none",
          size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-[13px]",
          variants[variant],
          className,
        )}
        {...rest}
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    );
  },
);

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx("inline-flex size-8 items-center justify-center rounded-lg text-fg-2 transition hover:bg-panel-2 hover:text-fg disabled:opacity-40", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

const sevStyle: Record<string, string> = {
  error: "bg-danger-soft text-danger border-danger/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  info: "bg-info-soft text-info border-info/25",
  off: "bg-panel-2 text-fg-3 border-line",
};

export function SeverityBadge({ severity }: { severity: Severity | string }) {
  return <span className={cx("inline-flex h-5 items-center rounded-md border px-1.5 text-[11px] font-semibold uppercase tracking-wide", sevStyle[severity] ?? sevStyle.off)}>{severity === "warn" ? "warning" : severity}</span>;
}

export function Badge({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: "neutral" | "accent" | "danger" | "warn" | "ok" | "info"; className?: string; title?: string }) {
  const tones = {
    neutral: "bg-panel-2 text-fg-2 border-line",
    accent: "bg-accent-soft text-accent border-accent/25",
    danger: "bg-danger-soft text-danger border-danger/25",
    warn: "bg-warn-soft text-warn border-warn/25",
    ok: "bg-ok-soft text-ok border-ok/25",
    info: "bg-info-soft text-info border-info/25",
  };
  return (
    <span title={title} className={cx("inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-panel-2 px-1 text-[10.5px] text-fg-3">{children}</kbd>;
}

export function Path({ value, className, strong }: { value: string; className?: string; strong?: boolean }) {
  const i = value.lastIndexOf("/");
  return (
    <span className={cx("mono min-w-0 truncate text-[12.5px]", className)} title={value}>
      {i >= 0 && <span className="text-fg-3">{value.slice(0, i + 1)}</span>}
      <span className={strong ? "font-semibold text-fg" : "text-fg"}>{value.slice(i + 1)}</span>
    </span>
  );
}

export function Notice({ level, title, children, onClose }: { level: "info" | "warn" | "error"; title: ReactNode; children?: ReactNode; onClose?: () => void }) {
  const Icon = level === "error" ? CircleAlert : level === "warn" ? AlertTriangle : Info;
  const tone = level === "error" ? "border-danger/30 bg-danger-soft" : level === "warn" ? "border-warn/30 bg-warn-soft" : "border-info/25 bg-info-soft";
  const ic = level === "error" ? "text-danger" : level === "warn" ? "text-warn" : "text-info";
  return (
    <div role={level === "error" ? "alert" : "status"} className={cx("flex gap-2.5 rounded-xl border px-3 py-2.5 text-[13px]", tone)}>
      <Icon className={cx("mt-0.5 size-4 shrink-0", ic)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{title}</div>
        {children && <div className="mt-0.5 text-fg-2">{children}</div>}
      </div>
      {onClose && (
        <button aria-label="Dismiss" onClick={onClose} className="self-start rounded p-0.5 text-fg-3 hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-fg-2">
        {label}
      </label>
      {children}
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] text-fg-3">{hint}</p> : null}
    </div>
  );
}

export const inputCls =
  "h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25";

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx("h-7 rounded-md px-2.5 text-[12px] font-medium transition", value === o.value ? "bg-panel-solid text-fg shadow-sm" : "text-fg-3 hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-fg-2 select-none">
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx("relative h-[18px] w-8 rounded-full transition", checked ? "bg-accent" : "bg-line-strong")}
      >
        <span className={cx("absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-all", checked ? "left-[16px]" : "left-[2px]")} />
      </button>
      {label}
    </label>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input,button,textarea,select");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("input,button,textarea,select,a[href]")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) (e.preventDefault(), f[0].focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx("rise glass w-full rounded-2xl bg-panel-solid", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-line bg-panel-2 text-accent">{icon}</div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-[13px] text-fg-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
