// GPU and JavaScript cost of the weather part (plan 02, phase 8: under about 1 ms GPU and 0.3 ms JS a frame in heavy
// rain at km 60 at night; nothing measurable dry). Serve the repo (pnpm exec vite --port 5303 --strictPort), then:
//   node tests/manual/rain-budget.mjs <port> [mm/h]
// Clean view, 1280 x 720. GPU: whole world frames timed with EXT_disjoint_timer_query_webgl2 (perf.renderFrames),
// medians, with everything the weather adds shown and then hidden (rain, spray, twins; the wet term's wetness to 0),
// and dry against the rain preset's sky alone. JS: the part's own update + beforeRender while the drive plays.
import { chromium } from '@playwright/test';
const port = process.argv[2] || 5303, rate = +(process.argv[3] || 12);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.routeWebSocket(/.*/, () => {});
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); s.drive.setView('clean'); });
await page.waitForFunction(() => { let w = null; window.__skyline.scene.traverse((o) => { if (o.userData?.weatherPart) w = 1; }); return w; }, null, { timeout: 60000 });
const r = await page.evaluate(async (rate) => {
  const sk = window.__skyline, d = sk.drive;
  let w = null; sk.scene.traverse((o) => { if (o.userData?.weatherPart) w = o.userData.weatherPart; });
  const median = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return +b[b.length >> 1].toFixed(3); };
  const time = async () => median((await sk.perf.renderFrames(90, 20)).ms);
  const frame = async () => { await d.whenSettled(); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); };
  const at = { s: 60000, t: Date.parse('2026-11-22T02:30:00Z') };
  w.setRain(0); d.seek(at); await frame();
  const dry = await time();
  w.setRain(rate); d.seek(at); await frame();
  const wet = await time();
  const added = [];
  sk.scene.traverse((o) => { if ((o.name === 'rain' || o.name === 'spray' || o.name.endsWith('-twins')) && o.visible) added.push(o); });
  const u = w.wetUniforms, wx = u.uWetRoad.value.x;
  for (const o of added) o.visible = false;
  u.uWetRoad.value.x = 0; u.uWetGround.value.x = 0;
  const hidden = await time();
  const split = {};
  for (const o of added) { o.visible = true; split[o.name] = +((await time()) - hidden).toFixed(3); o.visible = false; }
  for (const o of added) o.visible = true;
  u.uWetRoad.value.x = wx; u.uWetGround.value.x = wx;
  // JS while playing (the rolling window then holds only these frames)
  d.play(); await new Promise((res) => setTimeout(res, 6000)); d.pause();
  const st = w.stats();
  w.setRain(0); d.seek(at); d.play(); await new Promise((res) => setTimeout(res, 6000)); d.pause();
  const stDry = w.stats();
  return { rate, gpu: { dry, wet, weatherHidden: hidden, added: +(wet - hidden).toFixed(3), split }, jsWet: st.js, jsDry: stDry.js, stats: { ...st, js: undefined } };
}, rate);
console.log(JSON.stringify(r));
await browser.close();
