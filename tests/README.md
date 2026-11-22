# Tests

| Command | What | Where it runs |
|---|---|---|
| `pnpm test:unit` | Vitest: `src/core`, extrusion, the sky data readers and their committed files, cities.json shape, source hygiene, the landmark tool, upper bounds on hot code | CI and locally |
| `pnpm test:py` | pytest on the data pipelines in `scripts/` (`tests/python/`): parsers, encoders and the committed outputs against their sidecars, never the network; needs [uv](https://docs.astral.sh/uv/) | CI and locally |
| `pnpm test:e2e` | Playwright on SwiftShader (`webgl2-software`): goldens, the `window.__skyline` contract, the buildless boot, the deterministic performance budgets | CI and locally |
| `pnpm test` | both of the above | |
| `pnpm test:perf` | timing on this machine's GPU (`gpu` project, one worker) against `tests/reference/perf/timing/<machine id>.json` | locally only |
| `pnpm test:perf:software` | the same timing suite on SwiftShader, gated at 2x | locally |
| `pnpm bench` | micro-benchmarks (`vitest bench`), reported, not gated | locally |

## Golden images

`tests/e2e/baseline.spec.js` renders every view of every city by day and by night, with the fountain, LED and wheel
clocks held at 47 s and storage fresh per test, and compares the page with `tests/reference/baseline/<platform>/`
within 0.1 % of pixels. `SKYLINE_GOLDEN_STRICT=1` compares every pixel (use it to check a refactor; SwiftShader
itself flickers a few pixels now and then, see the phase 0 notes).

Goldens are per platform: Chromium's text and SwiftShader's output differ between macOS and Linux. Only
`darwin` goldens are committed. Where none exists for the running platform, the spec still renders each scene and
fails on page or console errors, but compares nothing, and says so in an annotation. **CI (Linux) therefore has no
golden coverage until Linux goldens are committed.** To make them:

- in GitHub: run the `ci` workflow by hand with "Generate Linux golden images" ticked, download the `linux-goldens`
  artifact and commit it under `tests/reference/baseline/linux/`; or
- locally, in the Playwright image that matches `@playwright/test` (1.65.1):
  `docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.65.1-noble sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm test:goldens:update"`

`pnpm test:goldens:update` rewrites the goldens of the platform it runs on. Do it only when a change is meant to
change the picture, and say so in the commit.

## Performance (plan 01, section 8.7)

Two tiers.

- **Deterministic** (`tests/e2e/perf.budgets.spec.js`, CI and locally), against `tests/reference/perf/budgets.json`:
  gzipped JS and CSS from `vite build` (total and per chunk), bytes each city downloads before it is ready and in
  all, `renderer.info` counts per scene, and render on demand (a scene held still renders no frame in 5 s; with
  the show clocks running it renders only if something animates in view, at most 30 frames a second). Counts must
  match exactly; sizes may grow 3 %. A change that moves them updates the file in the same commit:
  `pnpm test:perf:budgets:update`.
- **Timing** (`tests/e2e/perf.timing.spec.js`), against a per-machine baseline whose id is the GPU's renderer
  string and the core count (nothing personal): frame time (median and 95th percentile of 120 frames, GPU time from
  timer queries where the browser has them), time to ready, and edit-to-frame latency for hide, undo, move and a
  cutoff rebuild. A scene fails if its median is more than 15 % slower or its 95th percentile more than 25 % on three
  attempts in a row (single-sample timings get one 60 Hz frame of slack, time to ready 100 ms), and the run fails if
  all scenes together are more than 10 % slower; on a software rasterizer only at 2x. A machine with
  no baseline records one and passes. `pnpm test:perf:update` rewrites this machine's baseline. Run it on a quiet
  machine: other GPU or CPU load moves these numbers by more than the gates.

`window.__skyline.perf` is the hook behind both: `renderFrames(n)`, `info()`, `frames()`, `gpu()`.
