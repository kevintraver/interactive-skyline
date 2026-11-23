# Plan 01, phase 2: local report from a real GPU

Decision 6 of plan 01: until the `webgpu-software` CI job is required, changes under `src/render`, `src/sky`,
`src/weather` or the materials need a committed report from a real GPU. This is phase 2's.

Machine: Apple M4, 10 cores, macOS (darwin arm64). Chromium 1255 (Playwright 1.65.1) headless, ANGLE Metal for
WebGL2, Dawn Metal for WebGPU; three `0.187.0`. Other sessions loaded the machine throughout (load 6 to 54 on
10 cores); every comparison below is between two renderers in the same run, interleaved, which that load moves
far less than it moves a single measurement.

## Frame time against the classic renderer (the ship gate)

`pnpm test:perf:ab`: the classic renderer (`?renderer=legacy`) and the new one (`q=high`: MSAA 4x, half-resolution
bloom, the quality held) in two pages of one browser, each scene staged in both, six alternating pairs (A B, B A,
...) of 60 frames, as throughput (frames submitted back to back, ended by a wait for the GPU). Ratio B / A, the
median of the six pairs; overall the geometric mean. Final runs, 23 November 2026, load 2.5 and 4.1:

| Scene | classic ms | WebGL2 backend ms | ratio | classic ms | WebGPU backend ms | ratio |
|---|---|---|---|---|---|---|
| slc-ensign-day | 16.67 | 20.61 | 1.249 | 16.74 | 14.90 | 0.904 |
| slc-ensign-night | 15.93 | 20.50 | 1.293 | 16.29 | 15.20 | 0.898 |
| slc-aerial-day | 14.84 | 17.91 | 1.205 | 14.64 | 13.57 | 0.946 |
| slc-aerial-night | 14.75 | 18.10 | 1.224 | 15.10 | 13.69 | 0.910 |
| lv-east-day | 20.05 | 19.54 | 0.975 | 19.61 | 15.98 | 0.812 |
| lv-east-night | 18.95 | 19.84 | 1.051 | 19.20 | 15.35 | 0.793 |
| lv-strat-day | 18.98 | 21.00 | 1.092 | 18.56 | 15.74 | 0.840 |
| lv-strat-night | 19.22 | 19.98 | 1.053 | 19.44 | 16.79 | 0.858 |
| lv-aerial-day | 21.84 | 25.47 | 1.148 | 22.19 | 20.62 | 0.899 |
| lv-aerial-night | 21.90 | 25.13 | 1.140 | 22.31 | 20.13 | 0.875 |
| **overall** | | | **1.139** | | | **0.872** |

Gate: 1.15 overall. The WebGL2 backend passes overall by a narrow margin, and **the four Salt Lake City scenes do not
pass one by one (1.21 to 1.29)**: their scene is lighter, so the new renderer's fixed costs (a half-float MSAA
target and its resolve, the output pass with tone mapping, the bloom chain) weigh more. The WebGPU backend, which
most visitors get, is faster than the classic renderer in every scene.

How the gate was reached, for the record: a first run found 1.97x (the scene pass was drawn a second time when
three's BloomNode sampled it); after that fix 1.033, but that run measured the new renderer on automatic quality
while the governor had lowered its render scale at start-up, so it was flattered; at fixed High it was 1.346, with
three's BloomNode costing about 3.5 ms; replacing it with the chain of section 7.3 gave 1.139.

## Per pass (`?bench=1`, `tests/reference/bench/`)

High, 1280 x 800, the 20-second script (06:00 to 22:00 while orbiting the first view), per pass by difference
with throughput (three r187 does not split its timestamps per pass, so single passes are noisy):

| | WebGPU | WebGL2 |
|---|---|---|
| frame | 23.2 ms | 25.1 ms |
| scene pass | 16.4 ms | 21.6 ms |
| bloom (by difference; noisy) | 7.3 ms | 5.4 ms |
| exposure meter | (below noise) | (below noise) |
| peak texture memory | 310 MB | 310 MB |
| CPU per scripted frame (median, p95) | 13.8, 23.0 ms | 15.7, 30.5 ms |

(Recorded on 23 November with the GPU shared with the desktop's window server: every figure is higher than the
first recording, 14.0 and 14.3 ms a frame, and the bloom-by-difference figures disagree with a direct measurement
on the same machine the same hour, where the pipeline with bloom cost 20.1 ms against 20.4 ms without. Use the A/B
ratios above, not these absolute numbers.)

The CPU figure includes redrawing the shadow map on every frame (the Sun moves with the scripted clock). Without
it the new renderer submits a frame in about 5.4 ms of CPU against 1.1 ms for the classic one (measured on the
same page): the CPU, not the GPU, is its tight resource.

## WebGPU backend

Booted, rendered and edited in every case tried: the A/B above, `?bench=1`, the screenshots, Safari's engine
(Playwright WebKit picks the WebGPU backend here) and the WebGPU-against-WebGL2 comparison of two scenes
(`webgpu.spec.js`, see the phase 2 outcome for its result). Timestamp queries work in headless Chromium with
`--enable-unsafe-webgpu --enable-webgpu-developer-features`.

## Not measured

The integrated-GPU laptop and the phone of section 9 (no such device here). The real-GPU numbers above are from
one machine.
