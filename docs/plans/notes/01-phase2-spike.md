# Plan 01, T2.0: the renderer spike and the go/no-go

22 November 2026, on the phase 1 branch (`e72330b`), three `0.187.0`, Chromium 1255 (Playwright 1.65.1) and Chrome
157, on the reference machine (Apple M4, 10 cores, macOS, headless Chromium on ANGLE Metal or Dawn Metal).

**Verdict: proceed.** On the WebGL2 backend `WebGPURenderer` drew the ten baseline scenes at 0.82 times the classic
renderer's frame time overall (0.96 when both draw plain Lambert), inside the 25 % spike gate, and nothing found is a
blocker. Phase 2 continues with T2.1; it ships only within 15 %.

## What was done

The phase 1 app, booted with `WebGPURenderer` from `three/webgpu` behind a throwaway switch (`?renderer=webgpu`,
`&backend=webgl` for `forceWebGL: true`), buildings in plain Lambert. The switch is kept as
`01-phase2-spike.patch` next to this note (apply it to `e72330b` to reproduce); it is not in the tree. What stayed:
a throughput measure in the performance hook (`perf.throughput()`), the A/B spec `tests/e2e/perf.ab.spec.js`
(`pnpm test:perf:ab`, Playwright project `gpu-ab`) that produced the numbers below, and this note.

## What broke

Nothing that is not already a task of phase 2; nothing that blocks it.

| What | On `WebGPURenderer` | Where it is handled |
|---|---|---|
| `ShaderMaterial`: the legacy dome, the Sun and Moon discs, the fountain | refused: `NodeBuilder: Material "ShaderMaterial" is not compatible.` (the spike swapped the dome for a flat `MeshBasicMaterial` and left the fountain out) | T2.3 (dome, discs), T2.11 (fountain) |
| `onBeforeCompile` (`night.js`: windows, glow, LED skins, facade detail) | silently ignored: buildings draw as plain Lambert, no error | T2.2 |
| `renderer.shadowMap.autoUpdate` / `.needsUpdate` | do not exist; without per-light `shadow.autoUpdate = false` the shadow map is redrawn every frame. The app (edits, picking, the key light, attractions), the test helpers and the landmark checker all write `renderer.shadowMap.needsUpdate = true` | T2.1: a compatible `needsUpdate` setter that marks the casting lights' shadows (the hooks contract keeps working) |
| `renderer.capabilities.getMaxAnisotropy()` | no `capabilities`; `renderer.getMaxAnisotropy()` | T2.1 |
| Initialization | `await renderer.init()` before the first frame (the app already has top-level await) | T2.1 |
| `renderer.getContext()` | a `GPUCanvasContext` on WebGPU; the perf hook and two specs call GL on it (`finish`, `readPixels`, timer queries) | perf hook: `renderer.backend.gl` on the WebGL2 backend, timestamps or throughput on WebGPU. Specs that read GL pixels run on the WebGL2 backend (the software suite always is) |
| `renderer.info` | `render.drawCalls` instead of `render.calls`; no `programs` list | perf hook maps them; the budget file's counts will change |
| `preserveDrawingBuffer` | does not exist | the view thumbnails (`drawImage` of the canvas in the same task as the render) still worked on both backends; `capture()` (T2.1) renders to a target |
| Bundle | one chunk with both renderers: 419.7 kB gzip against 291.5 kB | T2.1: the classic renderer goes behind a dynamic import |
| GPU timer queries on ANGLE Metal | not usable for single frames, for either renderer: see below | the A/B measure is throughput |

## How it was measured, and the numbers

**Timer queries do not measure work on this GPU.** The phase 0 hook times each frame alone (`beginQuery`, render,
`endQuery`, `gl.finish()`). Here the same scene read 6 ms in one batch and 35 ms in the next, and hiding every building
made a frame read 99 ms instead of 6: the GPU's clock falls while it idles between timed frames, so the time follows
the clock, not the work. Timing frames back to back with the same queries was no better (6 and 35 ms again). What is
stable is **throughput**: `n` frames submitted back to back, then a one-pixel `readPixels` from the canvas (which, unlike
`gl.finish()` on ANGLE Metal, blocks until the GPU is done), the elapsed time divided by `n`; consecutive batches agreed
within a few per cent. On WebGPU the same measure ends with `queue.onSubmittedWorkDone()`. It includes the CPU's
submission cost when that is the slower side, which is part of what a renderer costs. Timestamp queries do work on
WebGPU in headless Chromium here (`--enable-unsafe-webgpu --enable-webgpu-developer-features`), and the hook uses them
for `renderFrames()` on that backend, but the A/B comparison uses throughput on every backend so the three are
measured the same way.

**Interleaved, not against a baseline.** Other sessions share this machine (load 5 to 11 during these runs), so each run
loads both renderers side by side in two pages of one browser, stages the same scene at 1280 × 800, and alternates
A and B six times per scene (A B, B A, ...), 60 frames per batch after 10 warm-up frames. The figure per scene is the
median of the six ratios B / A; overall is their geometric mean.

