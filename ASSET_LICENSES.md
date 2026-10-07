# Asset and dependency licences

The Human Cell Atlas uses **no external images, 3D models, textures, sounds,
icons or texts**. Every piece of geometry is generated procedurally by the code
in `src/engine/`; the cell illustration (`src/ui/CellIllustration.tsx`), the
favicon and the interface icons (`src/ui/icons.tsx`) are original SVG drawn
for this project; all explanations were written for this project. The
screenshots in `docs/screenshots/` and the structure illustrations in
`public/illustrations/` (used by the text atlas and the prerendered pages) are
renders of this application's own scenes (`npm run screenshots`,
`npm run illustrations`).

Scientific facts are cited, not copied: each source record in
`src/content/sources.ts` gives the title, authors or organisation, year and a
link. Titles are quoted in their original language for identification.

## Fonts (shipped with the site)

| Font | Package | Designer / owner | Licence |
| --- | --- | --- | --- |
| Alegreya (titles) | `@fontsource/alegreya` 5.3.0 | Juan Pablo del Peral, Huerta Tipográfica | SIL Open Font License 1.1 |
| Alegreya Sans (interface and text) | `@fontsource/alegreya-sans` 5.3.0 | Juan Pablo del Peral, Huerta Tipográfica | SIL Open Font License 1.1 |
| Noto Sans SC (Simplified Chinese, loaded only for Chinese) | `@fontsource/noto-sans-sc` 5.3.0 | Google, Adobe | SIL Open Font License 1.1 |

The fonts are self-hosted from the Fontsource packages (WOFF2 subsets: Latin,
Latin Extended, Cyrillic, Cyrillic Extended; Chinese by Unicode-range slices).
The OFL permits bundling with software; the fonts are not sold on their own.
Licence text: <https://openfontlicense.org/open-font-license-official-text/>.

## Libraries included in the built site

| Package | Version | Licence |
| --- | --- | --- |
| react, react-dom, scheduler | 19.3.0 / 19.3.0 / 0.28.0 | MIT |
| three (including `three/addons`: RoomEnvironment, EffectComposer, RenderPass, UnrealBloomPass, OutputPass, BufferGeometryUtils) | 0.186.1 | MIT |
| @react-three/fiber, its-fine, suspend-react, react-use-measure | 9.8.1 / 2.1.1 / 0.1.3 / 2.1.7 | MIT |
| camera-controls | 3.1.2 | MIT |
| zustand, use-sync-external-store | 5.0.15 / 1.7.0 | MIT |
| @babel/runtime | 7.29.10 | MIT |
| buffer, base64-js | (transitive) | MIT |
| ieee754 | (transitive) | BSD-3-Clause |

Exact versions of everything are pinned in `package-lock.json`.

## Development tools (not shipped)

Vite, @vitejs/plugin-react, Vitest, ESLint and its plugins, typescript-eslint,
tsx and globals are MIT-licensed; TypeScript and Playwright are Apache-2.0;
axe-core (accessibility tests) is MPL-2.0. They are used only to build and
test the project.
