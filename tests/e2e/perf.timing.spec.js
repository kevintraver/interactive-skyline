// T0.8, timing tier: frame time, time to ready and edit-to-frame latency, on this machine, against this
// machine's committed baseline (tests/reference/perf/timing/<machine id>.json). Run with `pnpm test:perf` (real
// GPU) or `pnpm test:perf:software` (SwiftShader). Fails if a scene's frame-time median is more than 15 % slower
// or its 95th percentile more than 25 % on three attempts in a row, or if all scenes together are more than 10 %
// slower (helpers/perf.js, GATES, says why both); on a software rasterizer only at 2x, to catch collapses
// without flaking. SKYLINE_PERF_UPDATE=1 rewrites the baseline; a machine with none records one and passes.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, boot, stage } from '../helpers/app.js';
import { PERF_DIR, UPDATING, GATES, FRAME_SLACK_MS, readJson, writeJsonAt, machineId, quantile, median, round, EDIT_LATENCY } from '../helpers/perf.js';

let file, baseline, software, recording, busy = '';

// Cross-origin isolation (on the page only, by the test) raises performance.now() from 0.1 ms to 5 us resolution.
test.beforeEach(async ({ page }) => {
  await page.route((url) => url.pathname === '/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } });
  });
});

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/?city=slc');
  await page.waitForFunction(() => window.__skyline && window.__skyline.perf, null, { timeout: 90_000 });
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  await page.close();
  software = gpu.software;
  // CPU-bound numbers (time to ready, a cutoff rebuild) stretch when other work has the cores; say so in a failure
  const load = os.loadavg()[0];
  busy = load > cores * 0.5 ? `; this machine is busy (load ${load.toFixed(1)} on ${cores} cores), so measure again when it is quiet` : '';
  file = path.join(PERF_DIR, 'timing', `${machineId(gpu, cores)}.json`);
  baseline = readJson(file, null);
  recording = UPDATING || !baseline;
  if (recording) {
    if (fs.existsSync(file)) fs.rmSync(file);
    writeJsonAt(file, ['machine'], { renderer: gpu.renderer, cores, software, os: `${os.platform()} ${os.arch()}` });
    writeJsonAt(file, ['recorded'], new Date().toISOString().slice(0, 10));
  }
});

const gate = (kind) => (software ? GATES.software : GATES[kind]);
/** This run's median-over-baseline ratio per scene; Playwright empties the output folder when a run starts. */
const runFile = (testInfo) => path.join(testInfo.project.outputDir, 'perf-frame-ratios.json');
function check(what, actual, base, kind, slack = 0) {
  if (recording) return;
  expect(base, `${what}: not in the baseline ${path.basename(file)}; rerun with SKYLINE_PERF_UPDATE=1`).toBeDefined();
  const limit = base * gate(kind) + slack;
  expect(actual, `${what}: ${round(actual)} ms against ${round(base)} ms (limit ${round(limit)})${busy}`).toBeLessThanOrEqual(limit);
}

for (const scene of SCENES) {
  test(`frame time ${sceneName(scene)}`, async ({ page }) => {
    await boot(page, scene.city);
    await stage(page, scene);
    // five batches of 120 frames; the batch whose median is the median of the five gives both numbers (GPU clocks
    // vary between batches, measured up to 30 % on an M4)
    const { batches, isolated } = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 5; i++) out.push(await window.__skyline.perf.renderFrames(120));
      return { batches: out, isolated: crossOriginIsolated };
    });
    expect(isolated, 'the page is cross-origin isolated (fine timers)').toBe(true);
    expect(batches[0].ms.length, 'most frames timed').toBeGreaterThan(100);
    const times = batches.map((b) => b.ms).sort((a, b) => median(a) - median(b))[2];
    const m = { median: round(median(times), 3), p95: round(quantile(times, 0.95), 3), method: batches[0].method };
    test.info().annotations.push({ type: 'frame', description: JSON.stringify(m) });
    if (recording) return writeJsonAt(file, ['frame', sceneName(scene)], m);
    const base = baseline.frame?.[sceneName(scene)] || {};
    expect(m.method, 'measured the same way as the baseline').toBe(base.method);
    // recorded before the gates, so a scene that fails still counts in the overall figure (a retry overwrites it)
    if (base.median) writeJsonAt(runFile(test.info()), [sceneName(scene)], round(m.median / base.median, 4));
    check('median', m.median, base.median, 'median');
    check('p95', m.p95, base.p95, 'p95');
  });
}