| Scene | classic, as shipped (night shader) ms | WebGL2 backend, plain ms | B / A | classic, plain ms | WebGL2 backend, plain ms | B / A | classic, plain ms | WebGPU backend, plain ms | B / A |
|---|---|---|---|---|---|---|---|---|---|
| slc-ensign-day | 14.51 | 13.59 | 0.875 | 9.71 | 10.00 | 1.038 | 12.65 | 10.27 | 0.812 |
| slc-ensign-night | 10.24 | 10.42 | 1.010 | 9.76 | 9.98 | 1.027 | 12.41 | 10.21 | 0.822 |
| slc-aerial-day | 11.10 | 8.71 | 0.848 | 7.62 | 8.05 | 1.061 | 10.96 | 8.77 | 0.813 |
| slc-aerial-night | 11.69 | 10.01 | 0.882 | 8.18 | 7.93 | 0.969 | 9.49 | 6.91 | 0.767 |
| lv-east-day | 15.76 | 12.94 | 0.795 | 12.31 | 10.26 | 0.848 | 15.04 | 11.63 | 0.767 |
| lv-east-night | 14.52 | 12.13 | 0.732 | 10.83 | 9.79 | 0.904 | 15.07 | 11.53 | 0.752 |
| lv-strat-day | 17.04 | 13.26 | 0.794 | 9.62 | 9.41 | 0.995 | 14.57 | 11.02 | 0.745 |
| lv-strat-night | 16.59 | 13.44 | 0.803 | 9.66 | 9.42 | 0.979 | 9.94 | 7.20 | 0.753 |
| lv-aerial-day | 13.49 | 11.06 | 0.805 | 15.43 | 13.27 | 0.862 | 12.08 | 9.86 | 0.784 |
| lv-aerial-night | 17.79 | 12.53 | 0.719 | 16.55 | 12.63 | 0.928 | 15.43 | 9.95 | 0.658 |
| **overall** | | | **0.823** | | | **0.959** | | | **0.766** |

(Three separate runs; the absolute milliseconds of one run are not comparable with another's, the ratios are.) The
gate as the plan words it, classic as shipped against the new renderer with plain Lambert, is 0.82; the fairer
reading, both renderers drawing the same plain materials, is 0.96. Either is inside 1.25. The night shader costs the
classic renderer roughly a fifth of its frame on the Las Vegas views; T2.2's TSL port will put a similar cost back
on the new side, which is why the ship gate (15 %) is measured again at the end of the phase with every material
ported.

**Load time** (median of four boots each, navigation start to `skyline-ready`, then to the first frame):

| | ready | first frame |
|---|---|---|
| lv classic | 3,301 ms | 4,466 ms |
| lv WebGL2 backend | 2,904 ms | 4,184 ms |
| lv WebGPU backend | 2,948 ms | 3,641 ms |
| slc classic | 2,045 ms | 2,978 ms |
| slc WebGL2 backend | 1,626 ms | 2,757 ms |
| slc WebGPU backend | 1,688 ms | 2,263 ms |

No regression; these numbers are noisy on a shared machine and include no TSL shader compilation yet (T2.2 adds it).

## The landmark checker's browser

Chrome 157 with the checker's exact flags (`--headless=new --enable-unsafe-swiftshader --ignore-gpu-blocklist
--virtual-time-budget=45000 --screenshot`) loaded the spike build on `WebGPURenderer` in 2.4 s and wrote a correct
frame. Under those flags `navigator.gpu` exists but `requestAdapter()` resolves to `null`, as it does under the
software suite's flags; three then falls back to WebGL2 on its own, asynchronously. T2.1's backend choice makes that
decision itself (no adapter, or a fallback adapter, means WebGL2) and decides synchronously when `?backend=webgl` is
given, which the v7 checker will pass (T2.10). The import map half of the checker is T2.9.

## The `webgpu-software` project (decision 6)

**Flags:** `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-angle=swiftshader --use-gl=angle
--ignore-gpu-blocklist`, the app forced with `?backend=webgpu`. `--enable-unsafe-webgpu` is what matters: with it,
headless Chromium on macOS offers Dawn's SwiftShader adapter (`vendor google, architecture swiftshader`,
`isFallbackAdapter: true`, with `timestamp-query`); without it `requestAdapter()` gives `null`. `--use-webgpu-adapter=
swiftshader` and `--use-vulkan=swiftshader` were not needed here.

**Reliability:** six boots of each city on it, with hide and view changes, all came up and rendered a correct frame,
in 5 to 36 s (faster than the same build on SwiftShader WebGL2, 16 to 41 s). That is a small sample on one machine,
and it says nothing about GitHub's Linux runners, which this session cannot run. So: **not yet a required CI job.**
T2.1 adds the project and a CI job that runs it without blocking a merge; it becomes required once it has passed on CI
for a week. Until then decision 6's rule applies: a committed local report from a real GPU
(`tests/reference/reports/`) before merging any change under `src/render`, `src/sky`, `src/weather` or the materials;
phase 2 commits one.
