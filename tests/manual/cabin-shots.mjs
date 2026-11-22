// Screenshots of the drive from the cabin on the GPU (the copy of drive-shots.mjs with the cabin's options).
// Serve the repo first:   pnpm exec vite --port 5281 --strictPort
// then: node tests/manual/cabin-shots.mjs <out-dir> <port> '<shots>' [width] [height]   (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, "day" | "night", { view, yaw, pitch, lens, reduceMotion, glance }?], ...]
//   view 'cabin' (default) or 'clean'; lens defaults to the view's own (28 mm cabin, 50 mm clean); glance
//   'left' | 'right' | 'center' | 'ahead' is shot at its hold, 0.6 s after the key
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5281;
const shots = JSON.parse(process.argv[4]);
const width = +(process.argv[5] || 1280), height = +(process.argv[6] || 720);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width, height } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// a dev server reloads the page whenever any source changes (other work in the same checkout): answer its hot-update
// socket with a silent stand-in, so the page stays as it loaded
await page.routeWebSocket(/.*/, () => {});
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
// open the app and start the drive; again after a reload (a dev server reloads the page when a source changes)
async function setup() {
  await page.goto(`http://localhost:${port}/?city=lv`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
  const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  console.log('renderer:', gl);
  await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); });
  // wait for the cabin part (it loads after the drive starts)
  await page.waitForFunction(() => window.__skyline.drive.cabin(), null, { timeout: 60000 }).catch(() => console.log('no cabin part'));
}
await setup();
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
for (const [name, s, when, opt = {}] of shots) {
  let info = null;
  for (let attempt = 0; attempt < 3 && !info; attempt++) {
    try { info = await shoot(s, when, opt); } catch (e) { console.log('retrying', name, e.message.split('\n')[0]); await setup(); }
  }
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, JSON.stringify(info));
}
await browser.close();

async function shoot(s, when, opt) {
  return page.evaluate(async ({ s, t, opt }) => {
    const d = window.__skyline.drive;
    d.pause();
    d.setView(opt.view || 'cabin');
    d.setReduceMotion(!!opt.reduceMotion);
    d.seek({ s, t });
    const look = { yaw: 0, pitch: 0, ...opt };
    d.look({ yaw: look.yaw, pitch: look.pitch, ...(look.lens ? { lens: look.lens } : {}) });
    await d.whenSettled();
    if (opt.glance) { d.glance(opt.glance); await new Promise((r) => setTimeout(r, 600)); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose(); const c = d.cabin();
    return { s: Math.round(p.s), night: p.night, view: p.view, lens: p.lens, model: c?.model, readout: c?.readout && { speed: c.readout.speed, clock: c.readout.clock, next: c.readout.next } };
  }, { s, t: when === 'night' ? NIGHT : DAY, opt });
}
