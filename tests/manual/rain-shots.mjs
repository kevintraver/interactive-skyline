// Frames of the drive's weather (plan 02, D8.1 to D8.3) in the shipped look, read from the canvas (a page screenshot does
// not hold a WebGPU canvas). The quality level is pinned (High).
// Clean camera. Each shot: [name, s (metres on the route), 'day' | 'dusk' | 'night' | ISO time, options?] with options
// { rain: preset or mm/h (absent: clear), parts: 'weather' (default) | 'lamps,weather' | ..., route, yaw, pitch, lens,
// sky: mm/h for the Rain slider of plan 01's #sky (see below) }.
// `sky` moves plan 01's Rain slider while driving: through the #sky popover's own slider when its button can be reached
// in the drive, else through the app's hook (window.__skyline.weather.setOverride('rain', v)), and the line says which.
// No weather service is reached (the hosts do not resolve; /api/weather answers 503).
// Serve the repository (pnpm exec vite --port 5324 --strictPort), then:
//   node tests/manual/rain-shots.mjs <out-dir outside the repo> '<shots JSON>' [--port 5324] [--backend webgpu]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const [out, shotsJson] = args;
const port = Number(opt('port', 5324)), backend = opt('backend', 'webgpu');
const TIMES = { day: '2026-11-21T20:30:00Z', dusk: '2026-11-22T01:05:00Z', night: '2026-11-22T02:30:00Z' };
mkdirSync(out, { recursive: true });
const shots = JSON.parse(shotsJson);

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
  '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });
const pages = new Map();
async function pageFor(parts) {
  if (pages.has(parts)) return pages.get(parts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('[error]', m.text().slice(0, 300)); });
  await page.route(/\/api\/weather/, (r) => r.fulfill({ status: 503, body: '' }));
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend}&parts=${parts}`, { timeout: 600000 });
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 600000 });
  // the quality level pinned: a level change on the WebGPU backend breaks every later frame (plan 01's shadow map)
  await page.evaluate(async () => { const s = window.__skyline; s.quality?.set('high'); s.attractions?.freeze?.(20); await s.attractions?.ready; });
  pages.set(parts, page);
  return page;
}

for (const [name, s, when, o = {}] of shots) {
  const page = await pageFor(o.parts || 'weather');
  const t = Date.parse(TIMES[when] || when);
  // the #sky slider, by the popover when its button is there in the drive, else by the hook
  let via = null;
  const r = await page.evaluate(async ({ route, s, t, o }) => {
    const sk = window.__skyline, d = sk.drive;
    if (!d.active() || d.route()?.id !== route) await d.start(route, { s, t, view: 'clean' });
    d.pause(); d.setView('clean');
    let w = null;
    for (let i = 0; i < 300 && !w; i++) { sk.scene.traverse((x) => { if (x.userData?.weatherPart) w = x.userData.weatherPart; }); if (!w) await new Promise((res) => setTimeout(res, 100)); }
    if (o.rain !== undefined) { if (typeof o.rain === 'string') w.setPreset(o.rain); else w.setRain(o.rain); } else w.setPreset('clear');
    await w.whenApplied();
    d.seek({ s, t }); d.look({ yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, lens: o.lens ?? 35 });
    await d.whenSettled();
    const btn = document.getElementById('sky-toggle');
    return { skyButton: !!(btn && btn.offsetParent !== null && getComputedStyle(btn).visibility !== 'hidden') };
  }, { route: o.route || 'i15n', s, t, o });
  if (o.sky !== undefined) {
    if (r.skyButton) {
      await page.click('#sky-toggle');
      if (!(await page.isChecked('#sky-adjust'))) await page.click('#sky-adjust');
      const slider = page.locator('.sky-slider[data-key="rain"] input');
      await slider.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, o.sky);
      via = 'the #sky popover\'s Rain slider';
    } else {
      await page.evaluate((v) => window.__skyline.weather.setOverride('rain', v), o.sky);
      via = 'the app\'s hook (__skyline.weather.setOverride): #sky\'s button is hidden while driving';
    }
  }
  const got = await page.evaluate(async () => {
    const sk = window.__skyline, d = sk.drive;
    let w = null; sk.scene.traverse((x) => { if (x.userData?.weatherPart) w = x.userData.weatherPart; });
    const canvas = sk.renderer.domElement;
    // draw and read in one task; now and then (a busy GPU) the read gives an empty canvas: then again
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
    const st = w.stats();
    return { png: btoa(bin), stats: { preset: st.preset, mmH: st.precipMmPerHour, wetness: st.wetness, visibilityM: st.visibilityM, drops: st.drops, twinWet: st.twinWet, twins: st.twins, spray: st.spray },
      exposure: +sk.env.nodes.exposure.value.toExponential(3), sun: +sk.env.state.sun.altDeg.toFixed(1), overrides: sk.weather?.overrides ?? null };
  });
  writeFileSync(join(out, `${name}.png`), Buffer.from(got.png, 'base64'));
  console.log('shot', name, JSON.stringify({ ...got, png: undefined, sky: via }));
}
await browser.close();
