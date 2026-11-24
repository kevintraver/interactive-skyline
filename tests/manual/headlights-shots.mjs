// GPU screenshots of the visitor's headlamps and what signs and markings return (plan 02, D5.1, D5.2), from
// drive-shots.mjs with more options. Serve the repo first:  pnpm exec vite --port 5291 --strictPort
// then: node tests/manual/headlights-shots.mjs <out-dir> <port> '<shots>' [--perf] [--route i15n]
// <shots> is JSON: [[name, s in metres, when, { yaw, pitch, lens, high, headlights, lamps }?], ...]
//   when: "day", "night", or { "sun": elevation in degrees } (the evening's time at that elevation)
//   high: true for high beam; headlights: false switches the part off; lamps: false switches the street lamps off;
//   traffic: false hides the traffic (to see a sign the trucks would hide)
// Always the clean view. --perf: for each shot also measure frames with the part on and off (GPU time by finish()),
// and print the part's per-frame JavaScript while the car drives for 6 s.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createEphemeris } from '../../src/drive/env.js';

const out = process.argv[2]; const port = process.argv[3] || 5291;
const shots = JSON.parse(process.argv[4]);
const perf = process.argv.includes('--perf');
const route = process.argv.includes('--route') ? process.argv[process.argv.indexOf('--route') + 1] : 'i15n';
mkdirSync(out, { recursive: true });
const cities = JSON.parse(readFileSync(new URL('../../data/cities.json', import.meta.url)));
const city = Array.isArray(cities) ? cities.find((c) => c.id === 'lv') : cities.lv;
const eph = createEphemeris(city);
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
const timeOf = (when) => (when === 'day' ? DAY : when === 'night' ? NIGHT : eph.timeOfSunElevation(when.sun, DAY, true));

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.routeWebSocket(/./, () => {}); // other work in the checkout makes Vite reload the page: keep its socket silent
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
await page.evaluate(async (route) => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start(route, { view: 'clean' }); s.drive.pause(); try { s.drive.setView('clean'); } catch {} }, route);
// only the scene: every element that neither is nor holds the canvas is hidden (--ui keeps the interface)
if (!process.argv.includes('--ui')) {
  await page.evaluate(() => {
    const c = window.__skyline.renderer.domElement;
    for (const el of document.body.querySelectorAll('*')) if (el !== c && !el.contains(c) && !(el instanceof SVGElement)) el.style.visibility = 'hidden';
  });
}
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('drive')?.userData.headlightsPart, null, { timeout: 60000 }).catch(() => console.log('no headlights part'));

for (const [name, s, when, look] of shots) {
  const { high = false, headlights = true, lamps = true, traffic = true, ...lk } = look || {};
  const info = await page.evaluate(async ({ s, t, look, high, headlights, lamps, traffic }) => {
    const sk = window.__skyline, d = sk.drive;
    const part = sk.scene.getObjectByName('drive')?.userData.headlightsPart;
    part?.setHigh(high); part?.setEnabled(headlights);
    sk.scene.getObjectByName('lamp-sprites')?.userData.lampsPart?.setEnabled(lamps);
    const tg = sk.scene.getObjectByName('drive')?.getObjectByName('traffic');
    if (tg) tg.visible = traffic;
    d.pause(); d.seek({ s, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
    await d.whenSettled();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose(); const st = d.stats();
    return { s: Math.round(p.s), sun: +p.sunElevation.toFixed(2), calls: st?.render?.calls, headlights: st?.headlights };
  }, { s, t: timeOf(when), look: lk, high, headlights, lamps, traffic });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, JSON.stringify(info));
  if (perf) {
    // GPU time of the scene's draw by timer queries, the part on and off interleaved draw by draw (the uniform
    // switch needs no recompile), back to back so the GPU's clocks stay up; medians of each
    const r = await page.evaluate(async () => {
      const sk = window.__skyline, d = sk.drive, g = sk.renderer.getContext();
      const part = sk.scene.getObjectByName('drive')?.userData.headlightsPart;
      const ext = g.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext || !part) return 'no timer query extension or no part';
      await d.whenSettled();
      const q = { true: [], false: [] };
      for (let i = 0; i < 400; i++) {
        const on = i % 2 === 0;
        part.setEnabled(on);
        const qq = g.createQuery();
        g.beginQuery(ext.TIME_ELAPSED_EXT, qq);
        sk.renderer.render(sk.scene, sk.camera);
        g.endQuery(ext.TIME_ELAPSED_EXT);
        q[on].push(qq);
        if (i % 20 === 19) await new Promise((res) => setTimeout(res, 0));
      }
      part.setEnabled(true);
      await new Promise((res) => setTimeout(res, 500));
      const read = (list) => list.slice(10).map((x) => (g.getQueryParameter(x, g.QUERY_RESULT_AVAILABLE) ? g.getQueryParameter(x, g.QUERY_RESULT) / 1e6 : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
      const a = read(q.true), b = read(q.false), med = (x) => +x[x.length >> 1].toFixed(3);
      return { n: [a.length, b.length], onP50: med(a), offP50: med(b), deltaP50: +(med(a) - med(b)).toFixed(3), calls: d.stats().render.calls };
    });
    console.log('  gpu', JSON.stringify(r));
    const drive = await page.evaluate(async () => {
      const sk = window.__skyline, d = sk.drive;
      sk.scene.getObjectByName('drive')?.userData.headlightsPart?.setEnabled(true);
      const p0 = d.pose();
      d.play();
      await new Promise((r) => setTimeout(r, 6000));
      d.pause();
      const st = d.stats();
      d.seek({ s: p0.s, t: p0.t });
      return st.headlights?.js;
    });
    console.log('  driving js', JSON.stringify(drive));
  }
}
await browser.close();
