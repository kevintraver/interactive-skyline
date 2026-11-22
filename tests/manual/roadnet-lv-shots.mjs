// GPU screenshots of tests/manual/roadnet-lv.html. Serve the repo first:
//   pnpm exec vite --port 5201 --strictPort
// then: node tests/manual/roadnet-lv-shots.mjs <out-dir> [shots as JSON [[name, query], ...]] [--software]
// To look at a roadnet that is not in public/data/lv yet, serve its folder with CORS and pass
// data=<its url> in each query.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const software = process.argv.includes('--software');
const out = args[0];
if (!out) throw new Error('usage: node tests/manual/roadnet-lv-shots.mjs <out-dir> [shots-json] [--software]');
mkdirSync(out, { recursive: true });
const shots = args[1] ? JSON.parse(args[1]) : [
  ['exit12-jean', 's=19300'], ['exit25-sloan', 's=40800'], ['exit27-st-rose', 's=43650'],
  ['i215', 's=53900'], ['tropicana', 's=59900'], ['flamingo', 's=61450'], ['spaghetti', 's=67200'],
  ['i215-top', 's=53900&view=top&alt=1400'],
];
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle'];
const browser = await chromium.launch({ args: software ? SOFTWARE : GPU });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of shots) {
  await page.goto(`http://localhost:5201/tests/manual/roadnet-lv.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, (await page.locator('#hud').textContent()).replace(/\n/g, ' | '));
}
await browser.close();
