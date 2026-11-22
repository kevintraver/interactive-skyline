// T0.8, deterministic tier: numbers that do not depend on the machine, enforced in CI and locally against
// tests/reference/perf/budgets.json. Counts (renderer.info, idle frames) must match exactly: a change that moves
// them updates the file in the same commit (SKYLINE_PERF_UPDATE=1, `pnpm test:perf:budgets:update`). Sizes
// (bundle, bytes downloaded) may grow 3 % before the suite fails.
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, boot, stage } from '../helpers/app.js';

// software frames under load from other sessions: each scene boots, stages, waits for the exposure and counts
test.describe.configure({ timeout: 600_000 });
import { BUDGETS, UPDATING, SIZE_GROWTH, readJson, writeJsonAt, bundleSizes } from '../helpers/perf.js';

const budgets = readJson(BUDGETS, {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MS = 5000;

function checkSize(actual, budget, what) {
  expect(budget, `${what}: no budget yet; run pnpm test:perf:budgets:update`).toBeDefined();
  expect(actual, `${what}: ${actual} bytes against a budget of ${budget} (+3 %)`).toBeLessThanOrEqual(Math.floor(budget * SIZE_GROWTH));
}

test('bundle: gzipped JS and CSS from vite build', async () => {
  const size = bundleSizes();
  test.info().annotations.push({ type: 'bundle', description: JSON.stringify(size) });
  if (UPDATING) return writeJsonAt(BUDGETS, ['bundle'], { jsGzip: size.js, cssGzip: size.css, chunks: size.chunks });
  checkSize(size.js, budgets.bundle?.jsGzip, 'JS gzip');
  for (const [name, gz] of Object.entries(size.chunks)) checkSize(gz, budgets.bundle?.chunks?.[name], `${name} gzip`);
  checkSize(size.css, budgets.bundle?.cssGzip, 'CSS gzip');
});

for (const city of CITIES) {
  test(`bytes downloaded by ${city}`, async ({ page }) => {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
    await boot(page, city);
    const bytes = await page.evaluate(() => {
      const ready = performance.getEntriesByName('skyline-ready')[0].startTime;
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const sum = (list) => list.reduce((a, r) => a + r.encodedBodySize, 0);
      // everything requested before the app was ready (the city, its models, the code), then the extras
      return { beforeReady: nav.encodedBodySize + sum(res.filter((r) => r.startTime < ready)), total: nav.encodedBodySize + sum(res),
        requests: res.length + 1 };
    });
    test.info().annotations.push({ type: 'bytes', description: JSON.stringify(bytes) });
    if (UPDATING) return writeJsonAt(BUDGETS, ['bytes', city], bytes);
    checkSize(bytes.beforeReady, budgets.bytes?.[city]?.beforeReady, `${city} bytes before ready`);
    checkSize(bytes.total, budgets.bytes?.[city]?.total, `${city} bytes in all`);
  });
}

for (const scene of SCENES) {
  test(`scene ${sceneName(scene)}: draw counts and render on demand`, async ({ page }) => {
    await boot(page, scene.city);
    await stage(page, scene);
    const info = await page.evaluate(() => window.__skyline.perf.info());
    await sleep(1000); // anything the staging asked for (view tiles, shadows) is drawn by now
    // held still, nothing may render
    const f0 = await page.evaluate(() => window.__skyline.perf.frames());
    await sleep(IDLE_MS);
    const idleFrozen = (await page.evaluate(() => window.__skyline.perf.frames())) - f0;
    // with the show clocks running, frames are asked for only while something animates in view (at most 30 a second)
    await page.evaluate(() => window.__skyline.attractions.freeze(null));
    await sleep(500);
    const f1 = await page.evaluate(() => window.__skyline.perf.frames());
    await sleep(IDLE_MS);
    const { live, animating } = await page.evaluate((start) => ({ live: window.__skyline.perf.frames() - start, animating: window.__skyline.attractions.animating() }), f1);
    const measured = { info, idleFrozen, animatingInView: animating };
    test.info().annotations.push({ type: 'scene', description: JSON.stringify({ ...measured, live }) });
    if (UPDATING) return writeJsonAt(BUDGETS, ['scenes', sceneName(scene)], measured);
    const budget = budgets.scenes?.[sceneName(scene)];
    expect(budget, 'no budget yet; run pnpm test:perf:budgets:update').toBeDefined();
    expect(info).toEqual(budget.info);
    expect(idleFrozen).toBe(0);
    expect(animating).toBe(budget.animatingInView);
    if (!animating) expect(live).toBe(0);
    else expect(live).toBeLessThanOrEqual(Math.ceil((IDLE_MS / 1000) * 30) + 2);
  });
}

// T1.9 (plan 01, phase 1): the frame loop's tiers, counted in the app. The clock state paused renders nothing;
// the clock at 1x renders twice a second (ambient), not every frame. A small window, so a software frame is quick.
test('frame loop tiers: clock paused renders nothing, the clock at 1x twice a second', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 200 });
  await boot(page, 'slc');
  await page.evaluate(() => {
    const s = window.__skyline;
    s.attractions.freeze(47);
    s.setView('aerial');
    s.env.enterClock();
    s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 12, minute: 0 });
  });
  // let the frames that entering the clock state asked for (the scene, the view tiles 400 ms later) be drawn
  await sleep(1000);
  await page.evaluate(() => window.__skyline.loop.settle());
  await sleep(600);
  await page.evaluate(() => window.__skyline.loop.settle());
  // frames rendered, and animation-frame ticks, over `ms` (on a loaded machine a software frame can take longer
  // than the 500 ms between ambient frames; then every tick renders, and the count says nothing about the tier)
  const count = (ms) => page.evaluate((ms) => new Promise((done) => {
    const s = window.__skyline, f0 = s.perf.frames(), t0 = performance.now();
    let ticks = 0;
    const tick = () => { ticks++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done({ frames: s.perf.frames() - f0, ticks }); };
    requestAnimationFrame(tick);
  }), ms);
  const paused = await count(IDLE_MS);
  await page.evaluate(() => { window.__skyline.clock.setRate(1); window.__skyline.clock.play(); });
  await sleep(600);
  const playing = await count(IDLE_MS);
  const tier = await page.evaluate(() => window.__skyline.loop.tier);
  test.info().annotations.push({ type: 'tiers', description: JSON.stringify({ paused, playing, tier }) });
  expect(paused.frames).toBe(0);
  expect(tier).toBe('ambient');
  expect(playing.frames).toBeLessThanOrEqual(12); // at most 2 a second over 5 s, give or take one at each end
  // and it does render while the clock runs: twice a second on a steady cadence, or every animation frame when
  // they come slower than that (a software frame on a loaded machine); give or take one at each end
  expect(playing.frames).toBeGreaterThanOrEqual(Math.max(1, Math.min(8, playing.ticks - 1)));
});
