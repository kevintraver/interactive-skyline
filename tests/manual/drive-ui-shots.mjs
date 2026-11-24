// Screenshots of Drive mode's controls on the GPU (about a second a frame), for looking at the route card,
// the route bar and the time popover at desktop and phone sizes, in the day and night looks. Serve first:
//   pnpm exec vite --port 5221 --strictPort
// then: node tests/manual/drive-ui-shots.mjs <out-dir> [port]   (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
const port = process.argv[3] || 5221;
if (!out) throw new Error('usage: node tests/manual/drive-ui-shots.mjs <out-dir> [port]');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); } catch { /* defaults */ } });
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 120000 });
await page.getByRole('button', { name: 'Drive', exact: true }).click();
await page.evaluate(async () => {
  const d = window.__skyline.drive;
  while (!d.active() || !d.pose() || !d.pose().playing) await new Promise((r) => requestAnimationFrame(r));
  d.pause();
});

const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T04:30:00Z');
const at = (s, t) => page.evaluate(async ({ s, t }) => {
  const d = window.__skyline.drive;
  d.seek({ s, t });
  await d.whenSettled();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return d.pose().night;
}, { s, t });
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };
const openTime = async (on) => {
  const open = await page.evaluate(() => document.querySelector('#drivebar .time').getAttribute('aria-expanded') === 'true');
  if (open !== on) await page.click('#drivebar .time');
};

for (const [w, h, tag] of [[1280, 720, 'desk'], [1024, 700, 'mid'], [390, 844, 'phone']]) {
  await page.setViewportSize({ width: w, height: h });
  for (const [look, t] of [['day', DAY], ['night', NIGHT]]) {
    await at(62000, t);
    await openTime(false);
    await shot(`${tag}-${look}`);
    await openTime(true);
    await shot(`${tag}-${look}-time`);
    await openTime(false);
  }
  // a tick label among the city's bunched exits, as hover shows it (touch on the phone)
  const box = await page.locator('#drivebar .track').boundingBox();
  const flamingo = await page.evaluate(() => 61249.4 / 68352);
  await page.mouse.move(box.x + box.width * flamingo, box.y + box.height / 2);
  await shot(`${tag}-tick`);
  await page.mouse.move(5, h / 2);
  if (tag === 'phone') {
    await page.click('.route-card .more');
    await shot(`${tag}-card-open`);
    await page.click('.route-card .more');
  }
}
// the hint, the end of the route and the loading line
await page.setViewportSize({ width: 1280, height: 720 });
await page.evaluate(() => { document.getElementById('hint').hidden = false; });
await at(68352, NIGHT);
await shot('desk-arrived-hint');
await browser.close();
