// Screenshots of the drive from the cabin on the GPU (the copy of drive-shots.mjs with the cabin's options).
// Serve the repo first:   pnpm exec vite --port 5281 --strictPort
// then: node tests/manual/cabin-shots.mjs <out-dir> <port> '<shots>' [width] [height] [route]   (keep the out dir outside the repo;
//   route defaults to i15n)
// <shots> is JSON: [[name, s in metres, "day" | "night" | ISO time, { view, yaw, pitch, lens, reduceMotion, glance,
//   veil, mirrors, clip }?], ...]
//   view 'cabin' (default) or 'clean'; lens defaults to the view's own (28 mm cabin, 50 mm clean); glance
//   'left' | 'right' | 'center' | 'ahead' is shot at its hold, 0.6 s after the key; veil / mirrors false switch the
//   windshield layer / the mirror passes off (D4.3, D4.4); clip 'left' | 'right' | 'center' saves only that mirror's
//   face (with a margin), as drawn
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5281;
const shots = JSON.parse(process.argv[4]);
const width = +(process.argv[5] || 1280), height = +(process.argv[6] || 720);
const route = process.argv[7] || 'i15n';
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
  await page.evaluate(async (route) => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start(route, {}); s.drive.pause(); }, route);
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
  await page.screenshot({ path: `${out}/${name}.png`, ...(info?.clip ? { clip: info.clip } : {}) });
  console.log('shot', name, JSON.stringify({ ...info, clip: undefined }));
}
await browser.close();

async function shoot(s, when, opt) {
  const t = when === 'night' ? NIGHT : when === 'day' ? DAY : Date.parse(when);
  return page.evaluate(async ({ s, t, opt }) => {
    const d = window.__skyline.drive;
    d.pause();
    d.setView(opt.view || 'cabin');
    d.setReduceMotion(!!opt.reduceMotion);
    const g = d.cabin()?.glass;
    g?.windshield?.setEnabled(opt.veil !== false);
    g?.mirrors?.setEnabled(opt.mirrors !== false);
    d.seek({ s, t });
    const look = { yaw: 0, pitch: 0, ...opt };
    d.look({ yaw: look.yaw, pitch: look.pitch, lens: look.lens || (opt.view === 'clean' ? 50 : 28) });
    await d.whenSettled();
    if (opt.glance) { d.glance(opt.glance); await new Promise((r) => setTimeout(r, 600)); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose(); const c = d.cabin();
    let clip = null;
    if (opt.clip && c) {
      // the mirror face's corners on screen, through the cabin camera
      const m = c.mirrors[opt.clip], cam = c.cabinCamera;
      const xs = [], ys = [];
      for (const k of ['bottomLeft', 'bottomRight', 'topRight', 'topLeft']) {
        const q = m.corners[k].clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
        xs.push(((q.x + 1) / 2) * innerWidth); ys.push(((1 - q.y) / 2) * innerHeight);
      }
      const pad = 12, x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
      clip = { x: x0, y: y0, width: Math.min(innerWidth, Math.max(...xs) + pad) - x0, height: Math.min(innerHeight, Math.max(...ys) + pad) - y0 };
      if (!(clip.width > 1 && clip.height > 1)) clip = null; // the face is off the screen: the whole frame is saved
    }
    const st = c?.stats();
    return {
      s: Math.round(p.s), night: p.night, sunEl: +p.sunElevation.toFixed(2), iso: p.iso, view: p.view, lens: p.lens, model: c?.model,
      mirrors: st?.mirrors && { renders: st.mirrors.renders, pixels: st.mirrors.pixels, calls: st.mirrors.calls },
      veil: st?.windshield && { S: st.windshield.scenePerLux, sunLux: Math.round(st.windshield.sunLux), lit: st.windshield.lit, lamps: st.windshield.lamps },
      clip,
    };
  }, { s, t, opt });
}
