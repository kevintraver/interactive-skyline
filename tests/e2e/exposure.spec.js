// T2.6: exposure in the app (plan 01, section 7.2 and decision 14). Scrubbing noon -> midnight -> noon shows no frame
// brighter than 1.5x or darker than 0.67x the mean of its two neighbours (the default, Eye mode).
// Eye mode: the exposure is the prior's alone, so any seek lands on the settled exposure on its first frame (T2.6's
// 0.3 EV line holds by construction), a camera move never changes it, and after a move the frame loop draws one frame
// and goes idle; no meter pass is drawn and nothing is read back.
// Camera mode (metered): a seek lands within 0.3 EV of the settled exposure on its first frame at any light level
// the view has already been metered at (a first seek into a new light level lands on the prior plus the last offset;
// its error is recorded, not gated: up to about 1.2 EV going from day into a Las Vegas night, see the phase 2
// outcome); after settling, a scene held still renders nothing. (Panning from the Strip to the dark west settles in
// under four seconds in Camera mode: timed on a real GPU, perf.timing.spec.js.)
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

test('Camera mode: a seek lands within 0.3 EV of the settled exposure; settled, nothing renders', async ({ page }) => {
  await boot(page, 'lv', 'backend=webgl');
  await page.evaluate(() => window.__skyline.setSetting('exposureMode', 'camera'));
  expect(await page.evaluate(() => window.__skyline.look.exposure.metering)).toBe(true);
  // software frames take seconds; on a timeout, say where the exposure stood
  const settle = () => page.waitForFunction(() => window.__skyline.look.exposure.state.settled, null, { timeout: 600_000 }).catch(async (e) => {
    console.log('not settled', JSON.stringify(await page.evaluate(() => { const x = window.__skyline.look.exposure, st = x.state; return { ...st, biases: st.biases.length, reading: x.lastReadingEv, frames: window.__skyline.perf.frames(), tier: window.__skyline.loop.tier }; })));
    throw e;
  });
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

// Eye mode, the default (decision 14): seeks land on the prior at once; a camera move changes nothing and draws one
// frame; no meter.
test('Eye mode: the exposure follows the light, not the view, and a move draws one frame', async ({ page }) => {
  await boot(page, 'lv', 'backend=webgl');
  const s0 = await page.evaluate(() => ({ mode: window.__skyline.look.exposure.state.mode, metering: window.__skyline.look.exposure.metering }));
  expect(s0).toEqual({ mode: 'eye', metering: false });
  await page.evaluate(() => {
    const s = window.__skyline;
    s.attractions.freeze(47);
    s.setView('east');
    s.env.enterClock();
    s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 10, minute: 0 });
  });
  await page.waitForFunction(() => window.__skyline.loop.tier === 'idle', null, { timeout: 600_000 });
  // seeks: the first frame after each has the exposure the scene keeps
  const seeks = [];
  for (const hour of [15, 19.5, 21, 10]) {
    const first = await page.evaluate((hour) => new Promise((done) => {
      const s = window.__skyline, f0 = s.perf.frames();
      s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: Math.floor(hour), minute: (hour % 1) * 60 });
      const check = () => (s.perf.frames() > f0 ? done(s.uniforms.exposure.value) : requestAnimationFrame(check));
      requestAnimationFrame(check);
    }), hour);
    await frames(page, 3);
    const later = await page.evaluate(() => window.__skyline.uniforms.exposure.value);
    seeks.push({ hour, first, later });
  }
  for (const r of seeks) expect(r.first, `seek to ${r.hour} h`).toBe(r.later);
  // camera moves by the hooks: the exposure stays, each move draws one frame, then the loop is idle
  await page.waitForFunction(() => window.__skyline.loop.tier === 'idle', null, { timeout: 600_000 });
  const moves = [];
  for (const [dx, dz] of [[-3000, 0], [0, 2500], [1500, -1500]]) {
    const before = await page.evaluate(() => ({ k: window.__skyline.uniforms.exposure.value, f: window.__skyline.perf.frames() }));
    await page.evaluate(([dx, dz]) => {
      const s = window.__skyline, c = s.controls;
      c.target.x += dx; c.target.z += dz;
      c.update();
      s.invalidate();
    }, [dx, dz]);
    // the camera's damping may take a few frames to come to rest; then nothing more is drawn
    await page.waitForFunction(() => window.__skyline.loop.tier === 'idle', null, { timeout: 600_000 });
    await frames(page, 30);
    const mid = await page.evaluate(() => window.__skyline.perf.frames());
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => ({ k: window.__skyline.uniforms.exposure.value, f: window.__skyline.perf.frames(), settled: window.__skyline.look.exposure.state.settled, demand: window.__skyline.look.demand() }));
    moves.push({ drawn: mid - before.f, idleFrames: after.f - mid, same: after.k === before.k, settled: after.settled, demand: after.demand });
  }
  console.log(JSON.stringify({ seeks, moves }));
  for (const m of moves) {
    expect(m.same).toBe(true);
    expect(m.idleFrames).toBe(0);
    expect(m.demand).toBe('idle');
    expect(m.drawn).toBeGreaterThanOrEqual(1);
    expect(m.drawn, "frames drawn for a move").toBeLessThanOrEqual(3);
  }
});
