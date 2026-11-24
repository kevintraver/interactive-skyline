// Screenshots and the frame-budget probe of the valley's light ribbons (D6.6) on the GPU. Serve the repo first:
//   pnpm exec vite --port 5293 --strictPort
// then: node tests/manual/valley-shots.mjs <out-dir> <port> '<shots>'   (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, ISO time, { yaw, pitch, lens }?, { off?: true, both?: true, budget?: true, route? }?], ...]
//   off: the ribbons hidden; both: the shot twice, name-on and name-off; budget: also time 90 frames with
//   EXT_disjoint_timer_query_webgl2 with the ribbons shown and hidden (median ms) and report the part's JS per frame.
//   route: the route to drive (default i15n); gain: multiply the ribbons' brightness (a debugging aid, not a look).
// The clean view (no cabin). Prints the valley part's stats per shot.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5293;
const shots = JSON.parse(process.argv[4]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
let route = null;
for (const [name, s, iso, look, opt = {}] of shots) {
  const want = opt.route || 'i15n';
  if (want !== route) {
    route = want;
    await page.evaluate(async (r) => { const sk = window.__skyline; sk.attractions.freeze(20); await sk.attractions.ready; await sk.drive.start(r, {}); sk.drive.pause(); sk.drive.setView('clean'); }, route);
    await page.waitForFunction(() => window.__skyline.scene.getObjectByName('valley-ribbons')?.userData.part, null, { timeout: 60000 });
  }
  const variants = opt.both ? [['-on', true], ['-off', false]] : [['', !opt.off]];
  for (const [suffix, on] of variants) {
    const info = await page.evaluate(async ({ s, t, look, on, budget, gain }) => {
      const sk = window.__skyline, d = sk.drive;
      const part = sk.scene.getObjectByName('valley-ribbons').userData.part;
      d.pause();
      d.seek({ s, t });
      d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
      part.setEnabled(on);
      part.setGainScale(gain);
      await d.whenSettled();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await d.whenSettled();
      let gpu = null;
      if (budget) {
        const median = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b[b.length >> 1]; };
        part.setEnabled(true);
        const a = await sk.perf.renderFrames(90, 20);
        part.setEnabled(false);
        const b = await sk.perf.renderFrames(90, 20);
        const a2 = (part.setEnabled(true), await sk.perf.renderFrames(90, 20));
        part.setEnabled(false);
        const b2 = await sk.perf.renderFrames(90, 20);
        part.setEnabled(on);
        // the part's own JS, per frame: run its update and beforeRender many times
        const p = d.pose(), frame = { simMs: p.t, camera: sk.camera, viewport: { width: innerWidth, height: innerHeight }, pose: p };
        part.setEnabled(true);
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) { frame.simMs = p.t + i * 16; part.update(frame); part.beforeRender(frame); }
        const js = (performance.now() - t0) / 2000;
        part.setEnabled(on);
        gpu = { method: a.method, msOn: [median(a.ms), median(a2.ms)], msOff: [median(b.ms), median(b2.ms)], jsPerFrame: js };
      }
      const p = d.pose(), st = d.stats();
      return { s: Math.round(p.s), iso: p.iso, night: p.night, calls: st.render?.calls, triangles: st.render?.triangles, valley: part.stats(), gpu };
    }, { s, t: Date.parse(iso), look: look || {}, on, budget: !!opt.budget && on, gain: opt.gain || 1 });
    await page.screenshot({ path: `${out}/${name}${suffix}.png` });
    const v = info.valley;
    console.log('shot', `${name}${suffix}`, JSON.stringify({ s: info.s, iso: info.iso, night: info.night, calls: info.calls, triangles: info.triangles, visible: v.visible, fade: +v.fade.toFixed(3), how: v.how, ribbons: v.ribbons }));
    if (info.gpu) console.log('budget', name, JSON.stringify(info.gpu));
  }
}
await browser.close();
