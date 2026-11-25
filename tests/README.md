# Tests

Tests run locally. Nothing starts them on a push or a pull request: the `ci` workflow (`.github/workflows/ci.yml`) runs only when it is started by hand. Whoever opens or updates a pull request runs the suites on their own machine and says in the pull request what ran and what passed (`CLAUDE.md`, "Every pull request attests what ran").

| Command | What | Where it runs |
|---|---|---|
| `pnpm test:unit` | Vitest: `src/core`, extrusion, the sky data readers and their committed files, cities.json shape, source hygiene, the landmark tool, upper bounds on hot code; the drive's frame, terrain and patches, road net, routes, journey, rig and cabin, signs, corridor, traffic, lights (beam, retroreflection, lamps, pools), screens, weather and UI formatting; the data credits (`credits.test.js`) | locally |
| `pnpm test:py` | pytest (through [uv](https://docs.astral.sh/uv/), Python 3.12, `tests/python/requirements.txt`) on every data pipeline in `scripts/`, in one folder, `tests/python/`: plan 01's parsers, encoders and committed sky, star, lamp, night-light and aerosol outputs against their sidecars; the drive's Python twins (frame, heights, ground, roads, interchanges, layers, roadside, barriers, routes, terrain patch, traffic, valley traffic, corridor and its overrides, billboards, lamp packing, beam maps). Never the network. About 90 s (the first run also builds the environment) | locally |
| `pnpm test:e2e` | Playwright on SwiftShader, the map's project (`webgl2-software`, below): goldens, the `window.__skyline` contract, the buildless boot, the deterministic performance budgets | locally |
| `pnpm test:e2e:gpu` | the functional browser specs on this machine's GPU: the map's (`gpu-functional`) and the drive's (`drive-gpu`), everything but the goldens, which are compared only on SwiftShader. The quick local run; not a substitute for `pnpm test:e2e` before a merge | locally only |
| `pnpm test:e2e:drive` | Drive mode on this machine's GPU (`drive-gpu`), on the WebGPU backend: every drive spec, no goldens. About 20 minutes | locally only |
| `pnpm test:e2e:drive:software` | Drive mode on SwiftShader (`drive-software`), the WebGL2 backend: the goldens, every route, the logarithmic depth buffer. About 30 minutes on a quiet machine (below) | locally |
| `pnpm test` | `test:unit`, then `test:e2e` | |
| `pnpm test:goldens:update` | rewrites the map goldens of this platform (`baseline.spec.js`) | locally |
| `pnpm test:goldens:drive:update` | writes the drive goldens (`drive-*.png`) that differ or are missing, for this platform; never the map's | locally |
| `pnpm test:perf` | timing on this machine's GPU (`gpu` project, one worker) against `tests/reference/perf/timing/<machine id>.json` | locally only |
| `pnpm test:perf:drive` | the drive's own per-frame JavaScript on this machine's GPU (`drive-timing`, one worker): under 4 ms at the 95th percentile, cabin included | locally only |
| `pnpm test:perf:software` | the same timing suite on SwiftShader, gated at 2x | locally |
| `pnpm test:perf:update` | rewrites this machine's timing baseline | locally |
| `pnpm test:perf:budgets:update` | rewrites `tests/reference/perf/budgets.json` | locally |
| `pnpm bench` | micro-benchmarks (`vitest bench`), reported, not gated | locally |

The Playwright projects (`playwright.config.js`; every one serves the production build, `pnpm build && pnpm preview`):

| Project | Specs | Where, and notes |
|---|---|---|
| `webgl2-software` | the map's: `baseline` (goldens), `hooks`, `interactions`, `buildless`, `perf.budgets`, and the other map specs | SwiftShader, 1280 x 800. locally |
| `gpu-functional` | the map's functional specs (all but goldens, timing and the drive's) | this machine's GPU, WebGL2 backend. Locally |
| `drive-gpu` | every drive spec: `drive.spec.js` (motion, seeking, the reveal, an address, hiding a building, Map and back), `routes.spec.js` (each route opened cold, route switching and GPU memory), `drive-ui.spec.js` (route bar, picker, popovers, links, the phone layout), `drive-cabin.spec.js` (the cabin's depth, instruments, inputs, mirrors, rain on the glass), `drive-quality.spec.js` (the quality level held while driving), `drive-depth.spec.js` (a logarithmic depth buffer) | this machine's GPU, WebGPU backend (`drive-depth` asks for WebGL2). No goldens. Locally |
| `drive-software` | `drive.spec.js` (with its canvas goldens), `routes.spec.js`, `drive-depth.spec.js` | SwiftShader, the WebGL2 backend. Locally (about 30 minutes: 6, 17 and 7); `drive-depth` is also a job of the `ci` workflow, for when that is started by hand. See below for what is left to the GPU and why |
| `drive-timing` | `drive.perf.spec.js` (the drive's own per-frame JavaScript) | this machine's GPU, through `pnpm test:perf:drive` |
| `gpu`, `software-timing` | `perf.timing.spec.js` | only through `pnpm test:perf` and `test:perf:software` |
| `gpu-ab`, `webgpu-software` | plan 01's renderer comparisons and its software WebGPU run | see Phase 2 below |

**The GPU projects need a browser that can reach the GPU.** On macOS a browser started from a sandboxed process (an
agent's shell, for one) gets no GPU and falls back to SwiftShader without a word, and the run is then both slow and not
what it claims. The drive's projects check the backend they got (`metadata.backend` in the config,
`tests/helpers/drive.js` `expectBackend`) and fail at once if it is the wrong one.

### Before a pull request

On a quiet machine, from a shell that can reach the GPU (times on an Apple M4, 10 cores):

| Command | About |
|---|---|
| `pnpm test:unit` | under a minute |
| `pnpm test:py` | 1.5 minutes (the first run also builds its Python environment) |
| `pnpm test:e2e:gpu` | the map's functional specs, then every drive spec (about 20 minutes of it) |
| `pnpm test:perf:drive` | under a minute |
| `pnpm test:e2e` | the map on SwiftShader: hours on a busy machine (see `gpu-functional` above) |
| `pnpm test:e2e:drive:software` | 30 minutes; needed when the drive's picture changes (its goldens) |

## Golden images

`tests/e2e/baseline.spec.js` renders every view of every city by day and by night, with the fountain, LED and wheel
clocks held at 47 s and storage fresh per test, and compares the page with `tests/reference/baseline/<platform>/`
within 0.1 % of pixels. `SKYLINE_GOLDEN_STRICT=1` compares every pixel (use it to check a refactor; SwiftShader
itself flickers a few pixels now and then, see the phase 0 notes).

Goldens are per platform: Chromium's text and SwiftShader's output differ between macOS and Linux. Only
`darwin` goldens are committed. Where none exists for the running platform, the spec still renders each scene and
fails on page or console errors, but compares nothing, and says so in an annotation. **A run on Linux therefore has no
golden coverage until Linux goldens are committed.** To make them:

- in GitHub: run the `ci` workflow by hand with "Generate Linux golden images" ticked, download the `linux-goldens`
  artifact and commit it under `tests/reference/baseline/linux/`; or
- locally, in the Playwright image that matches `@playwright/test` (1.65.1):
  `docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.65.1-noble sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm test:goldens:update"`

The goldens are full-page, so they include the controls. Phase 1 added `#sky-toggle` under `#night`; the ten goldens
were regenerated for it after checking, pixel by pixel against the phase 0 images, that only the tools column differs.
Do the same whenever a control is added: regenerate on purpose, and confirm where the differing pixels are.
Page screenshots apply `tests/reference/screenshot.css`, which hides what was added to the map's default state after
the goldens were made (the Map/Drive switch, the data credit in the corner label).

`pnpm test:goldens:update` rewrites the goldens of the platform it runs on. Do it only when a change is meant to
change the picture, and say so in the commit.

### Drive goldens

`tests/e2e/drive.spec.js` compares the canvas only (no DOM) at five places on route `i15n` (`drive-km5`, `drive-km33`,
`drive-reveal`, `drive-km62`, `drive-km62-day`) within 0.2 % of pixels, in the same folder and under the same
per-platform rule as the map's, and only in `drive-software` (on the GPU the same steps run and compare nothing).
`pnpm test:goldens:drive:update` writes them; it never touches the map's. Plan 01's renderer keeps no drawing buffer, so
a capture draws the frame once more and reads it in the same task (`window.__skyline.capture`).

**SwiftShader and the drive.** On plan 01's renderer SwiftShader runs the WebGL2 backend with reversed depth (its
ANGLE offers `EXT_clip_control`). On a quiet Apple M4 a settled drive frame takes about 5 s in the clean view and 13 s in
the cabin (a paused cabin frame draws all three mirrors), the first frames 25 to 30 s while programs compile, and
entering Drive about a minute. So `drive-software` takes what needs SwiftShader: the goldens (`drive.spec.js`), the
state checks of every route (`routes.spec.js`), and the logarithmic depth buffer (`drive-depth.spec.js`, about 7 minutes).
The controls (`drive-ui.spec.js`: state and DOM only, dozens of settled frames), the cabin (`drive-cabin.spec.js`: cabin
frames, three captures per check) and the quality hold (`drive-quality.spec.js`: the governor acts only on frames under
250 ms apart) run on the GPU only. Run `drive-software` on a quiet machine: with other software renderers busy on every
core the drive's frames slow several times over.

**A logarithmic depth buffer** is what three falls back to on WebGL2 without `EXT_clip_control`. No machine here lacks
it, so `drive-depth.spec.js` hides the extension in an init script and compares the same places with reversed depth on
the same backend: within 0.1 % of the frame, the upper half (the distance) included, with the cabin neither leaking the
world nor clipped by its 0.1 m near plane.

## Performance (plan 01, section 8.7)

Two tiers.

- **Deterministic** (`tests/e2e/perf.budgets.spec.js`, locally), against `tests/reference/perf/budgets.json`:
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

## Data pipelines (plan 01, phase 4 data; plan 02's pipeline)

All Python tests are in `tests/python/` with one dependency list (`tests/python/requirements.txt`) and one command,
`pnpm test:py`. Plan 02's drive pipeline tests joined plan 01's there from `tests/data/`; they hold the
JavaScript twins to the Python ones on shared fixtures (`tests/fixtures/`, `tests/unit/*/fixtures/`), check every
route's built data against the drawn ground (`test_ground.py`, with its exceptions in `ground_known.json`, empty), and
read the committed outputs under `public/data/`.

`pnpm test:py` reads the committed outputs of `scripts/build_stars.py`, `build_sky_textures.py` and
`build_lights.py` and checks them against their sidecars and known sky and street facts. `build_nightlights.py` is
tested on small synthetic VNP46A4 tiles written by the test itself; `tests/unit/sky/nightlights.test.js` checks the
real Las Vegas grid against its landmarks once `public/data/lv/nightlights.json` exists, and skips until then.

## Phase 2 (plan 01): the renderer

| Command / spec | What |
|---|---|
| `pnpm test:perf:ab` (`perf.ab.spec.js`, project `gpu-ab`) | The classic renderer (`?renderer=legacy`) and the new one in the same run, interleaved (A B, B A, six pairs of 60 frames per scene), as throughput on this machine's GPU; prints the median per-pair ratio per scene and their geometric mean, and fails above `SKYLINE_AB_GATE` (default 1.15, the ship gate). `SKYLINE_AB_B='backend=webgpu'` times the WebGPU backend. Throughput, not timer queries: on ANGLE Metal a frame timed alone follows the GPU's clock (see `docs/plans/notes/01-phase2-spike.md`) |
| `pnpm test:webgpu` (project `webgpu-software`) | `renderer`, `hooks` and `webgpu` specs on Chromium's software WebGPU adapter, the app forced to `?backend=webgpu`. In the `ci` workflow (started by hand) as a job that does not block a merge yet (decision 6) |
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
## Manual GPU scripts (`tests/manual/`)

Not part of any suite: they render on this machine's GPU (about a second a frame) for measuring the drive's light and
looking at frames while building. Each serves from a running server (`pnpm exec vite --port <port> --strictPort`, or the
production build with `pnpm preview`), takes an output directory outside the repository where it writes one, and gives
its usage in its header. All of them pin the quality level before entering Drive: a level change on the WebGPU backend
currently breaks every later frame (plan 01's shadow map is destroyed while bound). The probes print one line per
quantity with PASS or FAIL, and their exit code is the verdict; run each on the WebGPU backend and once on the WebGL2
one (`--backend webgl`).

| Script | For |
|---|---|
| `lights-probe.mjs` | the street lamps' pools and sprites, the low and high beam on the road and the guide signs' retroreflection, in cd/m² against the plan's pure functions (section 8.3) |
| `screens-luminance.mjs` | the digital and floodlit billboard faces, the Sphere's light on a card (shown, hidden, moved) and the flash rate |
| `rain-probe.mjs` | the wet road against its rules (dry: nothing added; heavy rain: the asphalt against `wetMirror.js`) |
| `traffic-probe.mjs` | a tail lamp's light at the eye, the pool under an oncoming head lamp, a lane ribbon at 6 km |
| `traffic-determinism.mjs` | a play and a seek to the same instant place the same vehicles |
| `night-display.mjs` | the night look as displayed (the driver's adaptation, decision 13): the road in the beams and under lamps, lit windows, the Sphere, a board, in stops from mid-grey |
| `cabin-dash-sun.mjs` | the dashboard under a midday Sun ahead: its displayed luminance against the road's (at most half), with two controls |
| `drive-shots.mjs` | frames of the drive at chosen routes, places, times, views and rain; the model for the others |
| `cabin-shots.mjs`, `rain-shots.mjs`, `screens-shots.mjs` | frames of the cabin (mirrors, windshield, rain on the glass), of the weather, and of the screens and billboards |
| `traffic-smoke.mjs` | the traffic and valley parts' stats and a frame at a place and time |
| `corridor-budget.mjs`, `cabin-check.mjs`, `vehicles-load.mjs` | in Node, no browser: the corridor's meshing budget over the real terrain; the cabin and vehicle GLBs checked against their sidecars |

