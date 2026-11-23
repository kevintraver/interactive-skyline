// T2.11: the fountain and extras on the new renderer, and the show in the scheduler (plan 01, section 7.12). At
// attractions.freeze(47) the fountain matches the classic renderer within 5 % mean absolute difference on the WebGL2
// backend, by day and by night; with the clock paused nothing animates and no frame is drawn; the same instant shows
// the same jets after any scrub.
import { test, expect } from '@playwright/test';
import { boot, frames } from '../helpers/app.js';
import { openPair, stageScene, grab, compare } from '../helpers/parity.js';

test.describe.configure({ timeout: 900_000 });

const fountainPoint = (page) => page.evaluate(() => {
  const f = window.__skyline.attractions.find('Bellagio');
  const c = f.userData.fountain.center;
  return [c.x, f.userData.fountain.waterY, c.z];
});
// the middle of the frame, where the framed show stands
const CLIP = { x: 340, y: 200, w: 600, h: 400 };

test('the fountain matches the classic renderer within 5 %', async ({ browser }) => {
  const { legacy, fresh } = await openPair(browser, 'lv');
  const point = await fountainPoint(fresh);
  const rows = [];
  for (const look of ['day', 'night']) {
    const scene = { target: { point }, dist: 3.5, elev: 14, look, show: 47 };
    await stageScene(legacy, scene);
    await stageScene(fresh, scene);
    rows.push({ look, ...compare(await grab(legacy, { clip: CLIP, step: 1 }), await grab(fresh, { clip: CLIP, step: 1 })) });
  }
  console.log(JSON.stringify(rows));
  for (const r of rows) expect(r.mad, `fountain by ${r.look}`).toBeLessThanOrEqual(0.05);
  expect([...legacy.errors, ...fresh.errors]).toEqual([]);
});

test('paused, nothing animates and nothing renders; an instant always shows the same jets', async ({ page }, testInfo) => {
  await boot(page, 'lv', 'backend=webgl');
  const point = await fountainPoint(page);
  await stageScene(page, { target: { point }, dist: 3.5, elev: 14, look: 'night' });
  // the clock state, paused, show clocks released: the show follows the (paused) simulation clock
  await page.evaluate(() => {
    const s = window.__skyline;
    s.env.enterClock();
    s.clock.pause();
    s.clock.setLocal({ year: 2026, month: 3, day: 18, hour: 22, minute: 0 });
    // 47 s into the 80 s loop (22:00 itself is the loop's start, when every jet is down)
    s.clock.set(s.clock.timeMs + 47000);
    s.attractions.freeze(null);
    s.invalidate();
  });
  await frames(page, 4);
  await page.waitForFunction(() => window.__skyline.loop.tier === 'idle' && window.__skyline.look.exposure.state.settled, null, { timeout: 120_000 });
  const f0 = await page.evaluate(() => window.__skyline.perf.frames());
  await page.waitForTimeout(5000);
  const paused = await page.evaluate((f) => ({ frames: window.__skyline.perf.frames() - f, animating: window.__skyline.attractions.animating() }), f0);
  expect(paused).toEqual({ frames: 0, animating: false });
  // the same instant after a scrub away and back: the same picture
  const at = await page.evaluate(() => window.__skyline.clock.timeMs);
  const a = await grab(page, { clip: CLIP, step: 2 });
  await testInfo.attach('before', { body: await page.screenshot(), contentType: 'image/png' });
  for (const dt of [17.3e3, 61e3, -40e3, 3600e3 + 13e3]) {
    await page.evaluate((t) => { window.__skyline.clock.set(t); window.__skyline.invalidate(); }, at + dt);
    await frames(page, 2);
  }
  const moved = await grab(page, { clip: CLIP, step: 2 });
  await page.evaluate((t) => { window.__skyline.clock.set(t); window.__skyline.invalidate(); }, at);
  await frames(page, 4);
  await page.waitForFunction(() => window.__skyline.look.exposure.state.settled, null, { timeout: 120_000 });
  const b = await grab(page, { clip: CLIP, step: 2 });
  await testInfo.attach('after', { body: await page.screenshot(), contentType: 'image/png' });
  const same = compare(a, b).mad, other = compare(a, moved).mad;
  const show = await page.evaluate(() => window.__skyline.uniforms.clock.value);
  console.log(JSON.stringify({ same, other, show, at: at / 1000 }));
  expect(show).toBeCloseTo((at / 1000) % 80000, 2); // the show time is the simulated time, wrapped at 80,000 s
  expect(same).toBeLessThan(0.002);
  expect(other).toBeGreaterThan(same);
});
