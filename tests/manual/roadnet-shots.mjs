// Screenshots of tests/manual/roadnet.html. Serve the repo first:
//   pnpm exec vite --port 5201 --strictPort
// then: node tests/manual/roadnet-shots.mjs <out-dir>   (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node tests/manual/roadnet-shots.mjs <out-dir>');
mkdirSync(out, { recursive: true });
const shots = process.argv[3] ? JSON.parse(process.argv[3]) : [
  ['orbit-straight', 'view=orbit&s=400'],
  ['orbit-change', 'view=orbit&s=1600'],
  ['driver-straight', 'view=driver&s=300'],
  ['driver-curve', 'view=driver&s=900'],
  ['driver-climb', 'view=driver&s=1900'],
  ['driver-side', 'view=driver&s=300&look=70'],
  ['hill', 'view=hill&s=1500'],
  ['night-driver', 'view=driver&s=300&night=1'],
  ['night-orbit', 'view=orbit&s=400&night=1'],
];
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, q] of shots) {
  await page.goto(`http://localhost:5201/tests/manual/roadnet.html?${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, await page.locator('#hud').textContent());
}
await browser.close();
