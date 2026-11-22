// Screenshots of the real drive on the GPU, for looking at frames (the e2e goldens use the slow software
// renderer; this takes about a second a frame). Serve the repo first, as source or as the production build:
//   pnpm exec vite --port 5212 --strictPort        or   pnpm build && pnpm preview --port 5212 --strictPort
// then: node tests/manual/drive-shots.mjs <out-dir> <port> '<shots>'   (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, "day" | "night", { yaw, pitch, lens }?], ...]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5212;
const shots = JSON.parse(process.argv[4]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); });
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
for (const [name, s, when, look] of shots) {
  const info = await page.evaluate(async ({ s, t, look }) => {
    const d = window.__skyline.drive;
    d.pause(); d.seek({ s, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
    await d.whenSettled();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose(); const st = d.stats();
    return { s: Math.round(p.s), night: p.night, calls: st?.calls ?? st?.drawCalls };
  }, { s, t: when === 'night' ? NIGHT : DAY, look: look || {} });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, JSON.stringify(info));
}
await browser.close();
