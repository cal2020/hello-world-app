# Performance

## Targets

About 60 frames per second on a contemporary desktop and about 30 on a
midrange phone, with responsive interaction at all times (direct
manipulation never waits for an animation).

## How the atlas stays fast

| Technique | Where |
| --- | --- |
| **Quality levels** change the pixel-ratio cap (1 / 1.5 / 2), bloom and multisampling (off at low), image-based lighting (off at low), geometric detail and the number of repeated objects (ribosomes, mitochondria, vesicles, filaments…). No level removes a structure. | `src/app/quality.ts`, each structure's `setQuality` |
| **Automatic quality**: starts at low on touch devices and software renderers, medium on ≤ 4 GB / ≤ 4 cores, otherwise high; measures 2-second windows; steps down after two slow windows; steps up only after five fast windows, a 45-second cooldown, and never to a level that failed twice (no oscillation). Very slow frames still count, so software rendering reaches low quickly. | `AutoQualityController`, unit-tested |
| **Instancing** for every repeated object; merged static geometry; draw ranges instead of rebuilding when the quality changes. | `src/engine/cell/structures/*` |
| **Shader-side animation** (microtubule dynamic instability, thermal jiggle of thousands of molecules in close-ups), so the CPU only updates a few dozen objects per frame. | `mtDynamics.ts`, `closeups/kit.ts` |
| **Lazy loading**: the interface and text appear first; the 3D engine chunk (three.js, React Three Fiber, post-processing) loads afterwards; each close-up and each non-English language is its own chunk; Chinese fonts load only for Chinese. | Vite code splitting |
| **Frame loop hygiene**: rendering follows `requestAnimationFrame`, which stops while the tab is hidden; the first frame after returning is not counted as elapsed time; time steps are capped at 0.25 s; close-up scenes, textures, listeners, timers and export object URLs are released when no longer used. | `CellEngine.ts` |
| **Picking without GPU reads**: analytic ray tests against simple proxies (spheres, capsules, sampled curves) instead of rendering an ID buffer. | `Picker.ts`, `raycast` per structure |

## Bundle sizes (production build)

| Chunk | Raw | Gzipped | Loaded |
| --- | --- | --- | --- |
| App shell + English text (`index-*.js`) | ≈ 455 KB | ≈ 138 KB | immediately |
| Styles (`index-*.css`) | ≈ 38 KB | ≈ 8 KB | immediately |
| 3D engine (`Viewer-*.js`) | ≈ 1.09 MB | ≈ 294 KB | after the interface |
| Each close-up scene (+ shared toolkit) | 4–18 KB (+ 14 KB) | 2–8 KB (+ 6 KB) | when opened |
| Each other language | 92–175 KB | 34–43 KB | when chosen |
| Fonts | WOFF2 subsets | | by Unicode range |

MEASUREMENTS_PLACEHOLDER

## Measuring on real hardware

```bash
npm run build && npm run preview        # terminal 1
npm run perf -- --gpu                   # terminal 2 (add --headed if headless Chrome has no GPU)
```

The script loads each scenario with the quality forced, waits until the camera
has settled, samples frame times for 6 seconds and prints a Markdown table
(frame rate, average and 95th-percentile frame time, draw calls, triangles).
For phones, open the preview on the device over the local network
(`npm run preview -- --host`) and add `?perf=1` to the address to show the
frame-time overlay (frame rate, frame time, quality, draw calls, triangles).
Record the device, browser version and GPU next to the numbers, and keep
hardware results separate from desktop "mobile emulation" results.
