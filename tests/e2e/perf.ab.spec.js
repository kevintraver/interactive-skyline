// A/B frame time (plan 01, T2.0 and the phase 2 ship gate): the classic renderer and the new one, in the same run,
// interleaved, on this machine's GPU. A shared, noisy machine can double a frame time between two runs, so a new
// measurement is never compared with a committed number here: both renderers are loaded side by side in two
// pages, staged in the same scene at the same size, and timed in alternation (A B, B A, ...), as throughput:
// a batch of frames submitted back to back, ended by a wait for the GPU (perf.throughput() says why not timer
// queries). The verdict is the median of the per-pair ratios B / A, per scene, and their geometric mean overall.
//
//   pnpm test:perf:ab                       classic (?renderer=legacy) against the default renderer, WebGL2 backend
//   SKYLINE_AB_B='backend=webgpu' ...       against the WebGPU backend (the same throughput measure)
//   SKYLINE_AB_A, SKYLINE_AB_B              the two query strings; SKYLINE_AB_ROUNDS pairs per scene (default 6);
//   SKYLINE_AB_GATE                         the overall limit (default 1.15, the phase 2 ship gate; 1.25 at T2.0)
//   SKYLINE_AB_SCENES                       a comma-separated subset of scene names
//
// Prints a table of ratios and writes it to test-results/<project>/perf-ab.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, stage } from '../helpers/app.js';
import { median, round } from '../helpers/perf.js';

const A = process.env.SKYLINE_AB_A ?? 'renderer=legacy&nobench=1';
// q=high: the quality held (the governor would change the render scale during a measurement)
const B = process.env.SKYLINE_AB_B ?? 'backend=webgl&nobench=1&q=high';
const ROUNDS = Number(process.env.SKYLINE_AB_ROUNDS || 6);
const GATE = Number(process.env.SKYLINE_AB_GATE || 1.15);
const ONLY = process.env.SKYLINE_AB_SCENES ? new Set(process.env.SKYLINE_AB_SCENES.split(',')) : null;
const FRAMES = 60, WARM = 10;

test.describe.configure({ mode: 'serial' });
test.setTimeout(20 * 60_000);

async function open(browser, city, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?city=${city}${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 120_000 });
  await page.evaluate(() => window.__skyline.attractions.ready);
  page.errors = errors;
  return page;
}

// throughput (src/render/perf.js says why: GPU timer queries on ANGLE Metal follow the GPU's clock, not the work)
const time = (page) => page.evaluate(async ([n, warm]) => {
  const r = await window.__skyline.perf.throughput(n, warm);
  return { med: r.msPerFrame, method: r.method };
}, [FRAMES, WARM]);

const results = {};

for (const city of CITIES) {
  test(`A/B frame time ${city}`, async ({ browser }, testInfo) => {
    const scenes = SCENES.filter((s) => s.city === city && (!ONLY || ONLY.has(sceneName(s))));
    test.skip(!scenes.length, 'no scene of this city selected');
    const a = await open(browser, city, A), b = await open(browser, city, B);
    const backends = { a: await a.evaluate(() => window.__skyline.perf.gpu()), b: await b.evaluate(() => window.__skyline.perf.gpu()) };
    for (const scene of scenes) {
      await stage(a, scene);
      await stage(b, scene);
      const ratios = [], am = [], bm = [];
      let methods;
      for (let i = 0; i < ROUNDS; i++) {
        // alternate which goes first, so a clock ramp or a neighbour's burst does not favour one side
        const first = i % 2 ? b : a, second = i % 2 ? a : b;
        const r1 = await time(first), r2 = await time(second);
        const ra = i % 2 ? r2 : r1, rb = i % 2 ? r1 : r2;
        am.push(ra.med); bm.push(rb.med); ratios.push(rb.med / ra.med);
        methods = [ra.method, rb.method];
      }
      results[sceneName(scene)] = { ratio: round(median(ratios), 3), aMs: round(median(am), 2), bMs: round(median(bm), 2),
        ratios: ratios.map((r) => round(r, 3)), methods };
    }
    expect([...a.errors, ...b.errors], 'page errors').toEqual([]);
    await a.close(); await b.close();
    testInfo.annotations.push({ type: 'backends', description: JSON.stringify(backends) });
  });
}

test('A/B overall', async ({}, testInfo) => {
  const names = Object.keys(results);
  expect(names.length, 'run the whole file: the per-city tests fill the table').toBeGreaterThan(0);
  const overall = Math.exp(names.reduce((s, n) => s + Math.log(results[n].ratio), 0) / names.length);
  const report = { a: A, b: B, rounds: ROUNDS, frames: FRAMES, load: round(os.loadavg()[0], 1), overall: round(overall, 3), gate: GATE,
    date: new Date().toISOString(), scenes: results };
  const lines = [`A = ?${A}   B = ?${B}   ${ROUNDS} pairs of ${FRAMES} frames per scene, load ${report.load}`,
    'scene                      A ms    B ms   B/A (median of pairs)'];
  for (const n of names) lines.push(`${n.padEnd(24)} ${String(results[n].aMs).padStart(6)}  ${String(results[n].bMs).padStart(6)}   ${results[n].ratio}`);
  lines.push(`overall (geometric mean)                   ${report.overall}   gate ${GATE}`);
  console.log(lines.join('\n'));
  fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
  fs.writeFileSync(path.join(testInfo.project.outputDir, 'perf-ab.json'), `${JSON.stringify(report, null, 2)}\n`);
  testInfo.annotations.push({ type: 'ab', description: JSON.stringify(report) });
  expect(overall, `the new renderer is ${round(overall, 3)}x the classic one overall (limit ${GATE})`).toBeLessThanOrEqual(GATE);
});
