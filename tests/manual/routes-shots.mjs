// GPU screenshots of tests/manual/routes-lv.html (any route, through the route loader). Serve the repo first:
//   pnpm exec vite --port 5201 --strictPort   (or another port, passed as PORT=...)
// then: node tests/manual/routes-shots.mjs <out-dir> [shots as JSON [[name, query], ...]] [--software]
// Each query names its route (route=i15s); the default shots are the QA points of D9.1 and D9.2.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const PORT = process.env.PORT || 5201;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const software = process.argv.includes('--software');
const out = args[0];
if (!out) throw new Error('usage: node tests/manual/routes-shots.mjs <out-dir> [shots-json] [--software]');
mkdirSync(out, { recursive: true });
const shots = args[1] ? JSON.parse(args[1]) : [
  ...[0.5, 6.8, 15, 25, 33, 35, 40, 44].map((km) => [`i15s-km${km}`, `route=i15s&s=${km * 1000}`]),
  ...[0.2, 5, 15, 25.2, 35, 45, 55, 59].map((km) => [`us93-km${km}`, `route=us93&s=${km * 1000}`]),
];
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle'];
const browser = await chromium.launch({ args: software ? SOFTWARE : GPU });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of shots) {
  await page.goto(`http://localhost:${PORT}/tests/manual/routes-lv.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, (await page.locator('#hud').textContent()).replace(/\n/g, ' | '));
}
await browser.close();
