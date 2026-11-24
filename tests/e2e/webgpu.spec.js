// The WebGPU backend against the WebGL2 backend (plan 01, phase 2, decision 6): two scenes drawn by each, in the
// same run, within 4 % mean absolute difference, and neither blank. Runs in the webgpu-software project (Chromium's
// software adapter) and on a real GPU (pnpm exec playwright test --project=gpu-ab webgpu).
import { test, expect } from '@playwright/test';
import { openPair, stageScene, grab, compare } from '../helpers/parity.js';

test.describe.configure({ timeout: 900_000 });

for (const [city, scene] of [['lv', { view: 'strat', look: 'night' }], ['slc', { view: 'ensign', look: 'day' }]]) {
  test(`WebGPU and WebGL2 backends agree: ${city} ${scene.view} ${scene.look}`, async ({ browser }) => {
    const { legacy: gl, fresh: gpu } = await openPair(browser, city, { legacy: 'backend=webgl&nobench=1', fresh: 'backend=webgpu&nobench=1' });
    const backends = [await gl.evaluate(() => window.__skyline.backend), await gpu.evaluate(() => window.__skyline.backend)];
    test.skip(backends[1] !== 'webgpu', 'no WebGPU adapter here');
    // the same quality on both (detection may differ between the adapters)
    for (const p of [gl, gpu]) await p.evaluate(() => window.__skyline.quality.set('low'));
    await stageScene(gl, scene);
    await stageScene(gpu, scene);
    for (const p of [gl, gpu]) await p.waitForFunction(() => window.__skyline.look.exposure.state.settled, null, { timeout: 120_000 });
    const a = await grab(gl), b = await grab(gpu);
    const r = compare(a, b);
    console.log(JSON.stringify({ city, ...scene, backends, ...r }));
    expect(r.meanA).toBeGreaterThan(0.03);
    expect(r.meanB).toBeGreaterThan(0.03);
    expect(r.mad).toBeLessThanOrEqual(0.04);
    expect([...gl.errors, ...gpu.errors]).toEqual([]);
  });
}
