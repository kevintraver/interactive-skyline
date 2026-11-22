// Screenshots of the drive through dusk on the GPU, by sun elevation (src/drive/look.js blends the look by it).
// Serve the repo first:  pnpm exec vite --port 5282 --strictPort
// then:  node tests/manual/dusk-shots.mjs <out-dir> <port> [<shots> | 'set'] [<day ISO>]
// <shots> is JSON: [[name, km, sun elevation in degrees, { yaw, pitch, lens }?], ...]; the time for each is found
// with the ephemeris (timeOfSunElevation, evening crossing) on the day given (default today). 'set' (the default)
// is the review set: km 44.2 and km 60 at +20 +6 +2 0 -2 -4 -6 -9 -18 and eight equal steps from 0 to -6, plus
// the default moment (sun -3 at the reveal). Keep the out dir outside the repo.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.argv[2]; const port = process.argv[3] || 5282;
const arg = process.argv[4] || 'set';
const day = process.argv[5] ? Date.parse(process.argv[5]) : Date.now();
let shots;
if (arg === 'set') {
  const els = [20, 6, 2, 0, -2, -3, -4, -6, -9, -18];
  const strip = Array.from({ length: 8 }, (_, i) => -(6 * i) / 7);
  const tag = (el) => (el >= 0 ? `p${el.toFixed(2)}` : `m${(-el).toFixed(2)}`);
  shots = [];
  for (const [place, km] of [['reveal', 44.2], ['city', 60]]) {
    for (const el of els) shots.push([`${place}-${tag(el)}`, km, el]);
    strip.forEach((el, i) => shots.push([`${place}-strip${i}-${tag(el)}`, km, el]));
  }
} else shots = JSON.parse(arg);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
const ready = () => page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.goto(`http://localhost:${port}/?city=lv`);
await ready();
// the dev server reloads the page when a source file changes; start again after a reload
const run = async (fn, arg) => {
  for (let k = 0; ; k++) {
    try { return await page.evaluate(fn, arg); } catch (e) { if (k > 8 || !/context was destroyed/.test(e.message)) throw e; await ready(); }
  }
};
const hideCards = () => page.addStyleTag({ content: '.routes { display: none !important; }' });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
// the default moment first, as the drive opens
const def = await run(async () => {
  const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready;
  await s.drive.start('i15n', {}); s.drive.pause();
  await s.drive.whenSettled();
  const p = s.drive.pose();
  return { km: p.km, sun: p.sunElevation, iso: p.iso, night: p.night };
});
// the route cards cover the lower left of the view; the frames are for judging the scene
await hideCards();
await page.screenshot({ path: `${out}/default.png` });
console.log('shot default', JSON.stringify(def));
const log = [{ name: 'default', ...def }];
for (const [name, km, elevation, look] of shots) {
  const info = await run(async ({ km, elevation, day, look }) => {
    const { createEphemeris } = await import('/src/drive/env.js');
    const cities = await (await fetch('/data/cities.json')).json();
    const t = createEphemeris(cities.lv || cities.find?.((c) => c.id === 'lv')).timeOfSunElevation(elevation, day, true);
    const d = window.__skyline.drive;
    if (!d.active()) { window.__skyline.attractions.freeze(20); await window.__skyline.attractions.ready; await d.start('i15n', {}); }
    d.pause(); d.seek({ s: km * 1000, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
    await d.whenSettled();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose();
    return { km: +p.km.toFixed(2), sun: +p.sunElevation.toFixed(2), iso: p.iso, night: p.night };
  }, { km, elevation, day, look: look || {} });
  if (!(await page.evaluate(() => [...document.styleSheets].some((x) => [...(x.cssRules || [])].some((r) => r.cssText.includes('.routes')  && r.cssText.includes('none')))))) await hideCards();
  await page.screenshot({ path: `${out}/${name}.png` });
  log.push({ name, ...info });
  console.log('shot', name, JSON.stringify(info));
}
writeFileSync(`${out}/shots.json`, JSON.stringify(log, null, 1));
await browser.close();
