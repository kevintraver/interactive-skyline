// A probe of the wet road by day (rain-shots.mjs's setup): road crops dry, wet, wet without the sky's sheen and wet
// with the wet term off, to check that the term darkens and the sheen is what lightens. Serve on 5303, then:
//   node tests/manual/rain-probe.mjs <out-dir>
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.routeWebSocket(/.*/, () => {});
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${process.argv[3] || 5303}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); });
await page.waitForFunction(() => { let w = null; window.__skyline.scene.traverse((o) => { if (o.userData?.weatherPart) w = 1; }); return w; }, null, { timeout: 60000 });
const set = async (rain, gloss, wetx) => page.evaluate(async ({ rain, gloss, wetx }) => {
  const s = window.__skyline, d = s.drive; let w; s.scene.traverse((o) => { if (o.userData?.weatherPart) w = o.userData.weatherPart; });
  d.setView('clean'); w.setRain(rain); d.seek({ s: 44200, t: Date.parse('2026-11-21T20:30:00Z') }); d.look({ yaw: 0, pitch: 0, lens: 50 });
  await d.whenSettled();
  if (gloss != null) w.wetUniforms.uWetRoad.value.w = gloss;
  if (wetx != null) { w.wetUniforms.uWetRoad.value.x = wetx; }
  s.invalidate?.();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { fog: s.scene.fog.color.toArray(), sky: w.wetUniforms.uWetSky.value.toArray() };
}, { rain, gloss, wetx });
page.on('pageerror', (e) => console.log('[pageerror]', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log(m.text().slice(0, 300)); });
for (const [n, r, g, x] of [['dry', 0], ['rain', 4], ['rain-nogloss', 4, 0], ['rain-noterm', 4, null, 0]]) {
  console.log(n, JSON.stringify(await set(r, g, x)));
  await page.screenshot({ path: `${process.argv[2]}/${n}.png`, clip: { x: 300, y: 450, width: 700, height: 150 } });
}
await browser.close();
