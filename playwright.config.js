// Playwright: the running app, driven through window.__skyline (plan 01, section 8.1).
//
// Projects
//   webgl2-software  Chromium on SwiftShader (software WebGL2). Deterministic enough for goldens; the one CI runs.
//   gpu              Chromium on this machine's GPU. Local only: timing budgets (pnpm test:perf).
//   software-timing  The timing suite on SwiftShader, gated at 2x (pnpm test:perf:software).
//   drive-software   Drive mode (drive*.spec.js, routes.spec.js) on SwiftShader, on its own (pnpm test:e2e:drive): a
//                    drive frame takes seconds there, and beside the map suite it starves the render-on-demand
//                    budgets' timing. About 40 minutes; local only.
//   drive-timing     The drive's own per-frame JavaScript (*.perf.spec.js) on this machine's GPU (pnpm test:perf:drive).
//   flight-software  Fly mode (tests/e2e/flight/) on SwiftShader, on its own (pnpm test:e2e:flight). Local only.
//   flight-gpu       The same specs, and the ones named *.gpu.spec.js, on this machine's GPU (pnpm test:flight:gpu).
//
// Several runs at once in one checkout (the plans are built by agents working side by side): give each its own
// build folder and port, SKYLINE_DIST=dist-<name> SKYLINE_PORT=<port>.
//
// Golden images are per platform (Chromium's text and SwiftShader output differ between macOS and Linux), so
// the snapshot path carries {platform}. A spec compares only when a snapshot for the running platform exists;
// `pnpm test:goldens:update` (or the Linux recipe in tests/README.md) creates them.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SKYLINE_PORT || 4791);
const DIST = process.env.SKYLINE_DIST || 'dist';
// No test reaches a real weather service (plan 01, phase 5): their hosts do not resolve in the test browser. A spec
// that wants weather routes it itself (tests/helpers/weatherRoutes.js). This costs nothing, unlike a page.route on
// every request, which slowed each boot by about ten seconds on SwiftShader.
const NO_WEATHER = '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND';
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle', NO_WEATHER];
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), NO_WEATHER];
// WebGPU in headless Chromium, with timestamp queries for the performance hook (src/render/perf.js)
const WEBGPU = ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide',
    // the map goldens predate Drive mode's Map/Drive switch; it is hidden in page screenshots (see the file)
    stylePath: 'tests/reference/screenshot.css' } },
  fullyParallel: true,
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: 'tests/reference/baseline/{platform}/{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  webServer: {
    // the production build, as it is deployed
    command: `pnpm build --outDir ${DIST} && pnpm preview --outDir ${DIST} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'webgl2-software',
      testIgnore: [/perf\.(timing|ab)\.spec\.js|webgpu\.spec\.js/, /\.perf\.spec\.js$/, /(drive[\w.-]*|routes)\.spec\.js$/, /e2e\/flight\//],
      // software frames take seconds, and under load from other work a test can run out of time: one more try, and
      // the report then lists it as flaky. A wrong image or count fails both tries.
      retries: 1,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
    {
      // this machine's GPU, headless (on macOS through Metal); timing only, one worker
      name: 'gpu',
      testMatch: /perf\.timing\.spec\.js/,
      retries: 2, // a noisy measurement passes when taken again; a real slowdown does not (helpers/perf.js, GATES)
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: GPU } },
    },
    {
      // the classic renderer against the new one, interleaved in one run, on this machine's GPU (pnpm test:perf:ab)
      name: 'gpu-ab',
      testMatch: /perf\.ab\.spec\.js|bench\.spec\.js|webgpu\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: [...GPU, ...WEBGPU] } },
    },
    {
      // Chromium's software WebGPU adapter (Dawn on SwiftShader), the app forced to ?backend=webgpu: the flags
      // established by T2.0 (docs/plans/notes/01-phase2-spike.md). Boot, edit, the hooks and the materials on the
      // WebGPU backend without a GPU. Not yet a required CI job (decision 6).
      name: 'webgpu-software',
      testMatch: /renderer\.spec\.js|hooks\.spec\.js|webgpu\.spec\.js/,
      retries: 1,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: ['--enable-unsafe-webgpu', ...SOFTWARE] } },
    },
    {
      // the timing suite on SwiftShader: recorded, and gated only at 2x
      name: 'software-timing',
      testMatch: /perf\.timing\.spec\.js/,
      retries: 2, // a noisy measurement passes when taken again; a real slowdown does not (helpers/perf.js, GATES)
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
    {
      // Drive mode on SwiftShader, run on its own (pnpm test:e2e:drive): about 40 minutes, too long for CI's job
      name: 'drive-software',
      testMatch: /(drive[\w.-]*|routes)\.spec\.js$/,
      testIgnore: /\.perf\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
    {
      // the drive's own per-frame JavaScript, on this machine's GPU like the other timing (pnpm test:perf:drive):
      // on SwiftShader a settled cabin frame draws the world four times and the test does not finish
      name: 'drive-timing',
      testMatch: /\.perf\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: GPU } },
    },
    {
      // Fly mode on SwiftShader (plan 03), on its own like the drive: a flight frame takes seconds there
      name: 'flight-software',
      testMatch: /e2e\/flight\/.*\.spec\.js$/,
      testIgnore: /\.gpu\.spec\.js$/,
      retries: 1,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
    {
      // Fly mode on this machine's GPU: every flight spec, and the timing ones (*.gpu.spec.js)
      name: 'flight-gpu',
      testMatch: /e2e\/flight\/.*\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: [...GPU, ...WEBGPU] } },
    },
  ],
});
