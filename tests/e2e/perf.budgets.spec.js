// T0.8, deterministic tier: numbers that do not depend on the machine, enforced in CI and locally against
// tests/reference/perf/budgets.json. Counts (renderer.info, idle frames) must match exactly: a change that moves
// them updates the file in the same commit (SKYLINE_PERF_UPDATE=1, `pnpm test:perf:budgets:update`). Sizes
// (bundle, bytes downloaded) may grow 3 % before the suite fails.
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, boot, stage } from '../helpers/app.js';
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
