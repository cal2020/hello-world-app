/**
 * Original schematic illustration of the model cell, used as the loading
 * preview and in the text atlas. Pure SVG, no external assets. Positions are
 * hand-placed to echo the 3D layout (nucleus left of centre, centrosome and
 * Golgi to its right, ER wrapped around the nucleus).
 */
const mitochondria = [
  { x: 92, y: 210, r: -20 },
  { x: 250, y: 95, r: 35 },
  { x: 300, y: 270, r: -55 },
  { x: 140, y: 300, r: 15 },
  { x: 318, y: 175, r: 80 },
];
const dots = (seed: number, count: number, cx: number, cy: number, rx: number, ry: number) => {
  const out: Array<[number, number]> = [];
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  while (out.length < count) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    const x = cx + Math.cos(a) * rx * r;
    const y = cy + Math.sin(a) * ry * r;
    const dx = (x - 175) / 62;
    const dy = (y - 196) / 56;
    if (dx * dx + dy * dy < 1.15) continue;
    out.push([x, y]);
  }
  return out;
};
const ribosomes = dots(7, 70, 200, 200, 150, 140);
const lysosomes = dots(23, 6, 200, 200, 135, 125);
const peroxisomes = dots(91, 6, 200, 200, 135, 125);

export function CellIllustration({ className, title }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 400 400" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id="ci-cyto" cx="45%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#1b2648" />
          <stop offset="70%" stopColor="#0c1124" />
          <stop offset="100%" stopColor="#070a16" />
        </radialGradient>
        <radialGradient id="ci-nuc" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#6d55c9" />
          <stop offset="100%" stopColor="#2a1f5c" />
        </radialGradient>
        <linearGradient id="ci-mem" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a8c4ff" />
          <stop offset="100%" stopColor="#4d6fd1" />
        </linearGradient>
        <filter id="ci-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id="ci-inside">
          <ellipse cx="200" cy="200" rx="168" ry="158" />
        </clipPath>
      </defs>

      {/* Cytoplasm and membrane */}
      <ellipse cx="200" cy="200" rx="170" ry="160" fill="url(#ci-cyto)" />
      <g clipPath="url(#ci-inside)">
        {/* Microtubules radiating from the centrosome */}
        {Array.from({ length: 22 }, (_, i) => {
          const a = (i / 22) * Math.PI * 2;
          const x2 = 262 + Math.cos(a) * 200;
          const y2 = 212 + Math.sin(a) * 190;
          return <line key={i} x1="262" y1="212" x2={x2} y2={y2} stroke="#9bd4ff" strokeOpacity="0.28" strokeWidth="1.1" />;
        })}
        {/* Rough ER wrapped around the nucleus */}
        {[78, 90, 102].map((r, i) => (
          <path
            key={r}
            d={`M ${175 - r * 0.7} ${196 - r * 0.62} A ${r} ${r * 0.9} 0 0 1 ${175 + r * 0.25} ${196 + r * 0.86}`}
            fill="none"
            stroke="#22d3c5"
            strokeOpacity={0.75 - i * 0.15}
            strokeWidth="5"
            strokeLinecap="round"
          />
        ))}
        {/* Golgi stack */}
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M ${282 + i * 7} ${168 - i * 2} q 26 ${44 - i * 2} 0 ${88 - i * 4}`}
            fill="none"
            stroke="#ff9e3d"
            strokeOpacity={0.9 - i * 0.1}
            strokeWidth="4.5"
            strokeLinecap="round"
          />
        ))}
        {/* Mitochondria */}
        {mitochondria.map((m, i) => (
          <g key={i} transform={`translate(${m.x} ${m.y}) rotate(${m.r})`}>
            <rect x="-26" y="-10" width="52" height="20" rx="10" fill="#c43f48" stroke="#ff8a90" strokeWidth="1.5" />
            {[-16, -8, 0, 8, 16].map((x) => (
              <path key={x} d={`M ${x} -7 q 3 7 0 14`} stroke="#ffc2c5" strokeWidth="1.2" fill="none" opacity="0.8" />
            ))}
          </g>
        ))}
        {ribosomes.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="1.6" fill="#ffc23d" opacity="0.85" />
        ))}
        {lysosomes.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="6" fill="#7b3fb3" stroke="#c77dff" strokeWidth="1.3" />
        ))}
        {peroxisomes.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4.5" fill="#5f8a22" stroke="#b5e853" strokeWidth="1.2" />
        ))}
        {/* Centrosome */}
        <circle cx="262" cy="212" r="13" fill="#d9ccff" opacity="0.25" filter="url(#ci-glow)" />
        <rect x="256" y="208" width="10" height="5" rx="2" fill="#efe8ff" />
        <rect x="263" y="203" width="5" height="10" rx="2" fill="#efe8ff" />
      </g>

      {/* Nucleus with chromatin and nucleolus */}
      <ellipse cx="175" cy="196" rx="62" ry="56" fill="url(#ci-nuc)" stroke="#bba9ff" strokeWidth="2" />
      {Array.from({ length: 9 }, (_, i) => {
        const a = (i / 9) * Math.PI * 2;
        const cx = 175 + Math.cos(a) * 30;
        const cy = 196 + Math.sin(a) * 26;
        return (
          <path
            key={i}
            d={`M ${cx - 9} ${cy} c 4 -9 12 -2 8 4 s -10 6 -2 9`}
            fill="none"
            stroke={['#f06bc8', '#ff9bd8', '#c58bff'][i % 3]}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.85"
          />
        );
      })}
      <circle cx="190" cy="186" r="15" fill="#ff7a45" opacity="0.9" filter="url(#ci-glow)" />
      {Array.from({ length: 18 }, (_, i) => {
        const a = (i / 18) * Math.PI * 2;
        return <circle key={i} cx={175 + Math.cos(a) * 62} cy={196 + Math.sin(a) * 56} r="2.2" fill="#e8e0ff" opacity="0.8" />;
      })}

      {/* Plasma membrane with a cutaway glow */}
      <ellipse cx="200" cy="200" rx="170" ry="160" fill="none" stroke="url(#ci-mem)" strokeWidth="5" filter="url(#ci-glow)" />
      <ellipse cx="200" cy="200" rx="164" ry="154" fill="none" stroke="#e7d38f" strokeOpacity="0.18" strokeWidth="2" strokeDasharray="2 5" />
    </svg>
  );
}
