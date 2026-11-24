# Tests

| Command | What | Where it runs |
|---|---|---|
| `pnpm test:unit` | Vitest: `src/core`, extrusion, the sky data readers and their committed files, cities.json shape, source hygiene, the landmark tool, upper bounds on hot code | CI and locally |
| `pnpm test:py` | pytest on the data pipelines in `scripts/` (`tests/python/`): parsers, encoders and the committed outputs against their sidecars, never the network; needs [uv](https://docs.astral.sh/uv/) | CI and locally |
| `pnpm test:e2e` | Playwright on SwiftShader (`webgl2-software`): goldens, the `window.__skyline` contract, the buildless boot, the deterministic performance budgets | CI and locally |
| `pnpm test` | both of the above | |
| `pnpm test:e2e:gpu` | the functional specs of `pnpm test:e2e` on this machine's GPU (`gpu-functional`): everything but the goldens, which are compared only on SwiftShader. One software frame of this app takes about 3 s on a quiet machine and far longer on a busy one, so this is the quick local run; it is not a substitute for `pnpm test:e2e` before a merge | locally only |
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

The goldens are full-page, so they include the controls. Phase 1 added `#sky-toggle` under `#night`; the ten goldens
were regenerated for it after checking, pixel by pixel against the phase 0 images, that only the tools column differs.
Do the same whenever a control is added: regenerate on purpose, and confirm where the differing pixels are.

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

## Phase 1 (plan 01): the clock, the sky and the journeys

| Spec | What |
|---|---|
| `tests/unit/sim/clock.test.js`, `timeline.test.js` | `SimClock` and `Timeline` against sections 11.2 and 11.3 |
| `tests/unit/sky/ephemeris.test.js` | the ephemeris against the committed JPL Horizons and Naval Observatory fixtures (`tests/fixtures/`, recorded by `scripts/fetch_test_fixtures.py`; no test touches the network) |
| `tests/unit/env/environment.test.js` | every `EnvState` key and type, the stubs, the pinned and clock states |
| `tests/unit/render/frameLoop.test.js` | the four tiers on a fake scheduler |
| `tests/e2e/skyState.spec.js` | the two states in the app, `?t=` |
| `tests/e2e/skyLight.spec.js` | key light against the ephemeris, shadow redraws per 0.1 degree, the dusk scrub, the Moon's phase on screen, the classic afternoon and the reference night against the goldens (slow on SwiftShader: up to 30 minutes for the dusk scrub on a busy machine) |
| `tests/e2e/skyPopover.spec.js`, `transport.spec.js` | `#sky` and the transport bar by real input |

`perf.budgets.spec.js` also counts the frame loop's tiers in the app (paused: no frame; 1x: two a second), and
`perf.timing.spec.js` times a scrub of the time of day (CPU per step, frame rate against the scene's own).

## Data pipelines (plan 01, phase 4 data)

`pnpm test:py` reads the committed outputs of `scripts/build_stars.py`, `build_sky_textures.py` and
`build_lights.py` and checks them against their sidecars and known sky and street facts. `build_nightlights.py` is
tested on small synthetic VNP46A4 tiles written by the test itself; `tests/unit/sky/nightlights.test.js` checks the
real Las Vegas grid against its landmarks once `public/data/lv/nightlights.json` exists, and skips until then.

## Phase 2 (plan 01): the renderer

| Command / spec | What |
|---|---|
| `pnpm test:perf:ab` (`perf.ab.spec.js`, project `gpu-ab`) | The classic renderer (`?renderer=legacy`) and the new one in the same run, interleaved (A B, B A, six pairs of 60 frames per scene), as throughput on this machine's GPU; prints the median per-pair ratio per scene and their geometric mean, and fails above `SKYLINE_AB_GATE` (default 1.15, the ship gate). `SKYLINE_AB_B='backend=webgpu'` times the WebGPU backend. Throughput, not timer queries: on ANGLE Metal a frame timed alone follows the GPU's clock (see `docs/plans/notes/01-phase2-spike.md`) |
| `pnpm test:webgpu` (project `webgpu-software`) | `renderer`, `hooks` and `webgpu` specs on Chromium's software WebGPU adapter, the app forced to `?backend=webgpu`. In CI as a job that does not block a merge yet (decision 6) |
| `pnpm test:bench` (`bench.spec.js` on `gpu-ab`) | `?bench=1` on both backends; `SKYLINE_BENCH_UPDATE=1` records `tests/reference/bench/<machine id>.json`. The software suite runs it for two seconds |
| `renderer.spec.js` | boot, hide, undo and a captured frame on each renderer and backend (T2.1) |
| `buildingMaterial.spec.js`, `parity.spec.js`, `attractions.spec.js` | the new renderer at the classic display (`?display=classic`: ACES, exposure 1, no bloom) against the classic renderer in the same run: buildings within 3 %, the ten scenes within 2 % (and against the T0.2 goldens), the fountain within 5 %; the show paused renders nothing; an instant shows the same jets after a scrub (T2.2, T2.3, T2.11) |
| `pipeline.spec.js` | the pipeline at the classic display matches the direct render within 1 %; `probe()` within 2 % of known emission; stages; a sunlit roof at noon 20,000 to 35,000 cd/m², a lit window at night 30 to 90 (T2.4, T2.5) |
| `exposure.spec.js` | a noon-midnight-noon scrub without jumps, seeks within 0.3 EV, idle once settled (T2.6); the pan-settling time is in `perf.timing.spec.js` |
| `displaySettings.spec.js` | Quality, Exposure and Reduce flashes in `#settings` by real input (T2.7) |
| `landmarkChecker.spec.js` | the skill's own `check` (integration v7) for the Strat, the High Roller and the fountain, with Playwright's Chromium (T2.9) |
| `webgpu.spec.js` | the WebGPU and WebGL2 backends agree within 4 % on two scenes |

The timing tier (`pnpm test:perf`) runs the new renderer on its WebGL2 backend (`?backend=webgl`), the backend the
ship gate is defined on, so its machine id stays the one recorded in phase 0. Since phase 2 its frame time is
throughput (20 batches of 12 frames submitted back to back; median and 95th percentile over the batches), not
per-frame timer queries: on ANGLE Metal those follow the GPU's clock, and on the new renderer they read about four
times its throughput. The baseline was re-recorded for the new renderer on 22 November 2026.

Changes under `src/render`, `src/sky`, `src/weather` or the materials need a local report from a real GPU in
`tests/reference/reports/` until the `webgpu-software` job is required (decision 6).

## Phase 5 (plan 01): weather data

| Spec | What |
|---|---|
| `tests/unit/weather/*.test.js` | the sample and its validator (fuzzed), presets, overrides, interpolation; the normalizers on the recorded days of section 8.2; `derive.js` (fusion of every recorded day, the medium, `setAtmosphereFromWeather`); the client service with the real handler behind a fake fetch; the chip's wording |
| `tests/unit/api/*.test.js` | `/api/weather`: cache headers, partial responses, the upstream-failure matrix, the User-Agent, hostile input (no request value reaches an upstream URL); the `pnpm dev` middleware |
| `tests/unit/env/weather.test.js` | the weather in `env.state` in the clock state only; `state.medium` |
| `tests/python/test_aerosol_climatology.py` | the monthly aerosol climatology, and Las Vegas' against AERONET |
| `tests/e2e/weather.spec.js` | nothing weather-related at boot; each link of the fallback chain; the preset within two seconds with the network blocked; scrubbing across midnight UTC and a month's end |
| `tests/e2e/weatherRows.spec.js` | the `#sky` weather rows by real input: 14 July 1975, each preset, each slider and "follow data", the credits, the fit at 1280 × 800 and 700 px in both themes |
| `tests/live/weatherContract.test.js` | **not part of `pnpm test`**: the real upstreams, and the deployed function when `SKYLINE_DEPLOY_URL` is set (`pnpm test:live`; daily in `.github/workflows/live.yml`, which opens an issue on failure) |

The weather fixtures (`tests/fixtures/weather/<city>-<day>.rec-<date>.json`) are recorded by
`uv run scripts/fetch_weather_fixtures.py all`. The first set was recorded on 22 November 2026, before Open-Meteo
retires the HRRR and NAM models at the end of November; decision 11 of plan 01 asks for a recording on or after
1 December 2026. Re-record then, delete the older files, and re-run `pnpm test:unit`. No test asserts a value that only
HRRR or NAM provide: values from the historical forecast are read from the fixture itself.

`tests/helpers/app.js`'s `boot()` blocks every weather request unless a spec routes them itself
(`tests/helpers/weatherRoutes.js` answers `/api/weather` with the real handler over the fixtures).
