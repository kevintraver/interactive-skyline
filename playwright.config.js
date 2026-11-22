// Playwright: the running app, driven through window.__skyline (plan 01, section 8.1).
//
// Projects
//   webgl2-software  Chromium on SwiftShader (software WebGL2). Deterministic enough for goldens; the one CI runs.
//   gpu              Chromium on this machine's GPU. Local only: timing budgets (pnpm test:perf).
//
// Golden images are per platform (Chromium's text and SwiftShader output differ between macOS and Linux), so
// the snapshot path carries {platform}. A spec compares only when a snapshot for the running platform exists;
// `pnpm test:goldens:update` (or the Linux recipe in tests/README.md) creates them.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SKYLINE_PORT || 4791);
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle'];

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
      testIgnore: /perf\.timing\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        launchOptions: { args: SOFTWARE } },
    },
    {
      name: 'gpu',
      testMatch: /perf\.timing\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, headless: false,
        launchOptions: { args: ['--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] } },
    },
  ],
});
