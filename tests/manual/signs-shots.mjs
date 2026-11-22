// Screenshots of tests/manual/signs.html on the GPU (about a second a frame). Serve the repo first:
//   pnpm exec vite --port 5241 --strictPort
// then: node tests/manual/signs-shots.mjs <out-dir> [port] ['[[name, query], ...]']   (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node tests/manual/signs-shots.mjs <out-dir> [port] [shots]');
const port = process.argv[3] || 5241;
mkdirSync(out, { recursive: true });
const shots = process.argv[4] ? JSON.parse(process.argv[4]) : [['advance-150', 's=18726']];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of shots) {
  await page.goto(`http://localhost:${port}/tests/manual/signs.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, (await page.locator('#hud').textContent()).replace(/\n/g, ' | '));
}
await browser.close();
