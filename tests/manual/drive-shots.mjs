// Frames of the drive on this machine's GPU, for looking at (about a second a frame), in the shipped look: the canvas
// read back in the task that draws it (a page screenshot does not hold a WebGPU canvas). The clock is paused, the
// attractions' clocks frozen and the quality level pinned (a level change on the WebGPU backend breaks every later
// frame: plan 01's shadow map is destroyed while bound), so the same shot gives the same pixels.
// Serve the repo first, as source or as the production build:
//   pnpm exec vite --port 5212 --strictPort        or   pnpm build && pnpm preview --port 5212 --strictPort
// then:
//   node tests/manual/drive-shots.mjs <out-dir outside the repo> '<shots>' [--port 5212] [--backend webgpu|webgl]
//        [--parts a,b] [--quality high]
// <shots> is JSON: [[name, route, s in metres, "day" | "dusk" | "night" | ISO time, { view, yaw, pitch, lens, rain }?], ...]
//   view 'cabin' or 'clean' (default clean); lens in mm (default 35); rain a preset ('light', 'moderate', 'heavy') or
//   a rate in mm/h (default clear). Each frame goes to <out-dir>/<name>.png, with a line of what the drive reports.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [out, shotsArg] = args;
if (!out || !shotsArg) { console.error("usage: drive-shots.mjs <out-dir> '<shots JSON>' [--port 5212] [--backend webgpu|webgl] [--parts a,b] [--quality high]"); process.exit(2); }
const shots = JSON.parse(shotsArg);
const port = opt('port', '5212'), backend = opt('backend', 'webgpu'), parts = opt('parts', null), level = opt('quality', 'high');
const TIMES = { day: '2026-11-21T20:30:00Z', dusk: '2026-11-22T00:50:00Z', night: '2026-11-22T07:30:00Z' };
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    // no weather service is reached: the drive's rain shorthand works on plan 01's offline presets
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('[error]', m.text().slice(0, 300)); });
await page.route(/\/api\/weather/, (r) => r.fulfill({ status: 503, body: '' }));
await page.routeWebSocket(/.*/, () => {}); // other work in the checkout makes Vite reload the page: keep its socket silent
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/?city=lv&backend=${backend}${parts ? `&parts=${parts}` : ''}`, { timeout: 600000 });
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive && window.__skyline?.attractions, null, { timeout: 600000 });
await page.evaluate(async (l) => { const s = window.__skyline; s.quality?.set(l); s.attractions.freeze(20); await s.attractions.ready; }, level);
console.log('renderer', JSON.stringify(await page.evaluate(() => ({ ...window.__skyline.rendererInfo, quality: window.__skyline.quality?.level }))));

for (const [name, route, s, when, o = {}] of shots) {
  const t = Date.parse(TIMES[when] || when);
  const r = await page.evaluate(async ({ route, s, t, o }) => {
    const sk = window.__skyline, d = sk.drive;
    const view = o.view || 'clean';
    if (!d.active() || d.route()?.id !== route) await d.start(route, { s, t, view });
    d.pause();
    let w = null; // the weather part, when it is loaded
    sk.scene.traverse((x) => { if (x.userData?.weatherPart) w = x.userData.weatherPart; });
    if (w) {
      if (typeof o.rain === 'string') w.setPreset(o.rain); else if (Number.isFinite(o.rain)) w.setRain(o.rain); else w.setPreset('clear');
      await w.whenApplied();
    }
    d.setView(view);
    d.seek({ s, t });
    d.look({ yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, lens: o.lens ?? 35 });
    await d.whenSettled();
    for (let i = 0; i < 6; i++) await new Promise((res) => requestAnimationFrame(res));
    await d.whenSettled();
    // draw and read in one task; now and then (a busy GPU) the read gives an empty canvas: then again
    const canvas = sk.renderer.domElement;
    let blob = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      for (let i = 0; i < 4; i++) await new Promise((res) => requestAnimationFrame(res));
      d.renderFrame();
      blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let any = false;
      for (let i = 3; i < px.length; i += 4 * 997) if (px[i]) { any = true; break; }
      if (any) break;
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const p = d.pose(), st = d.stats();
    return { png: btoa(bin), info: { s: Math.round(p.s), view: p.view, night: p.night, sun: +p.sunElevation.toFixed(2), calls: st?.render?.calls, parts: Object.keys(st || {}).filter((k) => !['render', 'signs', 'js', 'renderScale', 'active'].includes(k)) } };
  }, { route, s, t, o });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.png, 'base64'));
  console.log('shot', name, JSON.stringify(r.info));
}
await browser.close();
