// Timing of the drive's own per-frame JavaScript (journey, rig, road chunks, signs, controls). Frame time as
// a whole means nothing under the software renderer, so this is the number the drive is held to.
//
// It runs in the `perf` project, alone and after everything else (see playwright.config.js): with three
// software renderers busy on every core the page being timed is starved, and the same code that takes
// 0.9 ms at the 95th percentile on its own was measured at 6.8 ms. To run just this:
//   E2E_PORT=5199 pnpm exec playwright test --project=perf --no-deps
import { test, expect } from '@playwright/test';
import { openCity } from './helpers.js';

const ROUTE = 'i15n';

test.describe.configure({ timeout: 900_000 });

test('lv drive: its own JavaScript stays within the per-frame budget', async ({ page }) => {
  await openCity(page, 'lv');
  const js = await page.evaluate(async (id) => {
    const d = window.__skyline.drive;
    await d.start(id, { s: 5000 });
    d.pause();
    const length = d.route().s1;
    d.stats(); // warm
    const before = d.stats().js.total.count;
    for (let i = 0; i < 60; i++) {
      d.seek({ s: (i + 0.5) * (length / 60) });
      await d.whenSettled();
    }
    const st = d.stats();
    return { ...st.js, frames: st.js.total.count - before };
  }, ROUTE);
  console.log('drive per-frame JS (ms):', JSON.stringify(js));
  expect(js.total.count).toBeGreaterThanOrEqual(60);
  expect(js.total.p95).toBeLessThan(4);
  expect(js.total.max).toBeLessThan(16);
});
