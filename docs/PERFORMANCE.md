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
| App shell + English text and sources (`index-*.js`) | ≈ 463 KB | ≈ 142 KB | immediately |
| Styles (`index-*.css`) | ≈ 39 KB | ≈ 8 KB | immediately |
| 3D engine (`Viewer-*.js`) | ≈ 1.10 MB | ≈ 294 KB | after the interface |
| Each close-up scene (+ shared toolkit) | 4–18 KB (+ 14 KB) | 2–8 KB (+ 6 KB) | when opened |
| Each other language | 95–182 KB | 36–45 KB | when chosen |
| Chinese font stylesheet (subsets load by Unicode range) | ≈ 201 KB | ≈ 83 KB | Chinese only |
| Fonts | WOFF2 subsets | | by Unicode range |

## Measurements (software rendering only)

Environment: Linux container with 4 vCPUs (Intel Xeon @ 2.10 GHz) and 15 GB
RAM, Chromium 141 headless (Playwright 1.56.1), production build served by
`vite preview`, measured with `npm run perf` on 7 October 2026. **There is no
GPU: WebGL 2 runs in SwiftShader**, which executes every shader on the CPU
(`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`). Quality is forced per row; each row samples frame times for
6 seconds after the view has settled.

| Scenario | Viewport | Quality | Scene ready | FPS | Frame avg / p95 | Draw calls | Triangles |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Whole cell, desktop | 1440×900 | low | 6.8 s | 2.2 | 448 / 1850 ms | 63 | 768,154 |
| Whole cell, desktop | 1440×900 | medium | 7.6 s | 0.6 | 1755 / 4433 ms | 77 | 1,116,670 |
| Whole cell, desktop | 1440×900 | high | 6.2 s | 0.1 | 7333 / 7333 ms | 77 | 1,728,418 |
| Mitochondria in the cell, desktop | 1440×900 | medium | 33.4 s | 0.3 | 3340 / 4300 ms | 82 | 1,138,482 |
| ATP synthase close-up, desktop | 1440×900 | medium | 43.8 s | 2.1 | 479 / 750 ms | 33 | 46,552 |
| Ribosome close-up, desktop | 1440×900 | medium | 40.4 s | 2.3 | 435 / 633 ms | 29 | 31,976 |
| Whole cell, phone | 390×844 | low | 5.0 s | 2.5 | 401 / 1350 ms | 63 | 768,154 |
| Kinesin close-up, phone | 390×844 | low | 30.6 s | 8.8 | 114 / 300 ms | 18 | 86,270 |

How to read this table:

- **Frame rates are not representative.** SwiftShader is one to two orders of
  magnitude slower than a GPU, so these rows say nothing about the 60 fps
  desktop / 30 fps phone targets. They do show the relative cost of the quality
  levels and that close-ups are much lighter than the whole cell. At high
  quality one software frame of the whole cell took about 7 s, so that row
  rests on a single sampled frame.
- **Draw calls and triangles are hardware-independent**: the whole cell needs
  63 draw calls at low quality and 77 at medium and high, with about 0.77,
  1.12 and 1.73 million triangles; close-ups need 2–33 draw calls and about
  11,000–110,000 triangles (all 21 are listed in
  [VERIFICATION.md](VERIFICATION.md)). These are modest for current desktop and
  phone GPUs; the per-frame CPU work is a few dozen object updates because
  repeated molecules move in shaders.
- **“Scene ready”** is the time from navigation until the interface reports a
  usable view. For the whole cell (5–8 s here) it is dominated by building the
  procedural geometry and compiling shaders. Deep links into a structure or a
  close-up also wait for the entrance and camera animations, and because each
  frame advances animation time by at most 0.25 s (so that a stall never makes
  the camera jump), multi-second software frames stretch those animations to
  tens of seconds. With a GPU they take their nominal 1–3 seconds.
- The automatic quality controller starts software renderers at low quality,
  so a reader on such a machine gets the cheapest level without waiting.

These targets remain to be confirmed on real hardware; the procedure is below.

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
