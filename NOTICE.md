# Notices

## Zit

Switchyard drives [Zit](https://getzit.org/) (copyright Autohand AI LLC) as a separate program, through its command-line interface. Zit is licensed under the **GNU General Public License, version 2 only** (`GPL-2.0-only`).

Switchyard does not include, link or modify Zit's source. `npm run setup:zit` builds the unmodified Zit 0.1.1 release from crates.io into `./.tools/`, and that directory is not committed. If you redistribute a Zit binary together with Switchyard, the GPL-2.0 terms apply to that binary: provide its license and the corresponding source (crates.io `zit` 0.1.1, or <https://github.com/autohandai/getzit>).

`shared/resource.ts` re-implements the overlap rules described in Zit's `src/resource.rs` (`overlaps`, `held_with`), from their documented behaviour, for display only.

Zit's own web view is not reused. Its embedded Autohand Sans/Mono fonts and branding are not used.

## Bundled fonts

- Inter (`@fontsource-variable/inter`): SIL Open Font License 1.1.
- JetBrains Mono (`@fontsource-variable/jetbrains-mono`): SIL Open Font License 1.1.

The license texts ship inside the respective npm packages.

## Other dependencies

React, Radix UI, TanStack Query, motion, lucide-react, sonner, smol-toml, Tailwind CSS, Vite and Vitest are MIT- or ISC-licensed. Playwright (`playwright-core`, used only for tests and screenshots) is Apache-2.0. See each package's license in `node_modules/` after `npm ci`.

## Switchyard

No license has been chosen for Switchyard's own source yet. Add one before publishing.
