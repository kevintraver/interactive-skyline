// The quality level is held while driving (plan 02, the path to the pull request, step 2). On the WebGPU backend a
// change of level while driving was seen to break every later frame ("Destroyed texture ShadowDepthTexture used in a
// submit"), and plan 01's governor lowers the level by itself under load. The fault could not be reproduced at a
// normal load (it was seen at load averages of 130 to 210), so the drive does not depend on it being found: while
// driving, a level chosen in #settings waits until Drive is left, and the governor may still change the render scale
// (which was safe in every run) but not the level. Frames must keep arriving without a console error throughout.
//
// On this machine's GPU only (drive-gpu): the governor needs frames under 250 ms apart to act at all, and on SwiftShader
// a drive frame takes seconds.
import { test, expect } from '@playwright/test';
import { openAt, watchConsole, DRIVE_TIMEOUT } from '../helpers/drive.js';

test.describe.configure({ timeout: DRIVE_TIMEOUT });

const run = (page, fn, arg) => page.evaluate(fn, arg);
/** In the page: draw `n` frames of the loop and return how many the renderer drew. */
const framesDrawn = (page, n) => run(page, async (k) => {
  const s = window.__skyline, f0 = s.renderer.info.frame;
  for (let i = 0; i < k; i++) { s.invalidate(); await new Promise((r) => requestAnimationFrame(r)); }
  return s.renderer.info.frame - f0;
}, n);
const quality = (page) => run(page, () => {
  const q = window.__skyline.quality;
  return { level: q.level, choice: q.choice, renderScale: q.renderScale, held: !!q.held, drops: q.governor ? q.governor.drops : null };
});

test('lv drive: the quality level is held while driving; the render scale may still change', async ({ page }) => {
  const problems = watchConsole(page);
  // the automatic choice, so the governor runs; no fill-rate benchmark, so the detected level stays put
  await openAt(page, 'city=lv&q=auto&nobench=1');
  await run(page, async () => {
    const d = window.__skyline.drive;
    await d.start('i15n', { s: 44200, view: 'cabin', t: Date.parse('2026-11-21T20:30:00Z') }); // by day: the sun casts
    d.play();
  });
  const start = await quality(page);
  expect(start.held, 'the level is held while driving').toBe(true);
  const other = start.level === 'low' ? 'high' : 'low';

  await test.step('a level chosen while driving waits; frames keep arriving', async () => {
    const r = await run(page, (l) => window.__skyline.quality.set(l), other);
    expect(r).toMatchObject({ ok: true, pending: true });
    expect((await quality(page)).level).toBe(start.level);
    expect(await framesDrawn(page, 60)).toBeGreaterThanOrEqual(30);
    expect(problems).toEqual([]);
  });

  await test.step('under load the governor lowers the render scale, and where it would drop a level it keeps it', async () => {
    const r = await run(page, async () => {
      const s = window.__skyline, q = s.quality, raf = () => new Promise((res) => requestAnimationFrame(res));
      // slow frames: 60 ms of the main thread before each draw, over a budget of every level
      const slow = (before) => { if (before) { const e = performance.now() + 60; while (performance.now() < e); } };
      s.pipeline.around.push(slow);
      const scales = new Set();
      const t0 = performance.now();
      while (performance.now() - t0 < 40_000 && !(q.governor.drops >= 1)) { s.invalidate(); await raf(); scales.add(q.renderScale); }
      const f0 = s.renderer.info.frame;
      for (let i = 0; i < 20; i++) { s.invalidate(); await raf(); }
      s.pipeline.around.splice(s.pipeline.around.indexOf(slow), 1);
      return { drops: q.governor.drops, level: q.level, renderScale: q.renderScale, scales: [...scales], after: s.renderer.info.frame - f0 };
    });
    test.info().annotations.push({ type: 'governor', description: JSON.stringify(r) });
    expect(r.drops, 'the governor reached a drop').toBeGreaterThanOrEqual(1);
    expect(r.level, 'and the level was kept').toBe(start.level);
    expect(Math.min(...r.scales), 'the render scale was lowered').toBeLessThanOrEqual(0.6 + 1e-6);
    expect(r.renderScale, 'and stays at its lowest after the drop that was held').toBeLessThanOrEqual(0.6 + 1e-6);
    expect(r.after).toBeGreaterThanOrEqual(10);
    expect(problems).toEqual([]);
  });

  await test.step('leaving Drive applies the level chosen while driving; the map keeps drawing', async () => {
    await run(page, () => window.__skyline.drive.exit());
    expect(await quality(page)).toMatchObject({ held: false, level: other, choice: other });
    expect(await framesDrawn(page, 30)).toBeGreaterThanOrEqual(15);
  });

  expect(problems).toEqual([]);
});
