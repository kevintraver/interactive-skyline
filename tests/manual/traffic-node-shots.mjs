// Parity of the traffic's node modules with their GLSL ones (plan 02, third stretch, decision 1), on this machine's
// GPU, through tests/manual/traffic-node.html. Serve the repo first:
//   pnpm exec vite --port 5313 --strictPort
// then: node tests/manual/traffic-node-shots.mjs <out-dir> [port] [--cost] [--only=a,b]   (keep the out dir outside the repo)
//
// Per fixture it draws the GLSL modules on a WebGLRenderer and the node modules on a WebGPURenderer, once on its
// WebGL2 backend (forceWebGL) and once on WebGPU, into a half-float target with linear output, and prints per backend
//   rel  the difference as a share of what the module draws: sum |node - glsl| / sum |glsl - background| over RGB,
//        where background is the GLSL frame with the module's objects hidden. The verdict: PASS under LIMIT (2 %).
//   mad  the mean absolute difference per channel over the pixels either frame changes (linear units), for scale.
// and writes <case>.glsl.png, <case>.<backend>.png and <case>.<backend>.diff.png (|difference| x 10, same scale).
// --no-msaa: draw without multisampling (a probe; the verdicts are recorded with 4x).
// --cost: also the GPU time of each module (its objects shown minus hidden, median of 60 frames) on the three.
// Exits 1 when any case fails.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
if (!out) throw new Error('usage: node tests/manual/traffic-node-shots.mjs <out-dir> [port] [--cost] [--only=a,b]');
const port = args.filter((a) => !a.startsWith('--'))[1] || 5313;
const cost = args.includes('--cost');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const samples = args.includes('--no-msaa') ? 0 : 4;
const LIMIT = 0.02;
const BACKENDS = ['webgl2', 'webgpu'];
mkdirSync(out, { recursive: true });

const load = () => { try { return execSync('uptime').toString().trim(); } catch { return 'n/a'; } };
console.log('load before:', load());
const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${m.type()}]`, m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
const open = async () => {
  await page.goto(`http://localhost:${port}/tests/manual/traffic-node.html?samples=${samples}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
};
await open();
// other work in the checkout can make Vite reload the page mid-run: open it again and retry once
const call = async (fn, arg) => {
  try { return await page.evaluate(fn, arg); } catch (e) {
    if (!/context was destroyed|navigation/i.test(e.message)) throw e;
    console.log('  (page reloaded under the run; retrying)');
    await open();
    return page.evaluate(fn, arg);
  }
};
const gpu = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter?.();
  const g = document.createElement('canvas').getContext('webgl2'); const e = g?.getExtension('WEBGL_debug_renderer_info');
  return { webgl: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a', webgpu: a ? `${a.info?.vendor} ${a.info?.architecture}` : 'none' };
});
console.log('gpu:', JSON.stringify(gpu));

const cases = (await page.evaluate(() => window.__cases)).filter((c) => !only || only.includes(c));
const rows = [];
const save = (url, file) => { if (url) writeFileSync(file, Buffer.from(url.split(',')[1], 'base64')); };
for (const name of cases) {
  for (const be of BACKENDS) {
    let r;
    try { r = await call(([n, be]) => window.__compare(n, be), [name, be]); } catch (e) {
      console.log(`${name} ${be}: ERROR ${e.message.split('\n')[0].slice(0, 300)}`);
      rows.push([name, be, null, null, 'FAIL']);
      continue;
    }
    const verdict = r.rel < LIMIT && !r.nan ? 'PASS' : 'FAIL';
    rows.push([name, be, r.rel, r.mad, verdict]);
    console.log(`${name.padEnd(28)} ${be.padEnd(7)} rel ${(100 * r.rel).toFixed(3).padStart(8)} %   mad ${r.mad.toExponential(2)} over ${r.n} px${r.nan ? `  ${r.nan} non-finite` : ''}   ${verdict}`);
    save(r.png.ref, `${out}/${name}.glsl.png`);
    save(r.png.test, `${out}/${name}.${be}.png`);
    save(r.png.diff, `${out}/${name}.${be}.diff.png`);
  }
}
const failed = rows.filter((r) => r[4] !== 'PASS').length;
console.log(`\n${rows.length - failed} PASS, ${failed} FAIL (limit ${LIMIT * 100} %)`);
writeFileSync(`${out}/parity.json`, JSON.stringify({ gpu, rows }, null, 1));

if (cost) {
  console.log('\ncost: GPU ms of the module\'s objects (shown - hidden), median of 60 frames, 512 x 320, MSAA 4x half float');
  console.log('load before cost:', load());
  const costs = [];
  for (const name of await page.evaluate(() => window.__costCases)) {
    const r = { name };
    for (const be of ['glsl', ...BACKENDS]) {
      try { r[be] = await call(([n, be]) => window.__cost(n, be, 60), [name, be]); } catch (e) { r[be] = { error: e.message.split('\n')[0].slice(0, 200) }; }
    }
    costs.push(r);
    const f = (x) => (x?.error ? `ERROR ${x.error}` : x?.delta == null ? 'n/a' : `${x.delta.toFixed(3)} (on ${x.on.toFixed(3)}, off ${x.off.toFixed(3)})`);
    console.log(`${name.padEnd(8)} glsl ${f(r.glsl)} | webgl2 ${f(r.webgl2)} | webgpu ${f(r.webgpu)}`);
  }
  writeFileSync(`${out}/cost.json`, JSON.stringify(costs, null, 1));
  console.log('load after:', load());
}
await browser.close();
process.exit(failed ? 1 : 0);
