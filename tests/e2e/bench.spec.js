// T2.8: ?bench=1 (plan 01, section 8.7). In the software suite it runs headless, briefly, without error. On a real
// GPU (pnpm test:bench, the gpu-ab project) it plays the 20-second script on both backends and, with
// SKYLINE_BENCH_UPDATE=1, records the result under tests/reference/bench/<machine id>.json.
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { boot } from '../helpers/app.js';
import { PERF_DIR, machineId, writeJsonAt } from '../helpers/perf.js';

test.describe.configure({ timeout: 1_800_000 });

test('?bench=1 runs and reports per-pass times and texture memory', async ({ page }, testInfo) => {
  const real = testInfo.project.name === 'gpu-ab';
  const backends = real ? ['webgpu', 'webgl'] : ['webgl'];
  for (const backend of backends) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page, real ? 'lv' : 'slc', `backend=${backend}&bench=1&nobench=1&q=${real ? 'high' : 'low'}${real ? '' : '&benchSeconds=2&benchFrames=2'}`);
    const result = await page.waitForFunction(() => window.__skyline.bench && window.__skyline.bench.result, null, { timeout: 600_000 })
      .then((h) => h.jsonValue());
    console.log(JSON.stringify(result));
    expect(errors).toEqual([]);
    expect(result.frames).toBeGreaterThan(0);
    expect(result.passesMs.frame).toBeGreaterThan(0);
    expect(result.peakTextureMB).toBeGreaterThan(0);
    if (real && process.env.SKYLINE_BENCH_UPDATE) {
      const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
      const file = path.join(path.dirname(PERF_DIR), 'bench', `${machineId(gpu, os.cpus().length)}.json`);
      writeJsonAt(file, [result.backend], { ...result, recorded: new Date().toISOString().slice(0, 10) });
    }
  }
});
