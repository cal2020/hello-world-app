/** Two tracks converging onto one mainline. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="sy-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-2)" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="url(#sy-g)" />
      <path d="M7 9.5c5 0 6.5 6.5 11 6.5h7" stroke="white" strokeOpacity="0.95" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <path d="M7 22.5c5 0 6.5-6.5 11-6.5" stroke="white" strokeOpacity="0.6" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="25" cy="16" r="2.6" fill="white" />
    </svg>
  );
}
