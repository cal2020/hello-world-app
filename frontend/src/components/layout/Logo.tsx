export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <linearGradient id="aci-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8576ff" />
          <stop offset="1" stopColor="#4a3bd8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#aci-logo)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" stroke="white" strokeOpacity="0.18" />
      <path d="M9 10.5h9M9 15h6M9 19.5h4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20.5" cy="18.5" r="4" stroke="#fff" strokeWidth="2" />
      <path d="m23.5 21.5 2.5 2.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
