// Screenshots of tests/manual/vehicles-instancing.html. Serve the repo first:
//   pnpm exec vite --port 5243 --strictPort
// then: node tests/manual/vehicles-shots.mjs <out-dir> [port]   (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node tests/manual/vehicles-shots.mjs <out-dir> [port]');
const port = process.argv[3] || 5243;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const lod of ['lod0', 'lod1']) {
  await page.goto(`http://localhost:${port}/tests/manual/vehicles-instancing.html?lod=${lod}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.screenshot({ path: `${out}/instancing_${lod}.png` });
  console.log('shot', lod, JSON.stringify(await page.evaluate(() => window.__info)));
}
await browser.close();
