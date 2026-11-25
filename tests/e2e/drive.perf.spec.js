// Timing of the drive's own per-frame JavaScript (journey, rig with the body and head layers, road chunks, signs,
// controls, and the cabin pass's own JavaScript). Frame time as a whole means nothing under the software renderer,
// so this is the number the drive is held to. It runs in the default view, the cabin.
//
// It runs in the `drive-timing` project, alone and after everything else (see playwright.config.js): with
// several software renderers busy on every core the page being timed is starved, and the same code that
// takes 0.9 ms at the 95th percentile on its own was measured at 6.8 ms. To run just this:
//   pnpm exec playwright test --project=drive-timing --no-deps
import { test, expect } from '@playwright/test';
import { openCity, DRIVE_TIMEOUT } from '../helpers/drive.js';

const ROUTE = 'i15n';

test.describe.configure({ timeout: DRIVE_TIMEOUT });

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
    const seeks = { ...st.js, frames: st.js.total.count - before, view: d.pose().view, cabin: st.cabin?.js ?? null };
    // Playing: the steady state the budget is for. The timings keep their last 240 samples, so 300 frames of play
    // leave only playing frames in them. In the city, where traffic, lamps and signs are densest.
    d.seek({ s: 60000 });
    await d.whenSettled();
    d.play();
    await new Promise((resolve) => { let n = 0; const step = () => (++n >= 300 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });
    d.pause();
    const pl = d.stats();
    return { seeks, playing: { total: pl.js.total, cabin: pl.cabin?.js ?? null } };
  }, ROUTE);
  console.log('drive per-frame JS (ms):', JSON.stringify(js));
  const { seeks, playing } = js;
  expect(seeks.view).toBe('cabin');
  expect(seeks.total.count).toBeGreaterThanOrEqual(60);
  // a seek's frame: the pose jumps a kilometre and everything is placed afresh
  expect(seeks.total.p95).toBeLessThan(4);
  expect(seeks.total.max).toBeLessThan(16);
  // While playing, the drive's own work and the cabin's (drawn after the world: its displays, one mirror's set-up,
  // the glass) share the main thread's 4 ms (plan 02, section 9.1). A paused frame is not held to it: it redraws
  // all three mirrors so that what is settled is current, three times the cabin's playing cost.
  expect(playing.cabin?.count).toBeGreaterThan(0);
  expect(playing.total.p95 + playing.cabin.p95).toBeLessThan(4);
});
