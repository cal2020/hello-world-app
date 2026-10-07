export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lg)" />
      <g stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.95">
        <path d="M9 10 L16 16 L23 10 M16 16 L16 23 M9 10 L9 22 M23 10 L23 22" fill="none" opacity="0.55" />
      </g>
      <g fill="white">
        <circle cx="9" cy="10" r="2.4" />
        <circle cx="23" cy="10" r="2.4" />
        <circle cx="16" cy="16" r="2.8" />
        <circle cx="16" cy="23" r="2.2" />
        <circle cx="9" cy="22" r="1.8" opacity="0.8" />
        <circle cx="23" cy="22" r="1.8" opacity="0.8" />
      </g>
    </svg>
  );
}