// after every scene (one worker runs them in this order)
test('frame time, all scenes together', async () => {
  test.skip(recording, 'recording a baseline');
  const ratios = readJson(runFile(test.info()), {});
  const missing = SCENES.map(sceneName).filter((name) => !(name in ratios));
  expect(missing, 'every scene was measured in this run (run the whole file, with one worker)').toEqual([]);
  const values = Object.values(ratios);
  const overall = Math.exp(values.reduce((sum, r) => sum + Math.log(r), 0) / values.length);
  test.info().annotations.push({ type: 'overall', description: JSON.stringify({ overall: round(overall, 4), ratios }) });
  expect(overall, `all scenes together: ${round(overall, 3)}x the baseline (limit ${gate('overall')}x)`).toBeLessThanOrEqual(gate('overall'));
});

for (const city of CITIES) {
  test(`time to ready and edit latency ${city}`, async ({ page }) => {
    const ready = [], first = [];
    for (let i = 0; i < 3; i++) {
      await boot(page, city);
      const t = await page.evaluate(() => ({ ready: performance.getEntriesByName('skyline-ready')[0].startTime,
        first: (performance.getEntriesByName('skyline-frame')[0] || {}).startTime }));
      ready.push(t.ready); first.push(t.first);
    }
    await page.evaluate(() => window.__skyline.attractions.freeze(47));
    const edits = await page.evaluate(EDIT_LATENCY);
    const m = { readyMs: round(median(ready), 1), firstFrameMs: round(median(first), 1),
      edits: Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, round(median(v), 2)])) };
    test.info().annotations.push({ type: 'city', description: JSON.stringify(m) });
    if (recording) return writeJsonAt(file, ['city', city], m);
    const base = baseline.city?.[city] || { edits: {} };
    check('time to ready', m.readyMs, base.readyMs, 'median', 100);
    for (const [k, v] of Object.entries(m.edits)) check(`${k} to frame`, v, base.edits[k], 'median', FRAME_SLACK_MS);
  });
}

// T1.5 (plan 01, phase 1): scrubbing the time of day. Every input event moves the clock, and each rendered frame
// then runs the clock, the ephemeris, env.update and the legacy sky. That CPU work must leave the 16.7 ms of a
// 60 Hz frame to the GPU: gated absolutely at 4 ms (median) per step. The frame rate during a scrub is recorded
// with the scene's own GPU frame time, so a report shows whether 60 fps is held (it cannot be faster than the
// scene itself renders: the phase 0 baseline puts every scene above 13 ms of GPU time on the reference M4).
for (const city of CITIES) {
  test(`scrubbing the time of day ${city}`, async ({ page }) => {
    await boot(page, city);
    await page.evaluate(() => { window.__skyline.attractions.freeze(47); document.getElementById('sky-toggle').click(); });
    const r = await page.evaluate(async () => {
      const s = window.__skyline, scrub = document.getElementById('sky-scrub'), raf = () => new Promise((d) => requestAnimationFrame(d));
      s.env.enterClock();
      s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 6, minute: 0 });
      for (let i = 0; i < 5; i++) await raf();
      // CPU cost of one scrub step: input -> clock -> env.update -> legacy sky (no rendering)
      const cpu = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        scrub.value = String(360 + i * 3);
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        s.env.update();
        cpu.push(performance.now() - t0);
      }
      // frames the app renders while the scrubber moves every animation frame for three seconds
      scrub.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const f0 = s.perf.frames(), t0 = performance.now();
      let i = 0;
      while (performance.now() - t0 < 3000) {
        scrub.value = String(360 + (i++ % 600));
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        await raf();
      }
      const fps = ((s.perf.frames() - f0) * 1000) / (performance.now() - t0);
      scrub.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const gpu = await s.perf.renderFrames(60, 10);
      cpu.sort((a, b) => a - b);
      return { cpuMedianMs: cpu[100], cpuP95Ms: cpu[190], fps, sceneMs: gpu.ms.sort((a, b) => a - b)[30] };
    });
    test.info().annotations.push({ type: 'scrub', description: JSON.stringify(r) });
    expect(r.cpuMedianMs, `a scrub step costs ${round(r.cpuMedianMs)} ms of CPU${busy}`).toBeLessThan(software ? 8 : 4);
    // the scrub renders as fast as the scene can: within 15 % of 1000 / (GPU frame time), capped at 60
    const ceiling = Math.min(60, 1000 / r.sceneMs);
    expect(r.fps, `${round(r.fps)} fps while scrubbing; the scene alone renders at most ${round(ceiling)}${busy}`).toBeGreaterThan(ceiling * (software ? 0.5 : 0.85));
  });
}
