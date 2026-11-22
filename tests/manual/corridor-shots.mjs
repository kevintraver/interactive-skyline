// Screenshots of tests/manual/corridor.html on the GPU. Serve the repo first:
//   pnpm exec vite --port 5251 --strictPort
// then: node tests/manual/corridor-shots.mjs <out-dir> [port] ['[[name, query], ...]']   (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node tests/manual/corridor-shots.mjs <out-dir> [port] [shots]');
const port = process.argv[3] || 5251;
mkdirSync(out, { recursive: true });
const places = [['km0.5', 0.5], ['km19', 19], ['km40', 40], ['km46', 46], ['km50', 50], ['km53', 53], ['km56', 56]];
const shots = process.argv[4] ? JSON.parse(process.argv[4]) : [
  ...places.flatMap(([n, km]) => [[`${n}-day`, `km=${km}`], [`${n}-night`, `km=${km}&night=1`]]),
  ['above-primm', 'view=above&at=-19500,-55900&alt=2600'],
  ['above-strose', 'view=above&at=-800,-13300&alt=11000'],
];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, query] of shots) {
  await page.goto(`http://localhost:${port}/tests/manual/corridor.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  const us = await page.evaluate(() => window.__updateUs);
  console.log('shot', name, (await page.locator('#hud').textContent()).replace(/\n/g, ' | '), `| update ${us.toFixed(2)} µs`);
}
await browser.close();
