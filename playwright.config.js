// Playwright: the running app, driven through window.__skyline (plan 01, section 8.1).
//
// Projects
//   webgl2-software  Chromium on SwiftShader (software WebGL2). Deterministic enough for goldens; the one CI runs.
//   gpu              Chromium on this machine's GPU. Local only: timing budgets (pnpm test:perf).
//   software-timing  The timing suite on SwiftShader, gated at 2x (pnpm test:perf:software).
//
// Golden images are per platform (Chromium's text and SwiftShader output differ between macOS and Linux), so
// the snapshot path carries {platform}. A spec compares only when a snapshot for the running platform exists;
// `pnpm test:goldens:update` (or the Linux recipe in tests/README.md) creates them.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SKYLINE_PORT || 4791);
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle'];
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
// WebGPU in headless Chromium, with timestamp queries for the performance hook (src/render/perf.js)
const WEBGPU = ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide' } },
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
    command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'webgl2-software',
      testIgnore: /perf\.(timing|ab)\.spec\.js/,
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
      testMatch: /perf\.ab\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: [...GPU, ...WEBGPU] } },
    },
    {
      // the timing suite on SwiftShader: recorded, and gated only at 2x
      name: 'software-timing',
      testMatch: /perf\.timing\.spec\.js/,
      retries: 2, // a noisy measurement passes when taken again; a real slowdown does not (helpers/perf.js, GATES)
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
  ],
});
