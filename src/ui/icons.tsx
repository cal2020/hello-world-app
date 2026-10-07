/** Small original stroke icons (24×24 grid). Decorative: always paired with text or aria-label. */
import type { ReactElement } from 'react';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export type IconName =
  | 'menu'
  | 'close'
  | 'search'
  | 'cell'
  | 'tour'
  | 'pause'
  | 'play'
  | 'labels'
  | 'snow'
  | 'quality'
  | 'motion'
  | 'camera'
  | 'help'
  | 'info'
  | 'plus'
  | 'minus'
  | 'reset'
  | 'prev'
  | 'next'
  | 'stop'
  | 'text'
  | 'cube'
  | 'globe'
  | 'zoomin'
  | 'more';

const paths: Record<IconName, ReactElement> = {
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  cell: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="8" />
      <circle cx="11" cy="11.5" r="3.4" />
      <path d="M16.5 8.5c1 .6 1.6 1.6 1.6 2.6M6 15.5c.8 1 2 1.6 3.2 1.8" />
    </>
  ),
  tour: (
    <>
      <path d="M5 19V5M5 5h11l-2.5 3.5L16 12H5" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  labels: (
    <>
      <path d="M4 7.5V5a1 1 0 0 1 1-1h7l8 8-8 8-8-8z" />
      <circle cx="8.5" cy="8.5" r="1.3" />
    </>
  ),
  snow: (
    <>
      <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />
      <path d="M10 4.5l2 1.8 2-1.8M10 19.5l2-1.8 2 1.8" />
    </>
  ),
  quality: (
    <>
      <path d="M4 18h3V12H4zM10.5 18h3V8h-3zM17 18h3V4h-3z" />
    </>
  ),
  motion: (
    <>
      <path d="M3 12c2.5-4 5-4 7.5 0s5 4 7.5 0" />
      <path d="M19 9l2 3-2 3" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.6" />
      <path d="M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4 4v4h4" />
    </>
  ),
  prev: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  stop: <path d="M6.5 6.5h11v11h-11z" />,
  text: (
    <>
      <path d="M5 5h14M5 9.5h14M5 14h9M5 18.5h11" />
    </>
  ),
  cube: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9S9.5 5.6 12 3z" />
    </>
  ),
  zoomin: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5M11 8v6M8 11h6" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18.5" cy="12" r="1.3" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return <svg {...base}>{paths[name]}</svg>;
}
