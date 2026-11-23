# Tests

| Command | What | Where it runs |
|---|---|---|
| `pnpm test:unit` | Vitest: `src/core`, extrusion, cities.json shape, source hygiene, the landmark tool, upper bounds on hot code; the drive's frame, terrain and patches, road net, routes, journey, rig and cabin, signs, corridor, traffic, lights (beam, retroreflection, lamps, pools), screens, weather and UI formatting; the data credits (`credits.test.js`) | CI and locally |
| `pnpm test:data` | pytest (through `uv`): the data pipeline's Python twins (frame, heights, roads, interchanges, roadside, barriers, routes, terrain patch, traffic, valley traffic, corridor and its overrides, billboards, lamp packing, beam maps) | CI and locally |
| `pnpm test:e2e` | Playwright, the map's project (`webgl2-software`, below) | CI and locally |
| `pnpm test:e2e:drive` | Playwright, Drive mode on SwiftShader (`drive-software`): about 40 minutes on a quiet machine | locally only |
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

| Project | Specs | Notes |
|---|---|---|
| `webgl2-software` | `baseline`, `hooks`, `interactions`, `buildless`, `perf.budgets` | the map on SwiftShader, 1280 x 800 |
| `drive-software` | `drive.spec.js` (goldens), `drive-ui.spec.js` (route bar, picker, popovers, links), `drive-cabin.spec.js` (the cabin view, its instruments and inputs), `routes.spec.js` (each route and route switching) | after `webgl2-software` |
| `drive-timing` | `drive.perf.spec.js` (the drive's own per-frame JavaScript) | on the GPU, through `pnpm test:perf:drive` |
| `gpu`, `software-timing` | `perf.timing.spec.js` | only through `pnpm test:perf` and `test:perf:software` |

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

Page screenshots apply `tests/reference/screenshot.css`, which hides what was added to the map's default state after
the goldens were made (the Map/Drive switch, the data credit in the corner label).

`pnpm test:goldens:update` rewrites the goldens of the platform it runs on. Do it only when a change is meant to
change the picture, and say so in the commit.

### Drive goldens

`tests/e2e/drive.spec.js` compares the WebGL canvas only (no DOM) at five places on route `i15n` (`drive-km5`,
`drive-km33`, `drive-reveal`, `drive-km62`, `drive-km62-day`) within 0.2 % of pixels, in the same folder and under the
same per-platform rule as the map's. `pnpm test:goldens:drive:update` writes them; it never touches the map's. A
SwiftShader frame of the drive takes seconds (a settled cabin frame draws the world four times, once for each mirror),
so the drive specs have 15- and 30-minute timeouts, share one page per test, and run in a project of their own,
`drive-software`, apart from the map suite (beside it they starve the render-on-demand budgets) and not in CI, whose
job is 45 minutes. Run them on a quiet machine: with other software renderers busy on every core they time out. The
drive's per-frame JavaScript is timed on the GPU in `drive-timing`, where a frame takes milliseconds.

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

## Manual GPU scripts (`tests/manual/`)

Not part of any suite: they render on this machine's GPU (about a second a frame) for looking at frames and measuring
cost while building. Each serves from a running server (`pnpm exec vite --port <port> --strictPort`, or the production
build with `pnpm preview`), takes an output directory outside the repository, and gives its usage in its header.

| Script | For |
|---|---|
| `drive-shots.mjs` | screenshots of the drive at chosen places and times; the model for the others |
| `cabin-shots.mjs`, `cabin-phone-shots.mjs` | the same from the cabin, on desktop and on a phone |
| `drive-ui-shots.mjs`, `routes-app-shots.mjs` | the drive's controls, and any route in the app with its interface |
| `dusk-shots.mjs`, `dusk-scrub.mjs` | the look through dusk by sun elevation; scrubbing across sunset at 16x for jumps |
| `headlights-shots.mjs`, `lamps-shots.mjs`, `polish-shots.mjs` | headlamps and retroreflection; street lamps; general review |
| `traffic-shots.mjs`, `traffic-budget.mjs`, `traffic-lamps-budget.mjs`, `traffic-lamps-check.mjs` | traffic frames, the GPU cost of bodies and of lamps, ribbons and pools, and the lamps and ribbons drawn apart |
| `valley-shots.mjs`, `valley-routes-shots.mjs` | the valley's ribbons and their frame budget; the routes' own carriageways in them |
| `screens-shots.mjs`, `screens-probe.mjs` | screens and billboards; the Sphere's lit patch measured |
| `rain-shots.mjs`, `rain-probe.mjs`, `rain-budget.mjs` | rain frames; road crops dry and wet; the weather part's GPU and JavaScript cost |
| `roadnet.html`, `roadnet-lv.html`, `routes-lv.html`, `signs.html`, `corridor.html`, `vehicles-instancing.html` with their `*-shots.mjs` | dev pages for one layer alone: the road net, each route, the signs, the corridor's buildings, the instanced vehicle bodies |
| `corridor-budget.mjs`, `cabin-check.mjs`, `vehicles-load.mjs` | in Node, no browser: the corridor's meshing budget over the real terrain; the cabin and vehicle GLBs checked against their sidecars |

