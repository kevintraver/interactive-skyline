// The parity loop of the light sprites and the surface-light helper (plan 02, third stretch, decision 1): drives
// tests/manual/sprites-node.html, which draws one fixture with the GLSL modules on a WebGLRenderer and with the node
// modules on a WebGPURenderer (WebGL2 and WebGPU backends), and prints per case the mean absolute difference (in % of
// full scale), the difference relative to the reference's summed light, and PASS or FAIL (limit 2 % on both); then the
// flux of single node sprites against I / d^2 (limit 3 %); then, with --cost, the GPU time of 80,000 sprites in view.
// Exits 1 if any case fails.
//
// Serve the repo first:   pnpm exec vite --port 5312 --strictPort
// then:                   node tests/manual/sprites-node-shots.mjs <out-dir> [port] [--cost] [--only a,b] [--page-query 'perturb=1.03']
// (--page-query checks the loop itself: 'missing=1' or 'perturb=1.03' must make it FAIL; see the page's header)
// (keep the out dir outside the repo: it gets a PNG per case, reference | node WebGL2 | node WebGPU | difference x 8)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a, i) => !a.startsWith('--') && !['--only', '--page-query'].includes(args[i - 1]));
const pageQuery = args.includes('--page-query') ? `?${args[args.indexOf('--page-query') + 1]}` : '';
const out = positional[0];
const port = positional[1] || 5312;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
if (!out) { console.error('usage: node tests/manual/sprites-node-shots.mjs <out-dir> [port] [--cost] [--only a,b]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 400)}`));
let failed = 0;
try {
  await page.goto(`http://localhost:${port}/tests/manual/sprites-node.html${pageQuery}`);
  await page.waitForFunction(() => window.__parity, null, { timeout: 120000 });
  const info = await page.evaluate(() => ({ gpu: window.__parity.gpu, backends: window.__parity.backends, cases: window.__parity.cases, spriteCases: window.__parity.spriteCases }));
  console.log(`GPU: ${info.gpu}; node backends: ${JSON.stringify(info.backends)}`);

  const pad = (s, n) => String(s).padEnd(n);
  const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
  console.log(`\n${pad('case', 20)}${pad('backend', 26)}${pad('MAD %', 10)}${pad('rel %', 10)}${pad('max abs', 10)}verdict`);
  const cases = (only || info.cases).filter((c) => info.cases.includes(c));
  const runs = cases.flatMap((c) => (info.spriteCases.includes(c) ? [[c, 'toned'], [c, 'hdr']] : [[c, 'toned']]));
  for (const [name, mode] of runs) {
    const r = await page.evaluate(([n, m]) => window.__parity.run(n, m), [name, mode]);
    for (const row of r.rows) {
      if (!row.pass) failed++;
      if (row.error) console.log(`${pad(r.name, 20)}${pad(row.backend, 26)}FAIL  ${row.error}`);
      else console.log(`${pad(r.name, 20)}${pad(row.backend, 26)}${pad(f(row.madPct, 4), 10)}${pad(f(row.relPct, 3), 10)}${pad(f(row.maxAbs, 4), 10)}${row.pass ? 'PASS' : 'FAIL'}`);
    }
    if (r.images) writeFileSync(`${out}/${r.name.replace('/', '-')}.png`, Buffer.from(r.images.split(',')[1], 'base64'));
  }
  if (!only || only.includes('building-term')) {
    const b = await page.evaluate(() => window.__parity.building());
    for (const row of b.rows) {
      if (!row.pass) failed++;
      console.log(row.error ? `${pad(b.name, 20)}${pad(row.backend, 26)}FAIL  ${row.error}`
        : `${pad(b.name, 20)}${pad(row.backend, 26)}rel ${f(row.relPct, 3)} % over ${row.boxPixels} px; after removal max abs ${row.restoredMaxAbs}; emissiveNode kept ${row.emissiveKept}; own props left ${row.ownAfterRemove}; terms were [${row.terms}]  ${row.pass ? 'PASS' : 'FAIL'}`);
    }
  }

  if (!only || only.includes('flux')) {
    const fl = await page.evaluate(() => window.__parity.flux());
    console.log(`\nflux (node layer, linear, classic scale): summed light x pixel solid angle / gain against I / d^2, limit 3 %`);
    console.log(`${pad('backend', 26)}${pad('d m', 8)}${pad('diam m', 8)}${pad('px', 8)}${pad('lux drawn', 14)}${pad('I/d^2', 14)}${pad('err %', 9)}verdict`);
    for (const row of fl) {
      if (!row.pass) failed++;
      if (row.error) { console.log(`FAIL ${row.error}`); continue; }
      console.log(`${pad(row.backend, 26)}${pad(row.d, 8)}${pad(row.diameterM, 8)}${pad(row.dPx, 8)}${pad(row.lux.toExponential(4), 14)}${pad(row.want.toExponential(4), 14)}${pad(f(row.errPct, 2), 9)}${row.pass ? 'PASS' : 'FAIL'}`);
    }
  }

  if (flags.has('--cost')) {
    console.log('\ncost: GPU time of the sprites\' render call, 1280 x 720, ms (lamps log-uniform from "near" to 15 km; three repeats)');
    console.log(`${pad('layer', 34)}${pad('near m', 8)}${pad('n', 8)}${pad('p50', 9)}${pad('p95', 9)}${pad('1 sprite', 10)}samples`);
    for (const nearM of [30, 200]) {
      for (let rep = 0; rep < 3; rep++) {
        const c = await page.evaluate((m) => window.__parity.cost(80000, 40, m), nearM);
        for (const row of c) console.log(`${pad(row.layer, 34)}${pad(row.nearM, 8)}${pad(row.n, 8)}${pad(f(row.p50, 3), 9)}${pad(f(row.p95, 3), 9)}${pad(f(row.oneSpriteP50, 3), 10)}${row.samples}`);
      }
    }
  }
} finally {
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}
console.log(`\n${failed ? `${failed} FAIL` : 'all PASS'}`);
process.exit(failed ? 1 : 0);
