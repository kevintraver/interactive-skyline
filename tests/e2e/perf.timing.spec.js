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
