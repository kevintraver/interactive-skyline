// T2.6: automatic exposure in the app (plan 01, section 7.2). Scrubbing noon -> midnight -> noon shows no frame
// brighter than 1.5x or darker than 0.67x the mean of its two neighbours; a seek lands within 0.3 EV of the
// settled exposure on its first frame at any light level the view has already been metered at (a first seek into a
// new light level lands on the prior plus the last offset; its error is recorded, not gated: up to about 1.2 EV going
// from day into a Las Vegas night, see the phase 2 outcome); after settling, a scene held still renders nothing. (Panning from the Strip
// to the dark west settles in under four seconds: timed on a real GPU, perf.timing.spec.js.)
import { test, expect } from '@playwright/test';
import { boot, frames } from '../helpers/app.js';

test.describe.configure({ timeout: 1_800_000 });

const meanLuma = (page) => page.evaluate(async () => {
  const blob = await window.__skyline.capture();
  const bmp = await createImageBitmap(blob), c = new OffscreenCanvas(64, 40), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, 64, 40);
  const px = g.getImageData(0, 0, 64, 40).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return s / (px.length / 4) / 255;
});

test('scrubbing noon to midnight to noon: no frame jumps in brightness', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 200 });
  // Salt Lake City, the lighter scene: every step moves the Sun and redraws the shadow map, slow on SwiftShader
  await boot(page, 'slc', 'backend=webgl');
  await page.evaluate(() => {
    const s = window.__skyline;
    s.attractions.freeze(47);
    s.setView('ensign');
    s.env.enterClock();
    s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 12, minute: 0 });
  });
  await frames(page, 6);
  const start = await page.evaluate(() => window.__skyline.clock.timeMs);
  const STEP = 20 * 60e3, N = 36; // 20 minutes a step, 12 hours each way
  const luma = [];
  for (let i = 0; i <= 2 * N; i++) {
    const k = i <= N ? i : 2 * N - i;
    await page.evaluate((t) => { const s = window.__skyline; s.clock.set(t); s.invalidate(); }, start + k * STEP);
    await frames(page, 2);
    luma.push(await meanLuma(page));
  }
  const bad = [];
  for (let i = 1; i < luma.length - 1; i++) {
    const m = (luma[i - 1] + luma[i + 1]) / 2, r = luma[i] / Math.max(m, 1e-4);
    if (r > 1.5 || r < 0.67) bad.push({ i, luma: luma[i], neighbours: m, ratio: +r.toFixed(3) });
  }
  console.log(JSON.stringify({ min: Math.min(...luma), max: Math.max(...luma), bad }));
  expect(bad).toEqual([]);
});

test('a seek lands within 0.3 EV of the settled exposure; settled, nothing renders', async ({ page }) => {
  await boot(page, 'lv', 'backend=webgl');
  const settle = () => page.waitForFunction(() => window.__skyline.look.exposure.state.settled, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const s = window.__skyline;
    s.attractions.freeze(47);
    s.setView('east');
    s.env.enterClock();
    s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 10, minute: 0 });
  });
  await settle();
  const rows = [];
  // first visits to 15, 19.5 and 21 h, then a second round at the same hours
  for (const hour of [15, 19.5, 21, 10, 15, 19.5, 21]) {
    const first = await page.evaluate((hour) => new Promise((done) => {
      const s = window.__skyline, f0 = s.perf.frames();
      s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: Math.floor(hour), minute: (hour % 1) * 60 });
      // the exposure of the first frame drawn after the seek
      const check = () => (s.perf.frames() > f0 ? done(s.look.exposure.state.ev) : requestAnimationFrame(check));
      requestAnimationFrame(check);
    }), hour);
    await settle();
    const settled = await page.evaluate(() => window.__skyline.look.exposure.state.ev);
    rows.push({ hour, first, settled, diff: Math.abs(first - settled), revisit: rows.some((r) => r.hour === hour) || hour === 10 });
  }
  // held still once settled: no frame for three seconds
  const f0 = await page.evaluate(() => window.__skyline.perf.frames());
  await page.waitForTimeout(3000);
  const idle = (await page.evaluate(() => window.__skyline.perf.frames())) - f0;
  console.log(JSON.stringify({ rows, idle }));
  test.info().annotations.push({ type: 'seeks', description: JSON.stringify(rows) });
  for (const r of rows.filter((x) => x.revisit)) expect(r.diff, `seek back to ${r.hour} h`).toBeLessThanOrEqual(0.3);
  expect(idle).toBe(0);
});
